#!/usr/bin/env node
// Lintsure Threat Guard (PreToolUse on Bash/PowerShell and Edit/Write/MultiEdit). Stops a coding agent from quietly
// pulling in or reaching for known AI attack tooling: the ARTEX framework and its forks, the tools seen next to it,
// and infrastructure named in public advisories. A match goes to the user's permission prompt ("ask") with the
// reason; nothing is refused outright, since authorized testers use some of these tools.
//
// Indicators come only from public sources:
//   FBI FLASH-20261113-001 "Threat Overview of ARTEX Autonomous Penetration Testing Framework" (TLP:CLEAR)
//   Censys, "ARTEX: Agentic Asbestos" (Nov 5, 2026)
// A match is a reason to look, not proof of an attack: IPs get reassigned, and the FBI asks to vet indicators first.
// Runs in every mode. Off with LINTSURE_THREAT=off.
import { quiet, say, input, rules, report, guardSetting } from "./lib.mjs";
import { segments } from "./danger.mjs";

const FBI = "FBI FLASH-20261113-001";
const CENSYS = "Censys, ARTEX: Agentic Asbestos";

// The framework itself: the original author's GitHub account, the repo name, and known rebrands.
const FRAMEWORK = [
  { re: /\bautumn-27\b/i, what: "the GitHub account that published the ARTEX attack framework", src: FBI },
  { re: /\bgithub\.com[/:][\w.-]+\/artex(?:[-_.]?pro)?(?:\.git)?(?=$|[\s/"'#?)])/i, what: "a copy or fork of the ARTEX attack framework", src: FBI },
  { re: /\bscope-?weaver\b/i, what: "ScopeWeaver, a rebrand of the ARTEX attack framework", src: CENSYS },
];
// Tools seen running with ARTEX in the advisories (remote-access trojans, C2 and post-exploitation kits).
const TOOLS = [
  { re: /\bvshell\b/i, what: "Vshell, a remote-access and C2 tool seen alongside ARTEX", src: `${FBI}; ${CENSYS}` },
  { re: /\badaptix[-_ ]?c2\b/i, what: "Adaptix C2, a command-and-control framework seen alongside ARTEX", src: `${FBI}; ${CENSYS}` },
  { re: /\bbloodalchemy\b/i, what: "BLOODALCHEMY, malware named in the ARTEX advisory", src: FBI },
  { re: /\bgodpotato\b/i, what: "GodPotato, a Windows privilege-escalation tool found on ARTEX servers", src: CENSYS },
  { re: /\binvoke-thehash\b/i, what: "Invoke-TheHash, a pass-the-hash kit found on ARTEX servers", src: CENSYS },
];
// Infrastructure the advisories name. Written plain here; the advisories write them defanged.
const IPS = ["38.244.50.120", "144.172.64.60", "144.172.64.99", "144.172.64.128", "187.15.88.186", "187.15.90.217", "187.15.89.186",
  "101.53.80.20", "205.214.59.31", "124.155.252.63", "154.201.79.246", "23.248.249.90", "23.158.220.98", "103.248.148.84", "203.160.133.172", "209.209.85.38",
  "199.19.95.66", "199.19.95.67", "199.19.95.68", "91.92.240.238", "85.11.168.45", "178.16.54.129", "31.77.229.35", "85.11.167.52"];
const DOMAINS = [{ re: /\bxcai\.pro\b/i, what: "xcai.pro, the LLM API reseller used in an ARTEX campaign", src: FBI }];

/** Everything in a piece of text that matches a published indicator. */
export function threats(text) {
  const t = String(text || ""), out = [];
  for (const x of [...FRAMEWORK, ...TOOLS, ...DOMAINS]) if (x.re.test(t)) out.push({ id: x.re.source, why: `Mentions ${x.what}.`, src: x.src });
  for (const ip of IPS) if (new RegExp(`(?<![\\d.])${ip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.])`).test(t)) out.push({ id: ip, why: `Contacts ${ip}, an address the advisory lists as ARTEX attack infrastructure.`, src: FBI });
  return out;
}

/** A command: the indicators above, plus sending command output or files to webhook.site (seen used to pull data out). */
export function threatCommand(cmd) {
  const found = threats(cmd);
  for (const seg of segments(String(cmd || ""))) {
    if (/webhook\.site/i.test(seg) && /^(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(seg) && /(?:\s-d\b|--data|\s-F\b|--form|--upload-file|-T\s|@|\$\(|`|-Body\b|-InFile\b)/.test(seg))
      found.push({ id: "webhook.site", why: "Sends data to webhook.site, a channel the advisory saw used to move stolen output out.", src: FBI });
  }
  return found;
}

// Writing about a threat isn't using it: notes, docs and this guard's own files are left alone.
const PROSE = /\.(?:md|mdx|txt|rst|adoc)$/i;
const SELF = /(?:^|\/)lintsure\/(?:plugin|site)\/|(?:^|\/)hooks\/threat\.mjs$|(?:^|\/)test\/drift-guard\.test\.mjs$/;
/** An edit: the indicators in the new text, skipping prose and Lintsure's own source. */
export function threatEdit(file, text) {
  const f = String(file || "").replace(/\\/g, "/");
  return PROSE.test(f) || SELF.test(f) ? [] : threats(text);
}

const newText = (tool, ti) => tool === "MultiEdit" ? (ti.edits || []).map((e) => e.new_string || "").join("\n") : tool === "Write" ? ti.content || "" : ti.new_string || "";

async function main() {
  if ((process.env.LINTSURE_THREAT || process.env.LINTSURE_HOOK || "").toLowerCase() === "off") quiet();
  const inp = input(), ti = inp.tool_input || {};
  const shell = inp.tool_name === "Bash" || inp.tool_name === "PowerShell";
  const found = shell ? threatCommand(ti.command) : ["Edit", "Write", "MultiEdit"].includes(inp.tool_name) ? threatEdit(ti.file_path, newText(inp.tool_name, ti)) : [];
  if (!found.length) quiet();
  let data = null; try { data = await rules(inp.cwd || process.cwd()); } catch { /* fine */ }
  const g = guardSetting(data, "threat");
  if (g.off) quiet();
  const project = data?.project.name || "";
  const seen = [...new Map(found.map((f) => [f.id, f])).values()];
  // Only what kind of indicator matched goes to the workspace, never the command or file contents.
  await report({ events: seen.map((f) => ({ kind: "threat", project, file: shell ? undefined : String(ti.file_path || "").split(/[\\/]/).pop(), detail: f.why, outcome: "caught" })) });
  const reason = `Lintsure Threat Guard: ${seen.map((f) => f.why).join(" ")} Source: ${[...new Set(seen.map((f) => f.src))].join("; ")}. A match is a reason to look, not proof of an attack. Allow it only if this is authorized security testing you expect.`;
  const full = `${reason}${g.note ? ` Team note: ${g.note}` : ""}`;
  say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: g.mode === 1 ? "deny" : "ask", permissionDecisionReason: g.mode === 1 ? `${full} Don't run or add it; tell the user what you were about to do.` : full } });
}
if (process.argv[1] && process.argv[1].endsWith("threat.mjs")) main().catch(quiet);
