#!/usr/bin/env node
// Lintsure Loop Guard (PostToolUse). An agent that keeps making the same call with nothing changing in between is stuck:
// the same failing command, the same file read again and again. After the 5th identical call since the last edit it tells
// the agent, once, to stop and change approach. Edits reset the count, so rerunning tests after a fix is fine.
// It only counts; it never blocks. Off with LINTSURE_LOOP=off. Limit: LINTSURE_LOOP_SAME (default 5).
import { createHash } from "node:crypto";
import { quiet, say, input, state, report, rules } from "./lib.mjs";

const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
// Bookkeeping tools that are fine to repeat.
const SKIP = /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ToolSearch|mcp__ccd_turn__.*|mcp__ccd_session__.*|ScheduleWakeup|Monitor)$/;
const label = (tool, inp) => tool === "Bash" || tool === "PowerShell" ? `run \`${String(inp.command || "").replace(/\s+/g, " ").trim().slice(0, 80)}\``
  : inp.file_path ? `${tool === "Read" ? "read" : "called " + tool + " on"} ${String(inp.file_path).split(/[\\/]/).pop()}` : `called ${tool} with the same input`;

/** One tool call into the session's loop counter. Returns what to tell the agent, or null. Pure apart from `s`. */
export function loopCheck(s, tool, inp, limit = 5) {
  if (!tool || SKIP.test(tool)) return null;
  const L = (s.loop ??= { counts: {}, told: [] });
  // A call that changes code is progress: start counting again. The edit itself is counted too, by its exact content.
  if (EDITS.test(tool)) L.counts = {};
  const norm = tool === "Bash" || tool === "PowerShell" ? { c: String(inp.command || "").replace(/\s+/g, " ").trim() } : inp;
  const key = createHash("sha256").update(tool + "\0" + JSON.stringify(norm)).digest("hex").slice(0, 16);
  const n = (L.counts[key] = (L.counts[key] || 0) + 1);
  if (n < limit || L.told.includes(key)) return null;
  L.told.push(key);
  return `Lintsure Loop Guard: you've ${label(tool, inp)} ${n} times with no code change in between, so this approach isn't moving. Stop repeating it. Read the last error closely, try a different approach, or ask the user what they want.`;
}

async function main() {
  if ((process.env.LINTSURE_LOOP || process.env.LINTSURE_HOOK || "").toLowerCase() === "off") quiet();
  const inp = input();
  const limit = Math.max(2, Number(process.env.LINTSURE_LOOP_SAME) || 5);
  const { s, save } = state(inp.session_id);
  const msg = loopCheck(s, inp.tool_name, inp.tool_input || {}, limit);
  save();
  if (!msg) quiet();
  let project = ""; try { project = (await rules(inp.cwd || process.cwd())).project.name; } catch { /* fine */ }
  // Only that a loop happened goes to the workspace (with a key), never the command or file.
  await report({ events: [{ kind: "loop", project, detail: "Same call repeated with no change in between", outcome: "caught" }] });
  say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: msg } });
}
if (process.argv[1] && process.argv[1].endsWith("loop.mjs")) main().catch(quiet);
