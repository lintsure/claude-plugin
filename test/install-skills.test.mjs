// Skill installer: installs into a fake home, the copied helpers still run, uninstall leaves other skills alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-skills.mjs");

test("install, run a copied helper, uninstall only our folders", () => {
  const home = mkdtempSync(join(tmpdir(), "ls-skills-"));
  const env = { ...process.env, LINTSURE_HOME_OVERRIDE: home };
  const skills = join(home, ".agents", "skills");
  mkdirSync(join(skills, "someone-else"), { recursive: true });
  writeFileSync(join(skills, "someone-else", "SKILL.md"), "x");
  mkdirSync(join(skills, "lintsure-check"), { recursive: true }); // same name, not ours: must be skipped

  const out = execFileSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
  assert.match(out, /skip .*lintsure-check/);
  assert.ok(existsSync(join(skills, "lintsure-rules", "SKILL.md")));
  assert.ok(!existsSync(join(skills, "lintsure-check", "SKILL.md")));

  // The copied helper imports the hooks from ~/.lintsure/agents and runs from a project folder.
  const proj = mkdtempSync(join(tmpdir(), "ls-proj-"));
  execFileSync(process.execPath, [join(skills, "lintsure-rules", "rules.mjs"), "list"], { cwd: proj, env, encoding: "utf8" });

  execFileSync(process.execPath, [SCRIPT, "--uninstall"], { env, encoding: "utf8" });
  assert.ok(!existsSync(join(skills, "lintsure-rules")));
  assert.ok(existsSync(join(skills, "someone-else", "SKILL.md")));
  assert.ok(existsSync(join(skills, "lintsure-check")));
  assert.ok(!existsSync(join(home, ".lintsure", "agents")));
  rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true });
});
