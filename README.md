# Lintsure for Claude Code

**Catch your AI coding agent's mistakes before they ship.**

Open-source guardrails for Claude Code, plus Cursor, Gemini CLI and Codex through adapters. Lintsure keeps your agent working to the rules you set in `.lintsure/rules.yml`, asks you before destructive commands run, and checks the code it writes against the security and compliance standards you connect: OWASP, GDPR, the EU AI Act and more. Everything runs on your machine and sends nothing to lintsure.com. A hosted workspace (beta) is optional and only used when you add an API key.

**What it does in a session**

| Piece | What it does | When it runs |
| --- | --- | --- |
| Drift Guard | Checks each edit against your `.lintsure/rules.yml` (code to avoid, files to protect, no new dependencies) and against the code that exists: imports of missing files or packages, calls to functions that don't exist, copies of existing code, test tampering, lookalike packages, secrets | Before or after each Edit, Write and MultiEdit |
| Danger Guard | Sends risky commands to your permission prompt with the reason and a safer option: deleting (`rm -rf src`, `DROP TABLE`, `git push --force`, `git reset --hard`), printing or sending secrets (`cat .env`, `printenv`), turning off antivirus or clearing logs, making something start on its own, piping a download into a shell, and giving a container the host (`--privileged`, the Docker socket). It reads commands the way the shell runs them, so quoting, `sudo`, `bash -c` and `eval` don't hide them. Text that only mentions them, like `grep "rm -rf"`, passes | Before each shell command |
| Loop Guard | Tells the agent, once, when it has made the same call 5 times with no code change in between (the same failing command, the same file read again), so it changes approach. Edits reset the count. `LINTSURE_LOOP=off` turns it off | After each tool call |
| Threat Guard | Asks before the agent pulls in known AI attack tooling or infrastructure named in public advisories | Before shell commands and edits |
| Memory | Puts your rules, decisions and open findings back in front of the agent after a reset or compaction, kept short. A rule with `when:` files is shown only when the agent edits one of them | Session start and each prompt |
| End-of-task scan | One local scan against OWASP Top 10, OWASP LLM Top 10, CWE Top 25, GDPR, the EU AI Act and the EU CRA, when a session that changed files ends. Partial findings come with what to check first and the exact change when there is one | When the agent stops |
| Activity log | Writes each catch and decision to `.lintsure/activity.jsonl` (rule, file, line, outcome; never code or secrets). Files marked `lintsure:private` are left out. `npx lintsure export --otlp-json` turns it into an OpenTelemetry file | Whenever a guard catches something |
| `lintsure` MCP server | `scan`, `plan_checks`, `explain_rule`, `explain_framework`, `classify` | When the agent calls it |
| Skills | `lintsure-check`, `lintsure-prelaunch`, `lintsure-triage`, `lintsure-rules`, `lintsure-drift-guard` | Claude decides when they apply |

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
/plugin marketplace add lintsure/plugin
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
| `LINTSURE_ACTIVITY` | on | `off` stops writing `.lintsure/activity.jsonl`. |
| `LINTSURE_MEMORY_CHARS` | 3500 | How long Memory may get before lists are shortened to "(+N more)". |
| `LINTSURE_RECORD` | off | `1` saves each hook input (paths relative, keys masked) to `.lintsure/replay/inbox.jsonl`, for the guard replay test in `scripts/replay.mjs`. |
| `LINTSURE_URL` | `https://lintsure.com` | Workspace address (for local development: `http://127.0.0.1:8787`). |

## Try it locally

```bash
claude --plugin-dir ./plugins/lintsure
```

## What it doesn't do

- The guards are pattern checks on what the agent is about to do. They can miss things and they are not a sandbox: keep your normal permission settings.
- The end-of-task scan reads source files only. It doesn't test a running app or check your dependencies for known vulnerabilities.
- Lintsure reports what its checks found. It is not an audit, a certification or legal advice.
