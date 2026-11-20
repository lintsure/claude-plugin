#!/usr/bin/env node
// Lintsure end-of-task check for Claude Code (Stop hook).
// - Runs only when this session changed files, and never twice in a row (stop_hook_active).
// - Scans locally with the published CLI. No code leaves the machine.
// - With LINTSURE_API_KEY set: applies the workspace's decisions and reports the scan summary (findings metadata,
//   commit, checks that ran) so findings are tracked and fixes get verified.
// - Interrupts only for NEW risky (high) findings in files changed this session, at most 3 lines, once per finding.
//   Everything else is stored and the user gets one short note. Clean runs are silent. Any error is silent.
// Turn it off with LINTSURE_HOOK=off.
import { execFileSync, execSync } from "node:child_process";
import { activity, project, wsRules } from "./lib.mjs";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const ENGINE = "lintsure@0.3.14";
const API = (process.env.LINTSURE_URL || "https://lintsure.com").replace(/\/$/, "");
const KEY = process.env.LINTSURE_API_KEY || "";
const CODE = /\.(m?[jt]sx?|cjs|py|rb|go|rs|java|kt|php|cs|sql|ya?ml|toml|json|tf|sh|env\.example|vue|svelte|astro)$/i;

const quiet = () => process.exit(0);
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();

async function main() {
  if ((process.env.LINTSURE_HOOK || "").toLowerCase() === "off") quiet();
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { quiet(); }
  if (input.stop_hook_active) quiet(); // we already spoke once in this stop; let Claude finish
  const cwd = input.cwd || process.cwd();

  // Files this session touched: tracked changes plus new untracked files, relative to cwd.
  let changed = [];
  try {
    changed = [...git(cwd, ["diff", "--name-only", "--relative", "HEAD"]).split("\n"), ...git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")]
      .map((s) => s.trim()).filter((s) => s && CODE.test(s));
  } catch { quiet(); } // not a git repo: nothing to compare against
  if (!changed.length) quiet();

  // Scan the whole project locally, writing reports to a temp folder so the repo stays untouched.
  const out = mkdtempSync(join(tmpdir(), "lintsure-hook-"));
  let report;
  try {
    // One quoted command string works the same on Windows (npx is a .cmd there) and elsewhere, spaces in paths included.
    // With an API key, hand the workspace rules this session already enforces to the scan, so its policy fingerprint
    // covers them. The scan only hashes them; it never goes online. Without a key nothing changes.
    const env = { ...process.env };
    if (KEY) {
      const ws = await wsRules(project(cwd)).catch(() => null);
      if (ws) {
        const f = join(out, "workspace-rules.json");
        writeFileSync(f, JSON.stringify({ rules: ws.rules || [], exceptions: ws.exceptions || [], mode: ws.mode || null }));
        env.LINTSURE_WORKSPACE_RULES = f;
      }
    }
    execSync(`npx -y ${ENGINE} scan "${cwd.replace(/"/g, "")}" --json`, { cwd: out, stdio: "ignore", timeout: 100_000, env });
  } catch { /* the CLI exits non-zero when it finds gaps; the report is still written */ }
  try { report = JSON.parse(readFileSync(join(out, "lintsure-report.json"), "utf8")); } catch { rmSync(out, { recursive: true, force: true }); quiet(); }
  rmSync(out, { recursive: true, force: true });

  const all = (report.findings || []).filter((f) => f.status !== "accepted");
  const project = basename(cwd);
  // Local activity log: counts and the policy code only, so the local dashboard can show runs without an account.
  activity(cwd, { scan: { open: all.length, gap: all.filter((f) => f.status === "gap").length, partial: all.filter((f) => f.status === "partial").length, policy: report.policy?.fingerprint, rules: report.rulesVersion } });
  let commit = "", branch = "";
  try { commit = git(cwd, ["rev-parse", "HEAD"]); branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { /* fine */ }

  // Workspace: decisions to respect, then the summary of this scan (metadata only).
  let decided = [];
  if (KEY) {
    const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    try {
      const r = await fetch(`${API}/api/v1/decisions?v=1&target=${encodeURIComponent(project)}`, { headers: H, signal: AbortSignal.timeout(4000) });
      if (r.ok) decided = (await r.json()).decisions || [];
    } catch { /* unreachable: keep every finding, as the contract says */ }
    try {
      const checks = [...new Set([...(report.met || []).map((m) => m.ruleId), ...(report.findings || []).map((f) => f.ruleId)])];
      await fetch(`${API}/api/v1/runs`, { method: "POST", headers: H, signal: AbortSignal.timeout(6000), body: JSON.stringify({
        project, source: "agent", commit: /^[0-9a-f]{7,64}$/i.test(commit) ? commit : undefined, branch, version: ENGINE.split("@")[1], checks,
        filesChecked: report.filesChecked, held: report.held,
        findings: all.map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity, status: f.status, file: f.file, line: f.line, fix: f.fix, controls: f.controls })),
        scope: { notCovered: report.notCovered, rulesOff: report.rulesOff, skipped: [] },
      }) });
    } catch { /* reporting is best effort */ }
  }
  const isDecided = (f) => decided.some((d) => d.fingerprint === `${f.ruleId}|${project}|${f.file}|${f.line}` || (d.rule_id === f.ruleId && d.file === f.file));
  const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const touched = new Set(changed.map(norm));
  const mine = all.filter((f) => touched.has(norm(f.file)) && !isDecided(f));
  if (!mine.length) quiet();

  // Only mention each finding once per session.
  const seenFile = join(tmpdir(), `lintsure-seen-${input.session_id || "x"}.json`);
  let seen = [];
  try { if (existsSync(seenFile)) seen = JSON.parse(readFileSync(seenFile, "utf8")); } catch { seen = []; }
  const fp = (f) => `${f.ruleId}|${f.file}|${f.line}`;
  const fresh = mine.filter((f) => !seen.includes(fp(f)));
  if (!fresh.length) quiet();
  try { writeFileSync(seenFile, JSON.stringify([...seen, ...fresh.map(fp)].slice(-500))); } catch { /* fine */ }

  const high = fresh.filter((f) => f.severity === "high");
  // Check before calling it a problem (GitHub's lesson: findings with fixes, checked first). A Partial finding carries what
  // Lintsure couldn't see; an exact change is offered when the rule has one.
  const line = (f) => `- ${f.title} (${f.file}${f.line ? `:${f.line}` : ""}): ${f.fix}`
    + (f.status === "partial" && f.unseen ? `
  Check first: ${f.unseen}` : "")
    + (f.patch ? `
  Exact change: ${f.patch.old == null ? `add before line ${f.patch.line}` : `line ${f.patch.line} becomes`} ${JSON.stringify(f.patch.text.trim())}` : "");
  if (high.length) {
    say({
      decision: "block",
      reason: `Lintsure found ${high.length} high-severity issue${high.length > 1 ? "s" : ""} in files you changed:\n${high.slice(0, 3).map(line).join("\n")}${high.length > 3 ? `\n…and ${high.length - 3} more (run the lintsure scan tool).` : ""}\nFor each one marked "Check first", read the code around it: if it isn't a real problem, say so in one line with the reason and leave the code alone. Fix the real ones now if it's quick and safe, or tell the user what you found and why you left it. Don't loop on this.`,
    });
  }
  // Not risky: stored in the workspace (when a key is set), and one short note for the user, no interruption.
  say({ systemMessage: `Lintsure stored ${fresh.length} issue${fresh.length > 1 ? "s" : ""} from this session${KEY ? " in your workspace" : ""} (for example: ${fresh[0].title}, ${fresh[0].file}). Want to take a look? Ask Claude to "show the Lintsure findings".` });
}

main().catch(() => quiet());
