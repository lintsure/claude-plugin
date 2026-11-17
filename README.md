# Lintsure for Claude Code

Guardrails and local security and compliance checks for the code your coding agent writes. Everything runs on your machine and sends nothing to lintsure.com. A hosted workspace (beta) is optional and only used when you add an API key.

**What it does in a session**

| Piece | What it does | When it runs |
| --- | --- | --- |
| Drift Guard | Checks each edit against your `.lintsure/rules.yml` (code to avoid, files to protect, no new dependencies) and against the code that exists: imports of missing files or packages, calls to functions that don't exist, copies of existing code, test tampering, lookalike packages, secrets | Before or after each Edit, Write and MultiEdit |
| Danger Guard | Sends destructive commands (`rm -rf src`, `DROP TABLE`, `git push --force`, `git reset --hard`) to your permission prompt with the reason and a safer option. Text that only mentions them, like `grep "rm -rf"`, passes | Before each shell command |
| Threat Guard | Asks before the agent pulls in known AI attack tooling or infrastructure named in public advisories | Before shell commands and edits |
| Memory | Puts your rules, decisions and open findings back in front of the agent after a reset or compaction | Session start and each prompt |
| End-of-task scan | One local scan against OWASP Top 10, OWASP LLM Top 10, CWE Top 25, GDPR, the EU AI Act and the EU CRA, when a session that changed files ends | When the agent stops |
| `lintsure` MCP server | `scan`, `explain_rule`, `explain_framework`, `classify` | When the agent calls it |
| Skills | `lintsure-check`, `lintsure-ship`, `lintsure-triage`, `lintsure-rules`, `lintsure-drift-guard` | Claude decides when they apply |

The guards are deterministic pattern checks, not an AI model: fast, the same every time. They are seatbelts, not a sandbox. Not an audit or legal advice.

**Other agents.** The same guards run in Cursor (`cursor/hooks.json`), Gemini CLI (`gemini/hooks.json`) and Codex (`codex/hooks.json`) through small adapters, so every agent checks the same things.

**Skills in other agents.** The skills are standard `SKILL.md` folders. From a clone of this repo, one command copies them to every agent it finds (Codex and OpenCode in `~/.agents/skills`, Codex in `~/.codex/skills`, Gemini CLI in `~/.gemini/skills`):

```bash
node scripts/install-skills.mjs            # install for the agents found
node scripts/install-skills.mjs --list     # see where, change nothing
node scripts/install-skills.mjs --dir PATH # any other skills folder
node scripts/install-skills.mjs --uninstall
```

It records what it wrote, never overwrites a folder that isn't its own, and uninstall removes only those folders.

## Install

```bash
/plugin marketplace add lintsure/claude-plugin
/plugin install lintsure@lintsure
```

**Local (no account):** that's it. Without `LINTSURE_API_KEY`, nothing goes to lintsure.com: no rules sync, no reports, no connection to the hosted workspace. Your rules come from `.lintsure/rules.yml` in your repo. The only things that leave your machine are the ones any npm user already does: `npx` downloads the engine, and Package Guard looks up the name and version of a package your agent adds on npm and OSV (turn that off with `LINTSURE_PACKAGES=offline`).

**Hosted workspace (beta):** set your key (create one at lintsure.com/app/keys) before starting Claude Code, and add the workspace connector:

```bash
export LINTSURE_API_KEY=lsk_...
claude mcp add --transport http lintsure-workspace https://lintsure.com/mcp --header "Authorization: Bearer $LINTSURE_API_KEY"
```

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `LINTSURE_API_KEY` | none | Connects the workspace connector and lets the hook report scans and respect decisions. |
| `LINTSURE_HOOK` | on | `off` disables the end-of-task check. |
| `LINTSURE_URL` | `https://lintsure.com` | Workspace address (for local development: `http://127.0.0.1:8787`). |

## Try it locally

```bash
claude --plugin-dir ./plugins/lintsure
```

## What it doesn't do

- The guards are pattern checks on what the agent is about to do. They can miss things and they are not a sandbox: keep your normal permission settings.
- The end-of-task scan reads source files only. It doesn't test a running app or check your dependencies for known vulnerabilities.
- Lintsure reports what its checks found. It is not an audit, a certification or legal advice.
