#!/usr/bin/env node
// Lintsure Drift Guard (PreToolUse in strict mode, PostToolUse otherwise, on Edit, Write and MultiEdit). Reads .lintsure/rules.yml with no account; with LINTSURE_API_KEY it also uses the workspace rules and records catches.
// Checks the file the agent just edited, on this machine:
// - your rules from the workspace: code to avoid, files to protect, no new dependencies;
// - code that doesn't exist: relative imports to missing files, packages that aren't installed or declared.
// When something breaks, the agent is told the file, line and rule and asked to go back. Each problem is raised once.
// Only the rule, file, line and a one-line description go to the workspace, never code. Silent on any error.
// Turn it off with LINTSURE_DRIFT=off (or LINTSURE_HOOK=off for everything).
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, basename, resolve } from "node:path";
import { builtinModules } from "node:module";
import { quiet, say, input, off, state, rules, report, globMatch, excepted, safePattern, matchRules } from "./lib.mjs";
import { profileChecks, profile } from "./profile.mjs";
import { resolveFile, missingExports, duplicateFunctions, bandAids, testGuard, packageGuard, scopeGuard, secretGuard, privacyGuard } from "./code.mjs";

const JS = /\.(m?[jt]sx?|cjs|vue|svelte|astro)$/i;
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };

/** The text the agent just added. */
function added(t, ti) {
  if (t === "Write") return ti.content || "";
  if (t === "Edit") return ti.new_string || "";
  if (t === "MultiEdit") return (ti.edits || []).map((e) => e.new_string || "").join("\n");
  return "";
}
/** The text this edit replaced: old_string for edits, the last committed version for a Write (empty when new). */
function replaced(t, ti, root, rel, saved) {
  if (t === "Edit") return ti.old_string || "";
  if (t === "Write" && typeof saved === "string") return saved;
  if (t === "MultiEdit") return (ti.edits || []).map((e) => e.old_string || "").join("\n");
  try { return execFileSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }); } catch { return ""; }
}
const lineOf = (text, needle) => { const i = text.indexOf(needle); return i < 0 ? 0 : text.slice(0, i).split("\n").length; };

function nearestPkg(from, root) {
  for (let d = from; d.startsWith(root); d = dirname(d)) { const p = join(d, "package.json"); if (existsSync(p)) return p; if (d === dirname(d)) break; }
  return null;
}
const pkgName = (s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]);
const resolvable = (base) => !!resolveFile(base);

/** Imports in the added text that point at nothing. */
function madeUp(abs, root, text, whole) {
  if (!JS.test(abs)) return [];
  const out = [], pj = nearestPkg(dirname(abs), root);
  let deps = null;
  if (pj) { try { const p = JSON.parse(readFileSync(pj, "utf8")); deps = new Set(Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies })); if (p.name) deps.add(p.name); } catch { /* unreadable */ } }
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s*)['"]([^'"\n]+)['"]/gm;
  for (const m of text.matchAll(re)) {
    const s = m[1];
    if (s.startsWith(".")) {
      if (!resolvable(resolve(dirname(abs), s.split("?")[0]))) out.push({ kind: "made_up", line: lineOf(whole, m[0]) || lineOf(whole, s), detail: `Imports "${s}", but there's no such file.` });
    } else if (!BUILTIN.has(s) && !/^[@~#]\//.test(s) && !/^(virtual:|astro:|bun:|https?:)/.test(s) && deps) {
      const n = pkgName(s);
      if (!deps.has(n) && !existsSync(join(dirname(pj), "node_modules", n))) out.push({ kind: "made_up", line: lineOf(whole, m[0]), detail: `Imports the package "${n}", which isn't installed or listed in package.json.` });
    }
  }
  return out;
}

/** Packages added to package.json compared with the last commit. */
/** Packages this edit added to package.json, with versions: in the new text, in the file's dependencies, and not in
 *  what the edit replaced (or the last commit). Works without git. */
function newDeps(abs, root, added, before) {
  if (basename(abs) !== "package.json") return [];
  let now = {}; try { now = JSON.parse(readFileSync(abs, "utf8")); } catch { return []; }
  const deps = { ...now.dependencies, ...now.devDependencies, ...now.optionalDependencies };
  const pairs = (t) => new Set([...String(t).matchAll(/"([@\w./-]+)"\s*:\s*"[^"]*"/g)].map((m) => m[1]));
  const had = pairs(before);
  try { const head = JSON.parse(execFileSync("git", ["show", `HEAD:${relative(root, abs).replace(/\\/g, "/")}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); for (const n of Object.keys({ ...head.dependencies, ...head.devDependencies })) had.add(n); } catch { /* no git */ }
  return [...pairs(added)].filter((n) => n in deps && !had.has(n)).map((n) => [n, deps[n]]);
}

// Modes (team choice, see docs/platform/drift-guard-design.md):
// - quiet:  nothing goes to the agent; catches are recorded and the team is notified.
// - guide:  a short note to the agent after the edit (no stop, no question); it fixes it and carries on. Default.
// - strict: rule and protected-file edits are refused before they happen (PreToolUse); other catches stop the agent
//           after the edit until it fixes them.
const MSG_TAIL = {
  guide: "Fix this quietly and carry on with the task. Don't ask the user about it. If the user asked for exactly this, keep it and mention the rule in one line.",
  strict: "Go back and fix it before carrying on: keep to the rule, or use code that exists in this project. If the user asked for this on purpose, say so and carry on.",
};

function checks(phase, inp, data, root, abs, rel, text, whole) {
  const found = [], mode = data.mode;
  const ruleChecks = phase === "pre" ? mode === "strict" : mode !== "strict";
  // Protecting a folder means "don't change what's there", so adding a new file to it (a new migration) is fine.
  // Before the edit: the file must already exist. After it: it must be in the last commit.
  const existed = phase === "pre" ? existsSync(abs) : inp.tool_name !== "Write" ? true : (() => { try { execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: root, stdio: "ignore", timeout: 3000 }); return true; } catch { return false; } })();
  for (const r of data.rules || []) {
    if (r.except && globMatch(rel, r.except)) continue; // a one-off exception the user agreed to
    if (ruleChecks && r.kind === "protect" && existed && globMatch(rel, r.paths)) found.push({ kind: "protected", ruleId: r.id, line: 0, rule: r.text, detail: `Edited ${rel}, which is protected.` });
    if (ruleChecks && r.kind === "avoid" && r.pattern && (!r.paths || globMatch(rel, r.paths))) {
      // Valid, safe patterns ran in a worker with a time limit (main, below). Unsafe ones are skipped (rules.mjs refuses to
      // write one); an invalid one still matches as plain text; one that ran out of time is said, never taken as "fine".
      const safe = safePattern(r.pattern);
      if (safe.error && /repeats|longer than/.test(safe.error)) continue;
      if (data.slow?.has(r.id)) { found.push({ kind: "rule", ruleId: r.id, line: 0, rule: r.text, detail: "This rule's pattern took too long to check, so it was skipped. Simplify its pattern in .lintsure/rules.yml.", public: "A rule's pattern took too long and was skipped." }); continue; }
      const hit = safe.re ? data.hitOf?.(text, r.id) ?? null : text.includes(r.pattern) ? [r.pattern] : null;
      if (hit) found.push({ kind: "rule", ruleId: r.id, line: lineOf(whole, hit[0]), rule: r.text, detail: `Added "${hit[0].slice(0, 80)}", which this rule forbids.`, public: "Added code this rule forbids." });
    }
    if (phase === "post" && r.kind === "deps") for (const [n] of newDeps(abs, root, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before))) found.push({ kind: "deps", ruleId: r.id, line: lineOf(whole, `"${n}"`), rule: r.text, detail: `Added the package "${n}".` });
  }
  if (phase === "post") found.push(...madeUp(abs, root, text, whole), ...missingExports(abs, text, whole), ...duplicateFunctions(root, rel, text, whole), ...bandAids(rel, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before), whole), ...testGuard(rel, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before), whole), ...scopeGuard(rel, inp.tool_name), ...secretGuard(rel, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before)), ...privacyGuard(rel, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before)), ...profileChecks(root, rel, text, whole, (data.exceptions || []).map((x) => x.item).filter(Boolean).join(",")));
  // One change, one note: when the user's own rule about skipping tests caught it, drop the built-in note about it.
  if (found.some((f) => f.kind === "rule" && /skip|only/i.test(`${f.detail} ${f.rule || ""}`))) for (let i = found.length - 1; i >= 0; i--) if (found[i].kind === "band_aid" && /^Skips or isolates/.test(found[i].detail)) found.splice(i, 1);
  // A one-off the user agreed to covers only what it's about, so no session "fixes" it back and nothing else slips through.
  return found.filter((f) => !excepted(f, rel, data.exceptions));
}

/** Context for the file about to change, only what applies to it, and each topic only once per session (or again
 *  after compaction, which clears s.whispered). At most WHISPER_CAP whispers per session, so it stays cheap. */
const WHISPER_CAP = 8;
function whisper(root, rel, data, s) {
  s.whispered ||= {};
  if (Object.keys(s.whispered).filter((k) => !["brand", "components", "content", "map"].includes(k)).length >= WHISPER_CAP) return [];
  const out = [], once = (key, line) => { if (!s.whispered[key]) { s.whispered[key] = 1; out.push(line); } };
  const dir = rel.split("/").slice(0, -1).join("/");
  for (const r of data.rules || []) {
    if (r.except && globMatch(rel, r.except)) continue;
    if (r.kind === "protect" && globMatch(rel, r.paths) && existsSync(resolve(root, rel))) once(`r:${r.id}`, `- Protected: "${r.text}" Leave this file as it is unless the user asked to change it.`);
    if (r.kind === "avoid" && r.paths && globMatch(rel, r.paths)) once(`r:${r.id}`, `- Rule here: "${r.text}"`);
    if (r.kind === "note" && r.paths && globMatch(rel, r.paths)) once(`r:${r.id}`, `- Rule for these files: "${r.text}"`);
    else if (r.kind === "note" && !r.paths && dir && r.text.includes(dir)) once(`r:${r.id}`, `- Reminder: "${r.text}"`);
  }
  for (const x of data.exceptions || []) if (x.item && globMatch(rel, x.item)) once(`x:${x.item}`, `- Agreed exception in this file: ${x.after}. Keep it.`);
  let p = null; try { p = profile(root); } catch { /* no profile */ }
  if (p) {
    const ui = /\.(css|scss|sass|less|astro|tsx|jsx|vue|svelte|html)$/i.test(rel), cols = Object.entries(p.colors);
    if (ui && cols.length) once("brand", `- Brand colours: ${cols.slice(0, 8).map(([h, n]) => `${n} ${h}`).join(", ")}${p.fonts.length ? `. Fonts: ${p.fonts.slice(0, 3).join(", ")}` : ""}. Use these.`);
    const comps = Object.keys(p.components);
    if (ui && comps.length) once("components", `- Existing components to reuse: ${comps.slice(0, 20).join(", ")}${comps.length > 20 ? " and more" : ""}.`);
    if (p.content.length && (/(^|\/)(pages|app|content|data|components)\//.test(rel) || /\.(md|mdx)$/.test(rel))) once("content", `- Real copy and quotes live in ${p.content.slice(0, 4).join(", ")}. Use them, don't invent.`);
  }
  return out;
}

const DECIDE = new Set(["rule", "protected", "deps"]);
/** A decision for the user, asked once in the agent's question window with the recommended answer first. Empty when
 *  nothing here needs one. The question tool adds "Other" for the user's own answer or comments. */
function decision(found) {
  const f = found.find((x) => DECIDE.has(x.kind) || x.decide);
  if (!f) return "";
  const rule = f.rule ? `"${f.rule}"` : "this project rule";
  return [
    `This needs the user's decision, unless they already asked for exactly this. Ask them once with your question tool (in Claude Code, AskUserQuestion), not as a question in chat:`,
    `- Question: This change goes against ${rule}. What should happen?`,
    `- Option 1 (Recommended): Keep to the rule. You redo the change the rule's way.`,
    `- Option 2: Allow it just here. You keep it and record a one-off exception.`,
    `- Option 3: Change the rule. You keep it and record the new rule as the standard.`,
    `Then do what they chose, and for 2 or 3 record it with the lintsure-drift-guard skill (record-change). If you have no question tool, ask the same thing in one short message. Don't ask again about this rule in this session.`,
  ].join("\n");
}

async function main() {
  if (off()) quiet();
  const inp = input(), phase = inp.hook_event_name === "PreToolUse" ? "pre" : "post";
  if (!["Edit", "Write", "MultiEdit"].includes(inp.tool_name)) quiet();
  const ti = inp.tool_input || {}, root = resolve(inp.cwd || process.cwd()), abs = resolve(root, ti.file_path || "");
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!ti.file_path || rel.startsWith("..") || rel.startsWith(".lintsure/")) quiet(); // the rules file itself is the user's business
  const text = added(inp.tool_name, ti), whole = phase === "pre" ? text : read(abs) ?? text;
  const data = await rules(root), project = data.project.name, mode = data.mode;
  if (phase === "pre" && inp.tool_name === "Write" && existsSync(abs)) {
    const st = state(inp.session_id), cur = read(abs);
    if (cur !== null && cur.length < 300_000) { st.s.before = { [rel]: cur }; st.save(); }
  }
  if (phase === "post" && inp.tool_name === "Write") { const st = state(inp.session_id); data.before = st.s.before?.[rel]; if (st.s.before) { delete st.s.before; st.save(); } }
  if (phase === "pre" && mode === "quiet") quiet();
  // Rule patterns run off the main thread with a hard time limit, on both the added text and the whole file.
  const runnable = (data.rules || []).filter((r) => r.kind === "avoid" && r.pattern && safePattern(r.pattern).re).map((r) => ({ id: r.id, pattern: r.pattern }));
  const { hits, slow } = await matchRules(runnable, [text, whole]);
  data.hitOf = (t, id) => { const h = hits.get(`${t === text ? 0 : 1}:${id}`); return h == null ? null : [h]; };
  data.slow = new Set(slow);
  const found = checks(phase, inp, data, root, abs, rel, text, whole);
  if (phase === "post" && basename(abs) === "package.json") {
    const added = newDeps(abs, root, text, replaced(inp.tool_name, inp.tool_input || {}, root, rel, data.before));
    let installed = []; try { const pj = JSON.parse(whole); installed = Object.keys({ ...pj.dependencies, ...pj.devDependencies }).filter((n) => !added.some(([a]) => a === n)); } catch { /* fine */ }
    if (added.length) found.push(...(await packageGuard(added, installed, whole)));
  }

  // Raise each problem once per session; remember what was raised so a later clean edit counts as "went back".
  const { s, save } = state(inp.session_id);
  s.raised ||= {};
  // Nothing to refuse before the edit: whisper what the project already has for this kind of file, once per topic.
  if (phase === "pre" && !found.length) {
    const w = whisper(root, rel, data, s);
    save();
    if (w.length) say({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Lintsure, before you edit ${rel}:\n${w.join("\n")}` } });
    quiet();
  }
  const sig = (f) => `${rel}|${f.kind}|${f.ruleId || ""}|${f.detail}`;
  const now = new Set(found.map(sig));
  // "Went back" only when the problem is gone from the whole file, not just from the part this edit touched.
  const inFile = phase === "pre" || !Object.keys(s.raised).some((k) => k.startsWith(`${rel}|`)) ? now
    : new Set(checks(phase, inp, data, root, abs, rel, whole, whole).map(sig));
  const back = phase === "pre" ? [] : Object.entries(s.raised).filter(([k]) => k.startsWith(`${rel}|`) && !now.has(k) && !inFile.has(k)).map(([k, id]) => { delete s.raised[k]; return id; }).filter(Boolean);
  const fresh = found.filter((f) => !(sig(f) in s.raised));
  if (!fresh.length) { if (back.length) await report({ events: [], returned: back }); save(); quiet(); }

  const outcome = phase === "pre" ? "refused" : s.override ? "overridden" : "caught";
  const ids = await report({ mode, events: fresh.map((f) => ({ kind: f.kind, ruleId: f.ruleId, project, file: rel, line: f.line, detail: f.public || f.detail, outcome })), returned: back });
  // A refused edit never happened, so there's nothing to "go back" from: don't remember it as raised.
  if (phase === "post") fresh.forEach((f, i) => (s.raised[sig(f)] = ids[i] || ""));
  save();
  if (mode === "quiet") quiet();
  const lines = fresh.slice(0, 5).map((f) => `- ${rel}${f.line ? `:${f.line}` : ""}: ${f.detail}${f.rule ? ` Rule: "${f.rule}"` : ""}`).join("\n");
  // Rules, protected files and new packages are the user's call; everything else is a slip the agent fixes itself.
  const ask = s.override ? "" : decision(fresh);
  if (phase === "pre") say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Lintsure Drift Guard refused this edit:\n${lines}\n${ask || "Change the edit so it keeps to the rule."}` } });
  if (mode === "strict") say({ decision: "block", reason: `Lintsure Drift Guard: this edit drifts from the project.\n${lines}\n${fresh.some((f) => f.kind === "made_up") ? "If you're creating that file or function in this task, carry on. " : ""}${ask || MSG_TAIL.strict}` });
  // An agent often imports first and creates the file or function next: don't push it to undo that.
  const later = fresh.some((f) => f.kind === "made_up") ? "\nIf you're creating that file or function in this task, carry on. Otherwise use what exists." : "";
  say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Lintsure Drift Guard noticed:\n${lines}${later}\n${ask || MSG_TAIL.guide}` } });
}
main().catch(quiet);
