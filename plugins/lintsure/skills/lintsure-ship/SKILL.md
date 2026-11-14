---
name: lintsure-ship
description: Run a full Lintsure pre-launch check when the user says they are about to ship, launch, deploy, go live, open a pull request for release, or answer a security questionnaire. Scans the whole project once, summarises what to fix first, and records the result in the Lintsure workspace.
---

# Lintsure pre-launch check

Use this once, at a shipping moment. It reports what Lintsure's checks found; it is not an audit or legal advice.

1. Run the `scan` tool from the `lintsure` MCP server on the whole project (no `files`).
2. If the `lintsure-workspace` connector is available, call `lintsure_get_decisions` and leave out decided findings.
3. Give the user a short summary:
   - High findings first, each as title, file:line and the fix. Offer to fix them one by one.
   - Then a count of medium and low findings, and the frameworks they map to.
   - One line on what the scan does not cover (for example: business logic, infrastructure, anything outside this repo).
4. Report the scan with `lintsure_report_scan` (commit, check ids that ran, findings metadata, never code).
5. After fixes, scan the changed files again and report again, so the workspace marks the fixes as verified.

For a security questionnaire, point the user to their workspace's Reports page: it lists what was checked, when and at which commit.
