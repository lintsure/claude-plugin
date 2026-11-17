#!/usr/bin/env node
// Installs the Lintsure skills for agents that read standard SKILL.md folders but don't use Claude Code plugins.
//   node scripts/install-skills.mjs              install for every agent found on this machine
//   node scripts/install-skills.mjs --dir <path> install into one skills folder you name
//   node scripts/install-skills.mjs --list       show where it would install, change nothing
//   node scripts/install-skills.mjs --uninstall  remove only what this script installed
// The plugin is copied once to ~/.lintsure/agents (skills import its hooks/ folder), and each agent's skills folder
// gets a copy of the skills pointing there. A manifest records every folder written, so uninstall never touches
// skills that belong to anyone else. Nothing is downloaded and nothing leaves the machine.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../plugins/lintsure");
const HOME = process.env.LINTSURE_HOME_OVERRIDE || homedir(); // override is for tests
const BASE = join(HOME, ".lintsure", "agents");
const MANIFEST = join(BASE, "manifest.json");
// Skills folders other agents read. An agent counts as present when its config folder exists.
// shortcut: paths taken from each agent's docs as of 2026-11; add more with --dir until listed here.
const TARGETS = [
  { name: "Codex / OpenCode (~/.agents)", home: ".agents", skills: ".agents/skills" },
  { name: "Codex (~/.codex)", home: ".codex", skills: ".codex/skills" },
  { name: "Gemini CLI", home: ".gemini", skills: ".gemini/skills" },
];

const args = process.argv.slice(2);
const readManifest = () => { try { return JSON.parse(readFileSync(MANIFEST, "utf8")); } catch { return { folders: [] }; } };

export function install(dirs) {
  rmSync(BASE + "/plugin", { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  cpSync(SRC, join(BASE, "plugin"), { recursive: true });
  const hooks = pathToFileURL(join(BASE, "plugin", "hooks")).href;
  const m = readManifest(), written = new Set(m.folders);
  for (const dir of dirs) {
    for (const skill of readdirSync(join(SRC, "skills"))) {
      const to = join(dir, skill);
      // Never overwrite a folder of the same name that someone else put there.
      if (existsSync(to) && !written.has(to)) { console.log(`skip ${to} (exists, not ours)`); continue; }
      rmSync(to, { recursive: true, force: true });
      cpSync(join(SRC, "skills", skill), to, { recursive: true });
      for (const f of readdirSync(to).filter((f) => f.endsWith(".mjs"))) {
        const p = join(to, f);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll('"../../hooks/', `"${hooks}/`));
      }
      written.add(to);
    }
    console.log(`installed into ${dir}`);
  }
  writeFileSync(MANIFEST, JSON.stringify({ folders: [...written] }, null, 2));
}

export function uninstall() {
  const m = readManifest();
  for (const f of m.folders) rmSync(f, { recursive: true, force: true });
  rmSync(BASE, { recursive: true, force: true });
  console.log(`removed ${m.folders.length} skill folders and ${BASE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = args.indexOf("--dir");
  const dirs = i >= 0 ? [resolve(args[i + 1] ?? ".")]
    : TARGETS.filter((t) => existsSync(join(HOME, t.home))).map((t) => join(HOME, t.skills));
  if (args.includes("--uninstall")) uninstall();
  else if (args.includes("--list")) {
    for (const t of TARGETS) console.log(`${existsSync(join(HOME, t.home)) ? "found  " : "missing"} ${t.name}: ${join(HOME, t.skills)}`);
  } else if (!dirs.length) console.log("No supported agent found. Use --dir <skills folder>.");
  else install(dirs);
}
