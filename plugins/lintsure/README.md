# Lintsure

Lintsure keeps your coding agent on track and in context. It adds guards that run while the agent works, and it checks the code the agent writes.

- **Drift Guard** checks each edit against your project's rules in `.lintsure/rules.yml` and against the code that exists: imports of files that are not there, calls to functions that are not there, copies of existing code.
- **Danger Guard** sends a destructive command, such as deleting a source folder or dropping a table, to your permission prompt with the reason.
- **Threat Guard** asks before the agent pulls in known AI attack tooling.
- **Loop Guard** notices when the agent repeats the same call with nothing changing.
- **One check when a task ends** scans the changed files with 116 rules, mapped to the OWASP lists, the CWE Top 25, GDPR, the EU AI Act and the EU Cyber Resilience Act.

Everything runs on your machine. Without `LINTSURE_API_KEY` nothing is sent to lintsure.com. Lintsure is a readiness tool. It is not an audit, a certification or legal advice.

Full guide, settings and what it does not do: [the repository README](https://github.com/lintsure/plugin#readme) and [lintsure.com/docs/plugin](https://lintsure.com/docs/plugin).
