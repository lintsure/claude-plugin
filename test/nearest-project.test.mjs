// One agent opened over several projects: each file is held to the rules of the project it is in, the nearest folder
// above it with a .lintsure folder. Never a folder above the one the agent was opened in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HOOKS = fileURLToPath(new URL("../plugins/lintsure/hooks/", import.meta.url));
const { projectFor, projectsUnder } = await import(new URL("../plugins/lintsure/hooks/lib.mjs", import.meta.url).href);
const env = { ...process.env, LINTSURE_API_KEY: "", LINTSURE_HOOK: "", LINTSURE_DRIFT: "", LINTSURE_RECORD: "" };
let n = 0;

function workspace() {
  const outer = mkdtempSync(join(tmpdir(), "ls-near-")), work = join(outer, "work");
  const w = (p, s) => { mkdirSync(dirname(join(outer, p)), { recursive: true }); writeFileSync(join(outer, p), s); };
  // A rules folder above the one the agent opens: it must never be used.
  w(".lintsure/rules.yml", 'rules:\n  - avoid: "FROM_ABOVE"\n    say: "A rule from above the opened folder."\n');
  w("work/billing-app/.lintsure/rules.yml", 'rules:\n  - avoid: "console\\\\.log"\n    say: "Billing: use the shared logger."\n');
  w("work/blog/.lintsure/rules.yml", 'rules:\n  - avoid: "lorem ipsum"\n    say: "Blog: no placeholder text."\n');
  w("work/billing-app/src/pay.ts", "export const pay = 1;\n");
  w("work/blog/posts/hello.md", "Hello.\n");
  w("work/notes.md", "Notes.\n");
  return { outer, work, w, done: () => rmSync(outer, { recursive: true, force: true }) };
}
function edit(cwd, file, content) {
  const input = { session_id: `near${process.pid}-${++n}`, cwd, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file, old_string: "x", new_string: content } };
  writeFileSync(file, content);
  const out = execFileSync("node", [join(HOOKS, "drift-guard.mjs")], { input: JSON.stringify(input), env, encoding: "utf8" });
  if (!out) return "";
  const o = JSON.parse(out);
  return o.hookSpecificOutput?.additionalContext ?? o.hookSpecificOutput?.permissionDecisionReason ?? o.reason ?? "";
}

test("the nearest .lintsure folder is the project, and nothing above the opened folder counts", () => {
  const f = workspace();
  assert.equal(projectFor(f.work, join(f.work, "billing-app/src/pay.ts")), join(f.work, "billing-app"));
  assert.equal(projectFor(f.work, join(f.work, "blog/posts/hello.md")), join(f.work, "blog"));
  assert.equal(projectFor(f.work, join(f.work, "notes.md")), f.work, "no project around the file: the opened folder");
  assert.equal(projectFor(f.work, "billing-app/src/pay.ts"), join(f.work, "billing-app"), "a relative path is read from the opened folder");
  // Opened inside a folder with no rules of its own: the rules above it are not borrowed.
  assert.equal(projectFor(join(f.work, "billing-app/src"), join(f.work, "billing-app/src/pay.ts")), join(f.work, "billing-app/src"));
  assert.equal(projectFor(f.work, join(f.outer, "elsewhere.ts")), f.work, "a file outside the opened folder");
  // A project inside a project: the inner one wins, and the outer rules do not apply too.
  f.w("work/billing-app/packages/ui/.lintsure/rules.yml", "rules: []\n");
  assert.equal(projectFor(f.work, join(f.work, "billing-app/packages/ui/button.ts")), join(f.work, "billing-app/packages/ui"));
  assert.deepEqual(projectsUnder(f.work).sort(), ["billing-app", "blog"], "the projects one or two levels down");
  f.done();
});

test("one session over two projects: each file is checked against its own project's rules", () => {
  const f = workspace();
  const pay = edit(f.work, join(f.work, "billing-app/src/pay.ts"), 'console.log("paid"); // lorem ipsum FROM_ABOVE\n');
  assert.match(pay, /Billing: use the shared logger/);
  assert.ok(!/Blog:/.test(pay) && !/from above/i.test(pay), "only the billing rules apply to a billing file");
  assert.match(pay, /src\/pay\.ts/, "the path is given from the project, not from the opened folder");
  assert.ok(!/billing-app\/src\/pay\.ts/.test(pay));

  const post = edit(f.work, join(f.work, "blog/posts/hello.md"), 'lorem ipsum, and console.log("x")\n');
  assert.match(post, /Blog: no placeholder text/);
  assert.ok(!/Billing:/.test(post), "only the blog rules apply to a blog file");

  assert.equal(edit(f.work, join(f.work, "notes.md"), 'console.log("x") lorem ipsum FROM_ABOVE\n'), "", "a file in no project has no rules of its own");

  // What was caught is logged in the project it happened in.
  assert.ok(existsSync(join(f.work, "billing-app/.lintsure/activity.jsonl")) && existsSync(join(f.work, "blog/.lintsure/activity.jsonl")));
  assert.ok(!existsSync(join(f.work, ".lintsure")), "nothing is written to the opened folder");
  assert.match(readFileSync(join(f.work, "billing-app/.lintsure/activity.jsonl"), "utf8"), /"file":"src\/pay\.ts"/);
  f.done();
});

test("opened inside one project, it behaves as before", () => {
  const f = workspace(), app = join(f.work, "billing-app");
  assert.match(edit(app, join(app, "src/pay.ts"), 'console.log("paid")\n'), /Billing: use the shared logger/);
  f.done();
});
