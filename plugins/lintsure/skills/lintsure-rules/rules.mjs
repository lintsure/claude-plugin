#!/usr/bin/env node
// Lintsure rules helper for the lintsure-rules skill. Runs on this machine; nothing is sent anywhere.
//   node rules.mjs suggest            Suggest rules from what the project already has, each with its reason.
//   node rules.mjs write '<json>'     Add rules to .lintsure/rules.yml. <json> is an array of
//                                      {kind, text, pattern?, paths?, in?} (kind: avoid, protect, deps, note).
//   node rules.mjs list               Show the rules the file holds now, in plain words.
//   node rules.mjs sync [targets]     Write the rules into other agents' instruction files (agents, cursor, copilot,
//                                      claude; comma separated). Default: AGENTS.md and Cursor, plus the others if present.
//   node rules.mjs unsync             Take Lintsure's block out of those files again.
// Suggestions are guesses from files that exist, never claims about what the code does. The user decides.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileRules } from "../../hooks/lib.mjs";
import { profile } from "../../hooks/profile.mjs";
import { sync, synced, unsync } from "./agents.mjs";

const root = process.cwd(), FILE = join(root, ".lintsure", "rules.yml");
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".astro", ".output", "coverage", ".wrangler", "vendor", "out"]);
const rel = (f) => relative(root, f).replace(/\\/g, "/");

function files(max = 5000) {
  const out = [];
  const go = (d, depth) => {
    if (out.length >= max || depth > 8) return;
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && (!e.name.startsWith(".") || e.name === ".github")) go(join(d, e.name), depth + 1); }
      else out.push(join(d, e.name));
    }
  };
  go(root, 0);
  return out;
}
/** How many lines in source files already match, so a rule the code breaks everywhere isn't suggested blindly. */
function uses(all, re, only) {
  let n = 0;
  for (const f of all) {
    if (!/\.(m?[jt]sx?|cjs|astro|vue|svelte)$/.test(f) || (only && !only.test(rel(f)))) continue;
    try { if (statSync(f).size > 300_000) continue; for (const line of readFileSync(f, "utf8").split("\n")) if (re.test(line)) n++; } catch { /* skip */ }
  }
  return n;
}

function suggest() {
  const all = files(), paths = all.map(rel), p = profile(root), s = [];
  const has = (re) => paths.find((x) => re.test(x));
  const dirOf = (x) => x.split("/").slice(0, -1).join("/");

  const mig = has(/(^|\/)(migrations?|db\/migrate|prisma\/migrations)\/[^/]+\.(sql|[jt]s|rb|py)$/);
  if (mig) s.push({ id: "protect-migrations", kind: "protect", paths: `${dirOf(mig)}/**`, text: "Don't change database migrations that already exist. Add a new one instead.", why: `Suggested because ${dirOf(mig)}/ holds migrations. New files there are still allowed.` });

  const test = has(/(\.test|\.spec)\.[jt]sx?$|(^|\/)tests?\//);
  if (test) {
    const n = uses(all, /\.(skip|only)\(|\bxit\(|\bxdescribe\(/);
    s.push({ id: "no-skip-tests", kind: "avoid", pattern: "\\.(skip|only)\\(|\\bxit\\(|\\bxdescribe\\(", text: "Never skip or disable tests to make them pass.", why: `Suggested because the project has tests (${test}).${n ? ` Note: ${n} skipped or focused test${n > 1 ? "s" : ""} already exist.` : ""}` });
  }
  if (existsSync(join(root, "package.json"))) s.push({ id: "ask-deps", kind: "deps", text: "Ask me before adding a new package.", why: "Suggested because the project has a package.json. Agents often add packages, or invent ones that don't exist." });

  const logger = has(/(^|\/)(lib|utils?|src)\/(log|logger|logging)\.[jt]s$/);
  if (logger) {
    const n = uses(all, /console\.log\(/, /^(src|app|lib)\//);
    if (n < 5) s.push({ id: "use-logger", kind: "avoid", pattern: "console\\.log\\(", in: "src/**, app/**, lib/**", text: `Use the logger in ${logger}, not console.log.`, why: `Suggested because ${logger} exists${n ? ` (console.log is used ${n} time${n > 1 ? "s" : ""} today)` : ""}.` });
  }
  const cols = Object.entries(p.colors);
  if (cols.length >= 2) s.push({ id: "brand-colours", kind: "note", text: `Use the brand colours (${cols.slice(0, 6).map(([h, n]) => `${n} ${h}`).join(", ")}), not new ones.`, why: "Suggested because the project defines these colours. Drift Guard already flags brand-new colours." });
  const comps = Object.keys(p.components);
  if (comps.length >= 2) s.push({ id: "reuse-components", kind: "note", text: `Reuse the existing components (${comps.slice(0, 8).join(", ")}${comps.length > 8 ? " and more" : ""}) instead of making new ones that do the same thing.`, why: `Suggested because the project has ${comps.length} components.` });
  if (p.content.length) s.push({ id: "real-copy", kind: "note", text: `Use the real quotes, names and copy from ${p.content.slice(0, 3).join(", ")}. Never invent them.`, why: "Suggested because the project keeps content in these files." });
  const wf = has(/^\.github\/workflows\/[^/]+\.ya?ml$/);
  if (wf) s.push({ id: "protect-ci", kind: "protect", paths: ".github/workflows/**", text: "Don't change the CI workflows unless I ask.", why: "Suggested because the project has GitHub workflows. Changes there can leak secrets or skip checks." });
  const gen = has(/(^|\/)(generated|__generated__)\/|\.gen\.[jt]s$/);
  if (gen) s.push({ id: "protect-generated", kind: "protect", paths: gen.includes("generated/") ? `${gen.slice(0, gen.indexOf("generated/") + 10)}**` : "**/*.gen.*", text: "Don't edit generated files by hand. Change the source and regenerate.", why: `Suggested because ${gen} looks generated.` });
  const env = has(/(^|\/)\.env(\.example|\.sample)?$/);
  if (env || paths.some((x) => /\.env/.test(x))) s.push({ id: "no-secrets", kind: "avoid", pattern: "(sk_live_|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)", text: "Never put keys or passwords in the code. Read them from environment variables.", why: "Suggested because the project uses environment files." });

  // Drop what the rules file already has.
  const have = fileRules(root), same = (a, b) => a.kind === b.kind && (a.pattern || "") === (b.pattern || "") && (a.paths || "") === (b.paths || "") && (a.kind !== "note" || a.text === b.text);
  return s.filter((x) => !have.some((h) => same(h, x))).slice(0, 10);
}

// YAML writing: append to the end of the rules: block, keep everything else exactly as it is.
const q = (v) => JSON.stringify(String(v));
function item(r) {
  const lines = [];
  if (r.kind === "avoid") lines.push(`  - avoid: ${q(r.pattern)}`, `    say: ${q(r.text)}`, ...(r.in ? [`    in: ${q(r.in)}`] : []));
  else if (r.kind === "protect") lines.push(`  - protect: ${q(r.paths)}`, `    say: ${q(r.text)}`);
  else if (r.kind === "deps") lines.push(`  - deps: ask`, `    say: ${q(r.text)}`);
  else lines.push(`  - note: ${q(r.text)}`, ...(r.when ? [`    when: ${q(r.when)}`] : []));
  return lines;
}
function write(list) {
  const ok = list.filter((r) => ["avoid", "protect", "deps", "note"].includes(r.kind) && r.text && (r.kind !== "avoid" || r.pattern) && (r.kind !== "protect" || r.paths));
  for (const r of ok) if (r.kind === "avoid") { try { new RegExp(r.pattern); } catch { console.log(`Skipped "${r.text}": the pattern isn't valid.`); r.skip = true; } }
  const add = ok.filter((r) => !r.skip);
  if (!add.length) { console.log("Nothing to add."); return; }
  const before = fileRules(root).length;
  let src = existsSync(FILE) ? readFileSync(FILE, "utf8") : "# Project rules for AI agents. Lintsure Drift Guard holds every agent to these.\nrules:\n";
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let start = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (start < 0) { if (lines.at(-1) === "") lines.pop(); lines.push("rules:"); start = lines.length - 1; }
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  while (end - 1 > start && lines[end - 1].trim() === "") end--; // keep blank lines after the block
  lines.splice(end, 0, ...add.flatMap(item));
  mkdirSync(join(root, ".lintsure"), { recursive: true });
  writeFileSync(FILE, lines.join("\n").replace(/\n*$/, "\n"));
  const after = fileRules(root);
  if (after.length !== before + add.length) { writeFileSync(FILE, src); console.log("Couldn't add the rules safely, so the file was left as it was."); process.exitCode = 1; return; }
  console.log(`Added ${add.length} rule${add.length > 1 ? "s" : ""} to .lintsure/rules.yml:`);
  for (const r of add) console.log(`- ${r.text}`);
  // Files that already carry the rules stay in step; nothing new is created without "sync".
  const keep = synced(root);
  if (keep.length) { const r = sync(root, keep); console.log(`Updated the rules in: ${r.written.join(", ")}.`); }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "suggest") {
  const s = suggest();
  if (!s.length) console.log("No suggestions: the rules file already covers what Lintsure can see in this project.");
  else { s.forEach((x, i) => console.log(`${i + 1}. ${x.text}\n   ${x.why}`)); console.log(`\nJSON: ${JSON.stringify(s)}`); }
} else if (cmd === "write") {
  let list; try { list = JSON.parse(arg || "[]"); } catch { console.log("Pass the rules as one JSON array."); process.exit(1); }
  write(Array.isArray(list) ? list : [list]);
} else if (cmd === "list") {
  const r = fileRules(root);
  console.log(r.length ? r.map((x) => `- ${x.text}${x.kind === "protect" ? ` (protects ${x.paths})` : ""}`).join("\n") : "No rules file yet.");
} else if (cmd === "sync") {
  const r = sync(root, arg ? arg.split(",").map((x) => x.trim()) : null);
  console.log(r.note ?? `Wrote the project rules to:\n${r.written.map((w) => `- ${w}`).join("\n")}\nYour own text in those files was left as it was.`);
} else if (cmd === "unsync") {
  const d = unsync(root);
  console.log(d.length ? `Took the Lintsure rules out of: ${d.join(", ")}.` : "No Lintsure rules found in other agents' files.");
} else console.log("Use: suggest | write '<json>' | list | sync [targets] | unsync");
