// Shared by the Drift Guard hooks: workspace rules and memory, cached briefly so edits stay fast.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
let SESSION = null;
export function input() {
  let inp = {}; try { inp = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* empty */ }
  if (inp.session_id) SESSION = createHash("sha256").update(String(inp.session_id)).digest("hex").slice(0, 16);
  return inp;
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
    if (kind === "avoid") return { id: `file:${i}`, kind, pattern: v, paths: it.in || null, except, text: say || `Don't add code matching ${v}.` };
    if (kind === "protect") return { id: `file:${i}`, kind, paths: v, except, text: say || `Don't edit ${v}.` };
    if (kind === "deps") return { id: `file:${i}`, kind, except, text: say || "Don't add new dependencies without asking." };
    return { id: `file:${i}`, kind, text: say };
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

export async function report(body) {
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
    const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp(`^${re}$`).test(path);
  });
}
