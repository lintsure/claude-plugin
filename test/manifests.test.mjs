// Each agent reads its own manifest. They must all name the same plugin and version, and point at files that exist.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const at = (p) => new URL(`../${p}`, import.meta.url);
const json = (p) => JSON.parse(readFileSync(at(p), "utf8"));
const P = "plugins/lintsure";

test("every manifest names the same plugin and version", () => {
  const claude = json(`${P}/.claude-plugin/plugin.json`);
  for (const f of [`${P}/.cursor-plugin/plugin.json`, `${P}/.codex-plugin/plugin.json`, "gemini-extension.json"]) {
    const m = json(f);
    assert.equal(m.name, claude.name, f);
    assert.equal(m.version, claude.version, f);
  }
});

test("each marketplace file points at the plugin folder", () => {
  assert.ok(existsSync(at(`${json(".cursor-plugin/marketplace.json").plugins[0].source}/.cursor-plugin/plugin.json`)));
  assert.ok(existsSync(at(`${json(".agents/plugins/marketplace.json").plugins[0].source.path}/.codex-plugin/plugin.json`)));
  assert.ok(existsSync(at(`${json(".claude-plugin/marketplace.json").plugins[0].source}/.claude-plugin/plugin.json`)));
});

test("the hooks and MCP files a manifest names exist", () => {
  const cursor = json(`${P}/.cursor-plugin/plugin.json`), codex = json(`${P}/.codex-plugin/plugin.json`);
  for (const f of [cursor.hooks, cursor.mcpServers, cursor.logo, codex.hooks, codex.mcpServers, codex.skills]) assert.ok(existsSync(at(`${P}/${f}`)), f);
});

test("Gemini CLI's hooks at the top of the repo are the plugin's own, and every script they run exists", () => {
  const top = readFileSync(at("hooks/hooks.json"), "utf8");
  assert.equal(top, readFileSync(at(`${P}/gemini/hooks.json`), "utf8").split("${extensionPath}/hooks/").join("${extensionPath}/plugins/lintsure/hooks/"));
  const scripts = [...top.matchAll(/\$\{extensionPath\}\/([\w./-]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.ok(existsSync(at(s)), s);
  assert.deepEqual(json("gemini-extension.json").mcpServers, json(`${P}/.mcp.json`).mcpServers);
});
