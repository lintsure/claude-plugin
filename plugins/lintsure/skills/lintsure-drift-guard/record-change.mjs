#!/usr/bin/env node
// Records a change the user asked for that goes against a project rule: a one-off exception or a new standard.
// Usage: node record-change.mjs '{"scope":"one-off","value":"<the colour, font or component, e.g. #7c3aed>","ruleId":"<id or file:N>","before":"<old rule>","after":"<what changed>","item":"<file path>","reason":"<user's words>"}'
//        node record-change.mjs '{"scope":"undo","item":"<file path>","match":"<words from the exception, e.g. pink>"}'
// With no workspace key, it prints the line to add under the rule in .lintsure/rules.yml instead.
import { basename } from "node:path";
import { KEY, activity, report, project } from "../../hooks/lib.mjs";

let c = {};
try { c = JSON.parse(process.argv[2] || "{}"); } catch { console.log("Pass the change as one JSON argument."); process.exit(1); }
if (!c.after && c.scope !== "undo") { console.log('Missing "after": say what changed, in plain words.'); process.exit(1); }
const root = process.cwd(), p = project(root);
if (!KEY) {
  activity(root, { change: c }); // the local log still gets the decision
  console.log(c.scope === "standard" ? `No workspace key. Update the rule's "say:" line in .lintsure/rules.yml to: ${c.after}` : `No workspace key. Add this under the rule in .lintsure/rules.yml:\n    except: ${c.item || "<file>"}`);
  process.exit(0);
}
await report({ events: [], change: { ...c, project: p.name || basename(root) } });
console.log(c.scope === "undo" ? "Withdrawn: that one-off no longer applies, so Drift Guard checks the file normally again." : c.scope === "standard" ? "Recorded as the new standard. The user was notified." : "Recorded as a one-off exception. The user was notified and can keep it, make it the standard, or undo it.");
