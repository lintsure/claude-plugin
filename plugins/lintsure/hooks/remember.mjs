#!/usr/bin/env node
// Lintsure memory (SessionStart on startup, resume, clear and compaction, plus a light check on each prompt).
// Puts the project's rules, decisions, verified fixes and open high findings in front of the agent, so a long session
// that lost context carries on from what the project already decided. Short on purpose. Silent on any error.
import { createHash } from "node:crypto";
import { quiet, say, input, off, rules, state, report, projectsUnder } from "./lib.mjs";
import { profile, summary } from "./profile.mjs";
import { projectMap } from "./code.mjs";

/** Learn from corrections: when the user's message reads like a correction ("no, use green", "don't touch that",
 *  "I told you"), the agent is asked to do it and, if it sounds lasting, to offer once to save it as a rule.
 *  A second correction on the same topic makes the offer firmer. Word matching only; the agent and user decide. */
const CORRECTION = /^\s*(no\b|nope\b|wrong\b|stop\b|don'?t\b|do not\b|never\b|not like that|that'?s not|why did you|i said|i told you|please don'?t|instead\b|always\b|you forgot|you keep)|\b(instead of|i told you|again\?|not what i asked|should (always|never) be|from now on)\b/i;
const STOP = new Set("the a an to of and or in on for it is that this with be not no don't do never always use please i you we our my your just".split(" "));
function correction(s, said) {
  if (!CORRECTION.test(said) || said.length > 600) return "";
  const words = [...new Set(said.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])].filter((w) => !STOP.has(w));
  s.corrections ||= [];
  const again = s.corrections.find((c) => c.words.filter((w) => words.includes(w)).length >= 2);
  s.corrections.push({ words: words.slice(0, 12), at: Date.now() });
  s.corrections = s.corrections.slice(-20);
  const firm = again ? " The user has corrected you on this before in this session, so do offer it." : "";
  return `Lintsure: the user's message reads like a correction. Do what they ask. If it sounds like a lasting preference for this project, not just this one case, end your reply by offering once, in one line, to save it as a Lintsure rule (lintsure-rules skill). Don't offer if it's clearly a one-off.${firm}`;
}

// Also runs on every prompt (UserPromptSubmit), but only speaks when the rules changed or it has been 30 minutes,
// so a switch of model or a long stretch of work gets the rules again without repeating them on every message.
async function main() {
  if (off()) quiet();
  const inp = input(), prompt = inp.hook_event_name === "UserPromptSubmit";
  // shortcut: a word match on the user's own prompt, not a judgement of intent. Good enough to label a catch.
  const said = String(inp.prompt || "");
  let learn = "";
  {
    const st = state(inp.session_id);
    if (prompt) {
      st.s.override = /\b(overrid\w*|anyway|on purpose|ignore (the|that|this) rule|i know|i approve|i(?:.?ll| will) (add|write|do|fix|make) (it|that|this|them|the \w+) later)\b/i.test(said);
      learn = correction(st.s, said);
    } else if (["compact", "clear"].includes(inp.source)) st.s.whispered = {}; // the agent lost the earlier whispers
    st.save();
  }
  const d = await rules(inp.cwd || process.cwd(), !prompt), project = d.project.name;
  if (d.paused) quiet(); // supervision for this agent is paused in the workspace
  // Catches a person chose to revert in the dashboard: tell the agent once, then mark them passed on.
  const undo = (d.reverts || []).filter((x) => x.file);
  if (undo.length) {
    learn = [learn, `Lintsure: the user reviewed these changes in the Lintsure dashboard and chose Revert. Undo them now, then carry on:\n${undo.map((x) => `- ${x.file}${x.line ? `:${x.line}` : ""}: ${x.detail}`).join("\n")}`].filter(Boolean).join("\n");
    await report({ events: [], revertsSeen: undo.map((x) => x.id) });
  }
  const m = d.memory || {}, out = [];
  // Opened over several projects: say so once, so the agent knows each file is held to its own project's rules.
  let inside = []; try { inside = projectsUnder(inp.cwd || process.cwd()); } catch { /* fine */ }
  if (inside.length) out.push(`This folder holds ${inside.length} project${inside.length > 1 ? "s" : ""} with rules of their own: ${inside.join(", ")}. Lintsure checks each file against the rules of the project it is in.`);
  // The project's own profile first (local only): what it already has, so the agent builds with it, not around it.
  let prof = []; try { prof = summary(profile(inp.cwd || process.cwd())); } catch { /* fine */ }
  if (prof.length) out.push("What this project already has:", ...prof);
  // Where the project's functions live, so the agent uses them instead of searching or writing new ones.
  let map = []; try { map = projectMap(inp.cwd || process.cwd()); } catch { /* fine */ }
  if (map.length) out.push("Where the project's functions are (use these; no need to search for them):", ...map);
  const at = (x) => (x.file ? ` (${x.file}${x.line ? `:${x.line}` : ""})` : "");
  // Rules scoped to some files (a note or avoid rule with "when:") are shown when the agent edits one of those files,
  // so Memory only carries the rules that apply everywhere, plus protected files the agent must know about up front.
  const scoped = (d.rules || []).filter((r) => (r.kind === "note" || r.kind === "avoid") && r.paths), general = (d.rules || []).filter((r) => !scoped.includes(r));
  if (general.length) out.push("Rules you must keep to:", ...general.slice(0, 30).map((r) => `- ${r.text}${r.kind === "protect" ? ` [don't edit: ${r.paths}]` : ""}`));
  if (scoped.length) out.push(`- ${scoped.length} more rule${scoped.length > 1 ? "s apply" : " applies"} only to certain files (${[...new Set(scoped.map((r) => r.paths))].slice(0, 4).join("; ")}). Lintsure shows ${scoped.length > 1 ? "each" : "it"} when you edit one of those files.`);
  if (d.exceptions?.length) out.push("Agreed one-off exceptions (leave these as they are):", ...d.exceptions.slice(0, 10).map((x) => `- ${x.item}: ${x.after}`));
  if (m.decided?.length) out.push("Already decided, don't reopen or undo:", ...m.decided.slice(0, 15).map((x) => `- ${x.status === "accepted" ? "Accepted risk" : "Not a real problem"}: ${x.title}${at(x)}${x.reason ? `. ${x.reason}` : ""}`));
  if (m.verifiedFixes?.length) out.push("Fixed and verified, don't reintroduce:", ...m.verifiedFixes.slice(0, 15).map((x) => `- ${x.title}${at(x)}`));
  if (m.openHigh?.length) out.push("Open high findings:", ...m.openHigh.slice(0, 10).map((x) => `- ${x.title}${at(x)}`));
  // A rule that names a path this project doesn't have is probably out of date. Say so instead of enforcing it blindly.
  const root = inp.cwd || process.cwd(), { existsSync } = await import("node:fs"), { join } = await import("node:path");
  const stale = (d.rules || []).flatMap((r) => [...String(r.text).matchAll(/(?:^|[\s(`'"])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5})\b/gi)].map((m) => m[1]).filter((p) => !existsSync(join(root, p))).map((p) => `- "${r.text}" mentions ${p}, which doesn't exist in this project. Ask the user if the rule is out of date.`));
  if (stale.length) out.push("Rules that may be out of date:", ...stale.slice(0, 5));
  // Short index first (claude-mem's lesson): over the budget, each list keeps its first items and says how many more
  // there are and where to read them, so Memory never crowds out the agent's own context.
  const BUDGET = Number(process.env.LINTSURE_MEMORY_CHARS) || 3500;
  if (out.join("\n").length > BUDGET) {
    const kept = []; let used = 0, skipped = 0;
    const flush = () => { if (skipped) kept.push(`  (+${skipped} more: .lintsure/rules.yml, or ask for the full Lintsure memory)`); skipped = 0; };
    for (const l of out) {
      const item = l.startsWith("- ");
      if (!item) { flush(); kept.push(l); used += l.length + 1; continue; }
      if (used + l.length + 1 > BUDGET) { skipped++; continue; }
      kept.push(l); used += l.length + 1;
    }
    flush(); out.splice(0, out.length, ...kept);
  }
  if (!out.length) { if (learn) say({ hookSpecificOutput: { hookEventName: prompt ? "UserPromptSubmit" : "SessionStart", additionalContext: learn } }); quiet(); }
  // Said up front so the agent doesn't credit Lintsure with approval steps that come from elsewhere.
  const text = `Lintsure memory for ${project} (context to keep to, not a request for approval; Lintsure never needs the user's permission for you to work):\n${out.join("\n")}\nIf the user asks for something specific that goes against a rule or the brand (say "make it purple"), do it without asking and mention the rule in one line. Ask only when the request is unclear. Real content stays real: don't invent copy, quotes or prices. When you make such a one-off, record it with the lintsure-drift-guard skill (record-change) so later sessions leave it alone.`;
  const { s, save } = state(inp.session_id), h = createHash("sha256").update(text).digest("hex").slice(0, 16);
  if (prompt && s.memHash === h && Date.now() - (s.memAt || 0) < 30 * 60_000) { if (learn) say({ hookSpecificOutput: { hookEventName: prompt ? "UserPromptSubmit" : "SessionStart", additionalContext: learn } }); quiet(); }
  s.memHash = h; s.memAt = Date.now();
  // What this memory already told the agent: the heads-up before an edit won't repeat it (until compaction resets it).
  s.whispered ||= {};
  for (const [key, re] of [["brand", /^- Brand colours/], ["components", /^- Existing components/], ["content", /^- Real content/]]) if (prof.some((l) => re.test(l))) s.whispered[key] = 1;
  save();
  // Lets the Context page show what the agent was last told: size and the rule/memory counts, never the profile itself.
  await report({ events: [], context: { event: inp.hook_event_name || "SessionStart", source: inp.source || null, chars: text.length, rules: d.rules?.length || 0, decided: m.decided?.length || 0, fixes: m.verifiedFixes?.length || 0, profileLines: prof.length, mode: d.mode } });
  say({ hookSpecificOutput: { hookEventName: prompt ? "UserPromptSubmit" : "SessionStart", additionalContext: prompt ? `${text}\n(Lintsure: rules or memory changed, or it's been a while. Keep to them.)${learn ? `\n${learn}` : ""}` : `${text}${learn ? `\n${learn}` : ""}` } });
}
main().catch(quiet);
