#!/usr/bin/env node
// Guard replay benchmark. Every case is a frozen hook input with a person's label ("catch" or "pass"); the guard is
// the code under test and runs fresh on each case, the way Claude Code would call it. Scores per hook: caught,
// missed, false alarm, with a 95% Wilson interval (samples are small). Fails when any case's result differs from its
// label (every case is a pinned regression), and always when a case marked critical is missed.
//   node scripts/replay.mjs [cases-dir]      default: test/replay
// Record new cases with LINTSURE_RECORD=1 (they land in .lintsure/replay/inbox.jsonl), label them, move them here.
// Cases may carry "files": { "path": "content" } to build the small repo a guard needs; it's created in a temp folder.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "lintsure", "hooks");
const dir = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "test", "replay"));
const env = { ...process.env, LINTSURE_API_KEY: "", LINTSURE_URL: "http://127.0.0.1:9", LINTSURE_PACKAGES: "offline", LINTSURE_ACTIVITY: "off", LINTSURE_RECORD: "" };

/** Lower bound and upper bound of the 95% Wilson interval for k successes out of n. Pure. */
export function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
/** Whether a hook's reply means it caught something: asked, denied, blocked, or said a Lintsure warning. Pure. */
export function caught(out) {
  if (!out.trim()) return false;
  let o; try { o = JSON.parse(out); } catch { return false; }
  const h = o.hookSpecificOutput || {};
  return ["ask", "deny"].includes(h.permissionDecision) || o.decision === "block" || /Lintsure/.test(h.additionalContext || "");
}

function runCase(c) {
  const root = mkdtempSync(join(tmpdir(), "ls-replay-"));
  try {
    for (const [p, text] of Object.entries(c.files || {})) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
    const input = JSON.parse(JSON.stringify(c.input));
    if (input.tool_input?.file_path) input.tool_input.file_path = join(root, input.tool_input.file_path);
    let out = "";
    try { out = execFileSync(process.execPath, [join(HOOKS, c.hook)], { input: JSON.stringify({ session_id: `replay-${process.pid}-${randomUUID()}`, cwd: root, ...input }), env, encoding: "utf8", timeout: 20000 }); }
    catch (e) { out = String(e.stdout || ""); if (e.status === 2) return "catch"; if (!out) return "error"; }
    return caught(out) ? "catch" : "pass";
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cases = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l, i) => ({ ...JSON.parse(l), where: `${f}:${i + 1}` })));
  const by = {}; let failed = 0, criticalMiss = 0;
  for (const c of cases) {
    if (c.expect !== "catch" && c.expect !== "pass") { console.log(`skip ${c.where}: no label`); continue; }
    const got = runCase(c), s = (by[c.hook] ??= { caught: 0, missed: 0, falseAlarm: 0, quiet: 0, errors: 0 });
    if (got === "error") s.errors++;
    else if (c.expect === "catch") got === "catch" ? s.caught++ : (s.missed++, c.critical && criticalMiss++);
    else got === "catch" ? s.falseAlarm++ : s.quiet++;
    if (got !== c.expect) { failed++; console.log(`FAIL ${c.where} ${c.hook}: expected ${c.expect}, got ${got}${c.critical ? " (critical)" : ""}${c.note ? ` - ${c.note}` : ""}`); }
  }
  for (const [h, s] of Object.entries(by)) {
    const [lo, hi] = wilson(s.caught, s.caught + s.missed);
    console.log(`${h.padEnd(16)} caught ${s.caught}/${s.caught + s.missed} (95% ${Math.round(lo * 100)}-${Math.round(hi * 100)}%) · false alarms ${s.falseAlarm}/${s.falseAlarm + s.quiet}${s.errors ? ` · errors ${s.errors}` : ""}`);
  }
  console.log(`${cases.length} cases, ${failed} not as labelled${criticalMiss ? `, ${criticalMiss} critical missed` : ""}.`);
  process.exit(failed || criticalMiss ? 1 : 0);
}
