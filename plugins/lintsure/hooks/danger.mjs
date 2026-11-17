#!/usr/bin/env node
// Lintsure Danger Guard (PreToolUse on Bash). Destructive commands go to the user's permission prompt ("ask") with the
// reason and a safer option, before they run. Nothing is refused outright and nothing else is slowed down.
// Tells running a command apart from text that mentions it: `grep "rm -rf"` and `echo "DROP TABLE"` are fine.
// Runs in every mode (it asks the user, it doesn't talk to the agent). Off with LINTSURE_DANGER=off.
import { quiet, say, input, report, rules } from "./lib.mjs";

/** Split a command line into simple commands, keeping quoted text intact. */
export function segments(cmd) {
  const out = []; let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== "\\") q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") { if (cur.trim()) out.push(cur.trim()); cur = ""; if (cmd[i + 1] === c) i++; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unquote = (s) => s.replace(/'[^']*'|"[^"]*"/g, (m) => " ");
const SAFE_RM = /^(?:\.?\/)?(?:node_modules|dist|build|out|\.next|\.astro|\.turbo|\.cache|coverage|tmp|temp|\.wrangler\/tmp)(?:\/|$)|^\/tmp\/|\$TMPDIR|%TEMP%/;
const SQL_TOOL = /^(?:psql|mysql|sqlite3|mariadb|duckdb|cockroach|(?:npx\s+)?wrangler\s+d1\s+execute|supabase\s+db|prisma\s+db\s+execute)\b/;

/** Each finding: what it would do, and a safer way. Empty when the command is fine. */
export function danger(cmd) {
  const found = [], add = (id, why, safer) => found.push({ id, why, safer });
  for (const raw of segments(String(cmd || ""))) {
    const seg = raw.replace(/^(?:sudo|env\s+\S+=\S+|time|nohup)\s+/g, "").trim(), bare = unquote(seg);
    const word = bare.split(/\s+/)[0];
    if (word === "rm" && /\s-\w*[rR]/.test(bare)) {
      const targets = bare.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"));
      if (!targets.length || targets.some((t) => !SAFE_RM.test(t))) add("rm", `Deletes ${targets.join(" ") || "files"} for good, with everything inside.`, "Delete specific files, or move them aside first so you can undo.");
    }
    if (/^(?:Remove-Item|rd|rmdir)\b/i.test(word) && /-Recurse|\/s\b/i.test(bare)) add("rm", "Deletes a folder and everything in it for good.", "Delete specific files, or move the folder aside first.");
    if (word === "git") {
      if (/\breset\s+--hard\b/.test(bare)) add("git-reset", "Throws away all uncommitted changes.", "Run git stash first, so the changes can come back.");
      if (/\bclean\s+-\w*f/.test(bare)) add("git-clean", "Deletes untracked files for good.", "Run git clean -n first to see what would go.");
      if (/\bpush\b.*(?:\s--force(?!-with-lease)\b|\s-f\b)/.test(bare)) add("git-force", "Overwrites the remote branch, which can erase other people's commits.", "Use --force-with-lease, or push to a new branch.");
      if (/\b(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/.test(bare)) add("git-discard", "Throws away all changes in the working folder.", "Run git stash first, or restore only the files you mean.");
      if (/\bbranch\s+-D\b/.test(bare)) add("git-branch", "Deletes a branch even if it isn't merged.", "Use git branch -d, which refuses unmerged branches.");
      if (/\bstash\s+(?:drop|clear)\b/.test(bare)) add("git-stash", "Deletes saved stashes for good.", "Check git stash list first.");
    }
    // SQL only counts when it goes to a database tool, not when it's text in grep or echo.
    if (SQL_TOOL.test(bare) || /^(?:psql|mysql|sqlite3)\b/.test(word)) {
      if (/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\b)/i.test(seg)) add("sql-drop", `Deletes a table or database${/--remote\b/.test(seg) ? " in production" : ""}.`, "Back it up first, or do it in a migration the user reviews.");
      if (/\bDELETE\s+FROM\s+\w+(?![^;]*\bWHERE\b)/i.test(seg)) add("sql-delete", "Deletes every row in a table (no WHERE).", "Add a WHERE clause, or back the table up first.");
    }
    if (/\bwrangler\s+d1\s+delete\b|\bdocker\s+system\s+prune\b|\bkubectl\s+delete\s+(?:ns|namespace)\b|\bterraform\s+destroy\b|\baws\s+s3\s+rb\b.*--force/.test(bare)) add("infra", "Deletes infrastructure or data that can't be brought back.", "Check with the user first and make a backup.");
    if (/(?:^|\s)>\s*\.env(?:\.\w+)?(?:\s|$)/.test(bare) || (word === "rm" && /(?:^|\s)\.env\b/.test(bare))) add("env", "Wipes the .env file with its secrets.", "Back it up, or edit only the line you need.");
    if (/^(?:python3?|node|ruby|perl)\b/.test(word) && /\s-[ce]\s/.test(seg) && /\b(?:shutil\.rmtree|os\.remove|os\.unlink|rmSync|rmdirSync|unlinkSync|rimraf|FileUtils\.rm_rf)\b/.test(seg)) add("inline", "Runs a script that deletes files.", "Delete specific files you can name, or move them aside first.");
  }
  return found;
}

async function main() {
  if ((process.env.LINTSURE_DANGER || process.env.LINTSURE_HOOK || "").toLowerCase() === "off") quiet();
  const inp = input();
  if (inp.tool_name !== "Bash" && inp.tool_name !== "PowerShell") quiet();
  const found = danger(inp.tool_input?.command);
  if (!found.length) quiet();
  let project = ""; try { project = (await rules(inp.cwd || process.cwd())).project.name; } catch { /* fine */ }
  // Only which kind of command it was goes to the workspace, never the command (it can hold paths or secrets).
  await report({ events: found.map((f) => ({ kind: "danger", project, detail: f.why, outcome: "caught" })) });
  say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `Lintsure Danger Guard: ${found.map((f) => `${f.why} Safer: ${f.safer}`).join(" ")}` } });
}
if (process.argv[1] && process.argv[1].endsWith("danger.mjs")) main().catch(quiet);
