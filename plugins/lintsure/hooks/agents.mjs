// Lintsure for Gemini CLI and Codex: the same guards Claude Code runs, through one small adapter per agent.
// Usage in the agent's hooks config: `node <plugin>/hooks/agents.mjs <gemini|codex> <danger|threat|drift|remember|end>`.
// Each adapter turns the agent's event into the shape the guards read, runs the guard (once per file for multi-file
// edits), and turns the answer back. Silent on any error, like every Lintsure hook.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGuard, GUARDS } from "./cursor.mjs";

/** Codex's apply_patch text -> one edit per file: whole new files become Write, changes become MultiEdit. */
export function parsePatch(patch = "") {
  const files = [];
  let cur = null;
  for (const line of String(patch).split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) { cur = m[1] === "Delete" ? null : { kind: m[1], file_path: m[2].trim(), add: [], del: [] }; if (cur) files.push(cur); continue; }
    if (!cur || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.add.push(line.slice(1));
    else if (line.startsWith("-")) cur.del.push(line.slice(1));
  }
  return files.map((f) => f.kind === "Add"
    ? { tool_name: "Write", tool_input: { file_path: f.file_path, content: f.add.join("\n") } }
    : { tool_name: "MultiEdit", tool_input: { file_path: f.file_path, edits: [{ old_string: f.del.join("\n"), new_string: f.add.join("\n") }] } });
}

const SHELL = { gemini: ["run_shell_command"], codex: ["Bash", "exec_command", "shell"] };

/** The agent's event -> a list of guard inputs (several for a patch that touches several files). Empty = nothing to check. */
export function toGuardInputs(agent, ev) {
  const base = { cwd: ev.cwd || process.cwd(), session_id: ev.session_id || agent };
  const pre = agent === "gemini" ? ev.hook_event_name === "BeforeTool" : ev.hook_event_name === "PreToolUse";
  const post = agent === "gemini" ? ev.hook_event_name === "AfterTool" : ev.hook_event_name === "PostToolUse";
  const phase = pre ? "PreToolUse" : "PostToolUse", ti = ev.tool_input || {};
  if (ev.hook_event_name === "SessionStart") return [{ ...base, hook_event_name: "SessionStart", source: ev.source || "startup" }];
  if (ev.hook_event_name === (agent === "gemini" ? "AfterAgent" : "Stop")) return [{ ...base, hook_event_name: "Stop", stop_hook_active: !!ev.stop_hook_active }];
  if (!pre && !post) return [];
  if (SHELL[agent].includes(ev.tool_name)) return [{ ...base, hook_event_name: phase, tool_name: "Bash", tool_input: { command: ti.command || "" } }];
  if (agent === "gemini" && ev.tool_name === "write_file") return [{ ...base, hook_event_name: phase, tool_name: "Write", tool_input: { file_path: ti.file_path, content: ti.content || "" } }];
  if (agent === "gemini" && ev.tool_name === "replace") return [{ ...base, hook_event_name: phase, tool_name: "Edit", tool_input: { file_path: ti.file_path, old_string: ti.old_string || "", new_string: ti.new_string || "" } }];
  if (agent === "codex" && ev.tool_name === "apply_patch") return parsePatch(ti.command || ti.patch || ti.input).map((t) => ({ ...base, hook_event_name: phase, ...t }));
  return [];
}

/** Several guard answers -> one answer in the agent's format. A refusal or a question wins; notes are joined. */
export function toAgentOutput(agent, event, outs) {
  const list = outs.filter(Boolean);
  if (!list.length) return null;
  const hs = (o) => o.hookSpecificOutput || {};
  const stop = list.find((o) => ["deny", "ask"].includes(hs(o).permissionDecision));
  const notes = list.map((o) => hs(o).additionalContext || (o.decision === "block" ? o.reason : "")).filter(Boolean).join("\n\n");
  if (agent === "codex") {
    // Codex reads Claude Code's answer shape as is; only several answers need joining.
    if (stop) return stop;
    if (event === "Stop") return list.find((o) => o.decision === "block") || null;
    return notes ? { hookSpecificOutput: { hookEventName: event, additionalContext: notes } } : null;
  }
  // Gemini has no "ask the user": a guard that would ask refuses with the reason, so the agent brings it to the user.
  if (stop) {
    const why = hs(stop).permissionDecisionReason || "";
    return { decision: "deny", reason: hs(stop).permissionDecision === "ask" ? `${why}\nAsk the user before running this, and run it only if they agree.` : why };
  }
  if (event === "AfterAgent") { const b = list.find((o) => o.decision === "block"); return b ? { decision: "block", reason: b.reason } : null; }
  return notes ? { hookSpecificOutput: { hookEventName: event, additionalContext: notes } } : null;
}

export function handle(agent, guard, ev) {
  const file = GUARDS[guard];
  if (!file || !SHELL[agent]) return null;
  const inputs = toGuardInputs(agent, ev);
  if (!inputs.length) return null;
  return toAgentOutput(agent, ev.hook_event_name, inputs.map((i) => runGuard(file, i)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let ev = {};
  try { ev = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
  const res = handle(process.argv[2], process.argv[3], ev);
  if (res) process.stdout.write(JSON.stringify(res));
  process.exit(0);
}
