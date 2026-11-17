// Replay benchmark helpers and the recorder's cleaning: repo-relative paths, no session, keys masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForReplay } from "../plugins/lintsure/hooks/lib.mjs";
import { wilson, caught } from "../scripts/replay.mjs";

test("recorder keeps the input but not the machine, the session or keys", () => {
  const n = normalizeForReplay({ session_id: "abc", transcript_path: "/x/t.jsonl", cwd: "C:\work\shop", hook_event_name: "PostToolUse",
    tool_input: { file_path: "C:\work\shop\src\a.ts", content: "const k = 'sk_live_1234567890abcdef';" } });
  assert.equal(n.session_id, undefined); assert.equal(n.cwd, undefined); assert.equal(n.transcript_path, undefined);
  assert.equal(n.tool_input.file_path, "src/a.ts");
  assert.match(n.tool_input.content, /\[secret\]/);
  assert.doesNotMatch(n.tool_input.content, /sk_live_1234/);
});

test("wilson interval and catch detection", () => {
  const [lo, hi] = wilson(3, 3); assert.ok(lo > 0.4 && lo < 0.5 && hi === 1);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.equal(caught(JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } })), true);
  assert.equal(caught(JSON.stringify({ decision: "block" })), true);
  assert.equal(caught(""), false);
});
