// Lintsure for Cursor: one adapter that runs the same guards Claude Code uses.
// Cursor calls `node hooks/cursor.mjs <guard>` with its own event JSON on stdin. This turns it into the event shape the
// guards already read, runs the guard, and turns the guard's answer into what Cursor expects. The guard logic stays in one
// place, so Cursor and Claude Code always check the same things. Silent on any error, like every Lintsure hook.
//
// Cursor event         -> guard            -> what Cursor gets back
// beforeShellExecution -> danger, threat   -> permission "ask" with the reason
// preToolUse (Write)   -> drift (pre), threat -> permission "deny"/"ask", or a note to the agent
// postToolUse (Write)  -> drift (post)     -> additional_context for the agent
// sessionStart         -> remember         -> additional_context (rules, decisions, open findings)
// stop                 -> end-of-task      -> followup_message when high findings need a look
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const GUARDS = { danger: "danger.mjs", threat: "threat.mjs", drift: "drift-guard.mjs", remember: "remember.mjs", end: "end-of-task.mjs" };

/** Cursor's event -> the Claude Code-style event the guards read. Null when the guard has nothing to look at. */
export function toGuardInput(ev) {
  const name = ev.hook_event_name, cwd = ev.cwd || (ev.workspace_roots || [])[0] || process.cwd();
  const base = { cwd, session_id: ev.session_id || ev.conversation_id || ev.generation_id || "cursor" };
  if (name === "beforeShellExecution") return { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: ev.command || "" } };
  if (name === "preToolUse" || name === "postToolUse") {
    if (ev.tool_name === "Shell" || ev.tool_name === "Bash") return { ...base, hook_event_name: name === "preToolUse" ? "PreToolUse" : "PostToolUse", tool_name: "Bash", tool_input: { command: ev.tool_input?.command || "" } };
    if (ev.tool_name !== "Write") return null;
    const ti = ev.tool_input || {};
    const file_path = ti.file_path || ti.path || ti.target_file;
    if (!file_path) return null;
    // Cursor's Write carries either the whole file or a list of replacements; map both onto the guard's tools.
    const tool = Array.isArray(ti.edits) ? { tool_name: "MultiEdit", tool_input: { file_path, edits: ti.edits } }
      : { tool_name: "Write", tool_input: { file_path, content: ti.content ?? ti.contents ?? ti.code_edit ?? "" } };
    return { ...base, hook_event_name: name === "preToolUse" ? "PreToolUse" : "PostToolUse", ...tool };
  }
  if (name === "sessionStart") return { ...base, hook_event_name: "SessionStart", source: "startup" };
  if (name === "stop") return { ...base, hook_event_name: "Stop", stop_hook_active: (ev.loop_count || 0) > 0 };
  return null;
}

/** A guard's Claude Code-style answer -> Cursor's response for this event. Null means "say nothing". */
export function toCursorOutput(event, out) {
  if (!out) return null;
  const hs = out.hookSpecificOutput || {}, reason = hs.permissionDecisionReason || out.reason || "";
  const note = hs.additionalContext || (out.decision === "block" ? out.reason : "") || "";
  if (event === "beforeShellExecution" || event === "preToolUse") {
    if (hs.permissionDecision === "deny" || hs.permissionDecision === "ask") return { permission: hs.permissionDecision, user_message: reason, agent_message: reason };
    if (note) return { permission: "allow", agent_message: note };
    return null;
  }
  if (event === "postToolUse" || event === "sessionStart") return note ? { additional_context: note } : null;
  if (event === "stop") return out.decision === "block" && out.reason ? { followup_message: out.reason } : null;
  return null;
}

export function runGuard(file, input) {
  const r = spawnSync(process.execPath, [join(here, file)], { input: JSON.stringify(input), encoding: "utf8", timeout: 110_000, env: process.env });
  try { return r.stdout ? JSON.parse(r.stdout) : null; } catch { return null; }
}

/** Runs one guard for one Cursor event and returns Cursor's response (or null). */
export function handle(guard, ev) {
  const file = GUARDS[guard], input = toGuardInput(ev);
  if (!file || !input) return null;
  return toCursorOutput(ev.hook_event_name, runGuard(file, input));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
  const res = handle(process.argv[2], ev);
  if (res) process.stdout.write(JSON.stringify(res));
  process.exit(0);
}
