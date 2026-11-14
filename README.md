# Lintsure for Claude Code

A Claude Code plugin and a workspace connector for the hosted Lintsure workspace (beta).

**Hosted or local?** The open-source Lintsure tool (`npx lintsure`, `@lintsure/mcp`) runs only on your machine, needs no account and sends nothing. This plugin adds the hosted workspace on lintsure.com: findings tracked over time, triage, decisions, verified fixes, agent tasks, site monitoring and a record of what broke and when. For that, the findings from your scans (check, file, line, fix, commit) are sent to your workspace. Your code is not, unless you turn on code excerpts. Full details: https://lintsure.com/docs/hosted

The workspace is in beta. Expect rough edges; many visual and operational improvements are on the way.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| `lintsure` MCP server | `scan`, `explain_rule`, `explain_framework`, `classify` | Your machine (`npx @lintsure/mcp`). Code never leaves it. |
| `lintsure-workspace` connector | Findings, decisions, tasks, verified fixes, scan reports | Hosted, `https://lintsure.com/mcp`, with your API key. Receives findings metadata, not code unless you turn on excerpts. |
| Skills | `lintsure-check` (when to scan while coding), `lintsure-ship` (pre-launch check), `lintsure-triage` (sort real from not) | Claude reads them and decides when to use them. |
| End-of-task hook | Scans locally when a task ends and reports the findings to the workspace. Stops Claude once for new high findings in files you changed; for the rest it stores them and leaves a short note. Silent when clean. | Scan on your machine; findings go to the workspace. |

## Install

```bash
/plugin marketplace add lintsure/claude-plugin
/plugin install lintsure@lintsure
```

Set your workspace key (create one at lintsure.com/app/keys) before starting Claude Code:

```bash
export LINTSURE_API_KEY=lsk_...
```

Without a key, everything local still works; only the workspace connector and reporting are off.

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

Lintsure reports what its checks found. It is not an audit, a certification or legal advice.
