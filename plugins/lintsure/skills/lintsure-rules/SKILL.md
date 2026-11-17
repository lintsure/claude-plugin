---
name: lintsure-rules
description: Use when the user wants to set up, suggest, add or see Lintsure rules for a project ("Lintsure, suggest rules", "Lintsure: never let it skip tests", "what rules do we have"), or share them with other agents ("make Cursor follow these too"). Suggests rules from what the project already has, lets the user keep, edit or drop them, and writes the kept ones to .lintsure/rules.yml.
---

# Lintsure rules

Rules live in `.lintsure/rules.yml` in the repo, so every agent and every session uses the same ones. Run the helper next to this skill from the project folder: `node "<this skill's base directory>/rules.mjs" <command>`.

## Suggest rules for a project

1. Run `rules.mjs suggest`. It lists suggestions in plain words, each with why it was suggested, and ends with a JSON line.
2. Show the user the numbered list as it is, in plain words. Ask once: "Which should I keep? You can also change the wording of any." Don't ask about each one separately.
3. You may add up to 3 suggestions of your own from reading the code. Each needs a `file:line` and must be labelled "my suggestion", not Lintsure's.
4. Write only what the user kept: `rules.mjs write '<json array>'`, taking the kept items from the JSON line (with the user's wording if they changed it). Then show what was added.
5. Never write a rule the user didn't agree to.

## The user states a rule in normal words

For example "Lintsure: never let it touch the payment code" or "always use our logger".

1. Turn it into one rule. Pick the kind:
   - `protect` with `paths` when it's about files or folders not being changed.
   - `avoid` with a `pattern` (a regular expression) and optional `in` (files) when it's about code that must not be added.
   - `deps` for "ask before adding packages".
   - `note` when it can't be checked from the code ("keep the checkout simple"). Say honestly that this one is a reminder Lintsure can't check.
2. Tell the user in one plain sentence what will be caught, for example "I'll flag any change to files in src/payments/." Then write it with `rules.mjs write`.

## Show the rules

Run `rules.mjs list` and show the list.

## Share the rules with other agents

Other agents (Cursor, Codex, Copilot, and Claude Code without the plugin) read their own instruction files. When the user wants them to follow the same rules, or after setting up rules for the first time, offer once:

1. Run `rules.mjs sync`. It writes the rules to `AGENTS.md` and `.cursor/rules/lintsure.mdc`, plus `.github/copilot-instructions.md` and `CLAUDE.md` if those files exist. To pick, pass targets: `rules.mjs sync agents,cursor,copilot,claude`.
2. In shared files Lintsure only writes its own marked block; the user's text stays as it is. Tell the user which files changed.
3. After that, adding a rule with `rules.mjs write` keeps those files in step by itself.
4. To take it out again: `rules.mjs unsync`.

Be honest about what this does: other agents read the rules as instructions. Lintsure checks them automatically only in Claude Code with this plugin (CI checks come with the next engine release).

## Notes

- Suggestions are guesses from files that exist (a migrations folder, a logger file). Say "suggested because", never "found in your code".
- Everything here stays on this machine. Rules for the whole team or other projects go on the workspace Rules page.
- Protected folders still allow new files (a new migration), only changes to existing ones are caught.
