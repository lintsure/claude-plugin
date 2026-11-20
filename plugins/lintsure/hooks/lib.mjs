// Shared by the Drift Guard hooks: workspace rules and memory, cached briefly so edits stay fast.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

export const API = (process.env.LINTSURE_URL || "https://lintsure.com").replace(/\/$/, "");
export const KEY = process.env.LINTSURE_API_KEY || "";
const H = () => ({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
const dir = join(tmpdir(), "lintsure-drift");
const tag = createHash("sha256").update(KEY).digest("hex").slice(0, 12);

export const quiet = () => process.exit(0);
export const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
// Reports carry a short hash of the session id (never the id itself), so the workspace can group one session's events.
let SESSION = null, CWD = null;
export function input() {
  let inp = {}; try { inp = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* empty */ }
  if (inp.cwd) CWD = inp.cwd;
  if (inp.session_id) SESSION = createHash("sha256").update(String(inp.session_id)).digest("hex").slice(0, 16);
  if ((process.env.LINTSURE_RECORD || "") === "1") record(inp);
  return inp;
}

// Replay recorder (opt-in, LINTSURE_RECORD=1): saves what a hook was given so a person can label it and the replay
// benchmark (scripts/replay.mjs) can run it against later guard versions. Paths become repo-relative, the session id
// and transcript path are dropped, and anything that looks like a key or token is masked. Stays in .lintsure/replay/.
const KEYLIKE = /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|npm|AKIA)[-_A-Za-z0-9]{10,}|\beyJ[\w-]{15,}\.[\w-]{10,}\.[\w-]{5,}/g;
export function normalizeForReplay(inp) {
  const root = String(inp.cwd || "").replace(/\\/g, "/");
  const walk = (v) => typeof v === "string" ? (root ? v.replace(/\\/g, "/").split(root + "/").join("") : v).replace(KEYLIKE, "[secret]").slice(0, 20000)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  const { session_id, transcript_path, cwd, ...rest } = inp;
  return walk(rest);
}
function record(inp) {
  try {
    const d = join(inp.cwd || process.cwd(), ".lintsure", "replay");
    mkdirSync(d, { recursive: true });
    appendFileSync(join(d, "inbox.jsonl"), JSON.stringify({ hook: basename(process.argv[1] || ""), input: normalizeForReplay(inp), expect: null }) + "\n");
  } catch { /* fine */ }
}
export const off = () => (process.env.LINTSURE_HOOK || "").toLowerCase() === "off" || (process.env.LINTSURE_DRIFT || "").toLowerCase() === "off";

/** Per-session state (what was already flagged), kept in the temp folder. */
export function state(session) {
  const f = join(dir, `${tag}-${String(session || "x").replace(/[^\w-]/g, "")}.json`);
  let s = {}; try { s = JSON.parse(readFileSync(f, "utf8")); } catch { /* new session */ }
  return { s, save: () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(f, JSON.stringify(s)); } catch { /* fine */ } } };
}

/** Which project this folder is: its folder name, and its git remote as owner/repo when there is one. */
export function project(root) {
  let repo = "";
  try { repo = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim().replace(/\.git$/, "").replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1"); } catch { /* no remote */ }
  return { name: basename(root), repo };
}

/** Rules from .lintsure/rules.yml in the repo. A small YAML subset: a "rules:" list of items with one kind key
 *  (avoid, protect, deps, note) plus optional "say" and "in". Anything it can't read is skipped, never fatal. */
export function fileRules(root) {
  let src; try { src = readFileSync(join(root, ".lintsure", "rules.yml"), "utf8"); } catch { return []; }
  const val = (v) => { v = v.trim(); if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } } if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'"); return v.replace(/\s+#.*$/, ""); };
  const items = []; let inRules = false, cur = null;
  for (const raw of src.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const top = raw.match(/^mode:\s*(quiet|guide|strict)\b/i);
    if (top) { items.mode = top[1].toLowerCase(); continue; }
    if (/^\S/.test(raw)) { inRules = /^rules:\s*$/.test(raw); cur = null; continue; }
    if (!inRules) continue;
    const m = raw.match(/^\s*(-\s+)?([a-z]+):\s*(.*)$/i);
    if (!m) continue;
    if (m[1]) { cur = {}; items.push(cur); }
    if (cur) cur[m[2].toLowerCase()] = val(m[3]);
  }
  const out = items.map((it, i) => {
    const kind = ["avoid", "protect", "deps", "note"].find((k) => k in it);
    if (!kind) return null;
    const v = it[kind], say = it.say || (kind === "note" ? v : ""), except = it.except || null;
    if (kind === "avoid") return { id: `file:${i}`, kind, pattern: v, paths: it.when || it.in || null, except, text: say || `Don't add code matching ${v}.` };
    if (kind === "protect") return { id: `file:${i}`, kind, paths: v, except, text: say || `Don't edit ${v}.` };
    if (kind === "deps") return { id: `file:${i}`, kind, except, text: say || "Don't add new dependencies without asking." };
    // A note with "when:" (or "in:") globs applies only to those files: it's shown when the agent edits one, not in Memory.
    return { id: `file:${i}`, kind, paths: it.when || it.in || null, text: say };
  }).filter((r) => r && r.text);
  out.mode = items.mode;
  return out;
}

/** Rules and memory from the workspace, plus the repo's own rules file. Cached for 60 seconds; a stale copy is used
 *  when the workspace can't be reached, and the file rules work with no workspace at all. */
export async function rules(root, fresh = false) {
  const p = project(root), local = fileRules(root);
  const ws = KEY ? await wsRules(p, fresh) : null;
  // The repo's own mode wins, then the workspace setting, then Guide.
  const mode = local.mode || ws?.mode || "guide";
  // Workspace exceptions (one-offs the user agreed to) join the rule's own "except:" paths.
  const all = [...local, ...(ws?.rules || [])].map((r) => {
    const ex = (ws?.exceptions || []).filter((x) => x.rule_id && x.rule_id === r.id).map((x) => x.item);
    return ex.length ? { ...r, except: [r.except, ...ex].filter(Boolean).join(",") } : r;
  });
  return { rules: all, exceptions: ws?.exceptions || [], memory: ws?.memory || null, project: p, mode };
}
/** Workspace rules for a project (needs LINTSURE_API_KEY), cached for 60 seconds. Exported for the end-of-task scan. */
export async function wsRules(p, fresh) {
  const f = join(dir, `${tag}-rules-${`${p.name}-${p.repo}`.replace(/[^\w-]/g, "")}.json`);
  let cached = null; try { cached = JSON.parse(readFileSync(f, "utf8")); } catch { /* none */ }
  if (cached && !fresh && Date.now() - cached.at < 60_000) return cached.data;
  try {
    const r = await fetch(`${API}/api/v1/rules?target=${encodeURIComponent(p.name)}${p.repo ? `&repo=${encodeURIComponent(p.repo)}` : ""}`, { headers: H(), signal: AbortSignal.timeout(3000) });
    if (!r.ok) return cached?.data ?? null;
    const data = await r.json();
    try { mkdirSync(dir, { recursive: true }); writeFileSync(f, JSON.stringify({ at: Date.now(), data })); } catch { /* fine */ }
    return data;
  } catch { return cached?.data ?? null; }
}

// A file that says "lintsure:private" in its first lines is never named in the activity log or repeated by Memory.
const PRIVATE = /lintsure:private/;
export function isPrivate(root, rel) {
  if (!rel) return false;
  try { return PRIVATE.test(readFileSync(join(root, rel), "utf8").slice(0, 2000)); } catch { return false; }
}

/** Local activity log: one JSON line per catch, decision or scan in .lintsure/activity.jsonl, with or without an API key.
 *  Kind, rule, file, line and outcome only: never code, prompts, secrets or the reason text. Private files are left
 *  out. Rolled over at 1 MB (one previous file kept). LINTSURE_ACTIVITY=off turns it off. Never throws. */
export function activity(root, body) {
  if ((process.env.LINTSURE_ACTIVITY || "").toLowerCase() === "off") return 0;
  const at = new Date().toISOString(), rows = [];
  for (const e of body.events || []) {
    if (isPrivate(root, e.file)) continue;
    rows.push({ at, type: "catch", kind: e.kind, rule: e.ruleId, file: e.file, line: e.line, outcome: e.outcome || "caught", session: SESSION });
  }
  if (body.change) rows.push({ at, type: "decision", scope: body.change.scope, rule: body.change.ruleId, file: isPrivate(root, body.change.item) ? undefined : body.change.item, session: SESSION });
  if (body.scan) rows.push({ at, type: "scan", ...body.scan, session: SESSION });
  if (!rows.length) return 0;
  try {
    const d = join(root, ".lintsure"), f = join(d, "activity.jsonl");
    mkdirSync(d, { recursive: true });
    try { if (statSync(f).size > 1_000_000) renameSync(f, f + ".1"); } catch { /* new file */ }
    appendFileSync(f, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  } catch { /* read-only folder: fine */ }
  return rows.length;
}

export async function report(body) {
  activity(body.root || CWD || process.cwd(), body);
  if (!KEY) return [];
  try {
    const r = await fetch(`${API}/api/v1/drift`, { method: "POST", headers: H(), body: JSON.stringify({ ...body, session: SESSION }), signal: AbortSignal.timeout(3000) });
    return r.ok ? (await r.json()).ids || [] : [];
  } catch { return []; }
}

const normHex = (s) => String(s).toLowerCase().replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b(?![0-9a-f])/g, "#$1$1$2$2$3$3");
const LOOK = new Set(["off_brand", "duplicate"]);
/** Whether an agreed exception covers this finding. An exception is about one file (item) and one thing in it:
 *  a rule (rule_id) or a colour, font or component (value). One with neither covers only look-and-feel catches in that
 *  file, never protected files, rules, made-up code or packages. */
export function excepted(f, rel, exceptions) {
  return (exceptions || []).some((x) => {
    if (!x.item || !globMatch(rel, x.item)) return false;
    if (x.rule_id) return f.ruleId === x.rule_id;
    if (x.value) return LOOK.has(f.kind) && normHex(f.detail).includes(normHex(x.value));
    return LOOK.has(f.kind);
  });
}

/** Small glob: ** any path, * one segment, a bare folder name matches everything under it. */
export function globMatch(path, globs) {
  return String(globs || "").split(",").map((g) => g.trim().replace(/^\.\//, "")).filter(Boolean).some((g) => {
    if (!/[*?]/.test(g)) return path === g || path.startsWith(g.replace(/\/$/, "") + "/");
    // Runs of "**" and "*" collapse to one ".*", so a glob like **/**/** can't build a slow regex.
    const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/(?:\u0000|\[\^\/\]\*)*\u0000(?:\u0000|\[\^\/\]\*)*/g, "\u0000").replace(/\u0000/g, ".*");
    return new RegExp(`^${re}$`).test(path);
  });
}

// Rule patterns come from people and from repos (a cloned project's .lintsure/rules.yml), so a pattern is checked before
// it runs: a repeated group that repeats inside, like (a+)+ or (\w*)*, can take minutes on one line, so it's refused.
// Patterns stay under 500 characters and run on lines cut to 2,000, so even an unusual pattern finishes fast.
export const MAX_PATTERN = 500, MAX_LINE = 2000;
// A repeated group that repeats inside, (a+)+, or that offers overlapping choices, (a|aa)*: both can take exponential time,
// and cutting the line doesn't save an exponential pattern, so both shapes are refused. A character class, [ab]+, is fine.
const NESTED = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,\d*\}|\|)(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,)/;
/** A rule's pattern as a regex, or the reason it can't be used. Pure. */
export function safePattern(src, flags = "") {
  const p = String(src ?? "");
  if (!p) return { error: "The pattern is empty." };
  if (p.length > MAX_PATTERN) return { error: `The pattern is longer than ${MAX_PATTERN} characters.` };
  if (NESTED.test(p)) return { error: "The pattern repeats a group that repeats inside or offers choices, like (a+)+ or (a|b)*, which can take minutes on a single line. Write it without the repeated group, for example with a character class like [ab]+." };
  try { return { re: new RegExp(p, flags) }; } catch (e) { return { error: `The pattern isn't a valid regular expression: ${e.message}` }; }
}
/** The first match of `re` in `text`, line by line, each line cut to MAX_LINE. Pure. */
export function matchLines(re, text) {
  for (const line of String(text).split("\n")) { const m = line.slice(0, MAX_LINE).match(re); if (m) return m; }
  return null;
}
