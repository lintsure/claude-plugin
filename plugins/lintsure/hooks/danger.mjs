#!/usr/bin/env node
// Lintsure Danger Guard (PreToolUse on Bash). Destructive commands go to the user's permission prompt ("ask") with the
// reason and a safer option, before they run. Nothing is refused outright and nothing else is slowed down.
// Tells running a command apart from text that mentions it: `grep "rm -rf"` and `echo "DROP TABLE"` are fine.
// Runs in every Drift Guard mode. With a workspace, the Guards page can turn it off or switch it to "Tells agent"
// (the command is refused and the agent uses the safer way). Off with LINTSURE_DANGER=off.
import { quiet, say, input, rules, report, guardSetting, holdAnswer } from "./lib.mjs";

/** Split a command line into simple commands, keeping quoted text intact. */
export function segments(cmd) {
  const out = []; let cur = "", q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== "\\") q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ";" || c === "\n" || c === "|" || c === "&") { if (cur.trim()) out.push(cur.trim()); cur = ""; if (cmd[i + 1] === c) i++; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unquote = (s) => s.replace(/'[^']*'|"[^"]*"/g, (m) => " ");
const dq = (t) => t.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
const WRAP = /^(?:sudo|doas|time|nohup|command|builtin|exec|nice|ionice|stdbuf|timeout|chrt|xargs|env|unbuffer)$/;
/** One simple command as the shell would run it: leading NAME=value, wrappers (sudo, env, nice, xargs...) and
 *  quoting or paths on the program name are taken off, so `"rm"`, `r''m`, `\rm`, `/bin/rm` and `sudo nice rm` all read as rm.
 *  `bash -c '...'` and `eval ...` hand back their payload to check. A program name built from a variable is `dynamic`. */
export function norm(raw) {
  let s = raw.trim();
  for (let i = 0; i < 8; i++) {
    s = s.replace(/^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)(?:\s+|$))+/, "");
    const m = s.match(/^(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/);
    if (!m) return null;
    const tok = m[0], rest = s.slice(tok.length);
    const word = tok.replace(/\\(.)/g, "$1").replace(/['"]/g, "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    if (WRAP.test(word)) { s = rest.trim().replace(/^(?:(?:-[ugnCpk]\s+\S+|-\S+|\d+(?:\.\d+)?[smhd]?)(?:\s+|$))*/, ""); continue; }
    if (/^(?:ba|z|da|k|a)?sh$/.test(word)) { const c = rest.match(/^\s+(?:-\w+\s+)*?-\w*c\w*\s+('[^']*'|"(?:[^"\\]|\\.)*"|\S+)/); if (c) return { inner: dq(c[1]) }; }
    if (word === "eval") return { inner: dq(rest) };
    return { seg: word + rest, bare: word + unquote(rest), word, dynamic: /[$`]/.test(tok) };
  }
  return null;
}
// Files that hold secrets: .env files (not the shared .example/.sample/.template), SSH and TLS keys, cloud and npm credentials.
const SECRET_FILE = /(?:^|[\s/\\'"=@])(?:\.env(?:\.(?!example|sample|template|dist)[\w-]+)?|\.dev\.vars|id_(?:rsa|ed25519|ecdsa)|[\w-]+\.(?:pem|key|p12|pfx)|\.aws[/\\]credentials|\.netrc|\.npmrc|\.pgpass|credentials\.json|service-account[\w-]*\.json)(?=$|[\s'"|;&)])/i;
// A variable whose name says it holds a secret: $STRIPE_SECRET_KEY, ${API_TOKEN}, $env:OPENAI_API_KEY, os.environ["DB_PASSWORD"].
const SECRET_VAR = /\$(?:env:)?\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|PRIVATE)[A-Z0-9_]*\}?/i;
const SAFE_RM = /^(?:\.?\/)?(?:node_modules|dist|build|out|\.next|\.astro|\.turbo|\.cache|coverage|tmp|temp|\.wrangler\/tmp)(?:\/|$)|^\/tmp\/|\$TMPDIR|%TEMP%/;
const SQL_TOOL = /^(?:psql|mysql|sqlite3|mariadb|duckdb|cockroach|(?:npx\s+)?wrangler\s+d1\s+execute|supabase\s+db|prisma\s+db\s+execute)\b/;

/** Each finding: what it would do, and a safer way. Empty when the command is fine. */
export function danger(cmd) {
  const found = [], add = (id, why, safer) => found.push({ id, why, safer });
  // Download piped straight into a shell: checked on the whole line, since segments() splits at the pipe.
  if (/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|iex|Invoke-Expression|python3?|node)\b/i.test(unquote(String(cmd || ""))))
    add("pipe-run", "Downloads a script and runs it straight away, without anyone seeing what it does.", "Download it to a file, read it, then run it.");
  const queue = segments(String(cmd || "")).map((s) => [s, 0]);
  for (let qi = 0; qi < queue.length; qi++) {
    const [raw, depth] = queue[qi], n = norm(raw);
    // Dumping every environment variable puts all the keys in the agent's context and transcript.
    if (/^\s*(?:printenv|env|set)\s*$|^\s*(?:Get-ChildItem|gci|dir|ls)\s+env:\s*$/i.test(raw)) add("secrets-out", "Prints every environment variable, keys included, into the conversation.", "Print only the one variable you need, or check that it's set with [ -n \"$NAME\" ].");
    if (!n) continue;
    if (n.inner != null) { if (depth < 3) queue.push(...segments(n.inner).map((s) => [s, depth + 1])); continue; }
    const { seg, bare, word } = n;
    // A program name we can't read (a variable or $(...)) with delete-style flags: ask rather than guess it's fine.
    if (n.dynamic && /\s(?:-\w*[rRf]\w*|--force|--recursive|-delete)\b/.test(bare)) add("unclear", "Runs a command whose name comes from a variable, with delete-style flags, so it can't be checked.", "Write the command out in full.");
    if (word === "find" && /\s-delete\b|\s-exec(?:dir)?\s+(?:\S*\/)?rm\b/.test(bare)) add("rm", "Deletes every file the search matches, for good.", "Run the find without -delete first to see what it matches.");
    if (word === "rm" && /\s-\w*[rR]/.test(bare)) {
      const targets = bare.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"));
      if (!targets.length || targets.some((t) => !SAFE_RM.test(t))) add("rm", `Deletes ${targets.join(" ") || "files"} for good, with everything inside.`, "Delete specific files, or move them aside first so you can undo.");
    }
    if (/^(?:Remove-Item|rd|rmdir)\b/i.test(word) && /-Recurse|\/s\b/i.test(bare)) add("rm", "Deletes a folder and everything in it for good.", "Delete specific files, or move the folder aside first.");
    if (word === "git") {
      if (/\breset\s+--hard\b/.test(bare)) add("git-reset", "Throws away all uncommitted changes.", "Run git stash first, so the changes can come back.");
      if (/\bclean\s+-\w*f/.test(bare)) add("git-clean", "Deletes untracked files for good.", "Run git clean -n first to see what would go.");
      if (/\bpush\b.*(?:\s--force(?!-with-lease)\b|\s-f\b)/.test(bare)) add("git-force", "Overwrites the remote branch, which can erase other people's commits.", "Use --force-with-lease, or push to a new branch.");
      if (/\b(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/.test(bare)) add("git-discard", "Throws away all changes in the working folder.", "Run git stash first, or restore only the files you mean.");
      if (/\bbranch\s+-D\b/.test(bare)) add("git-branch", "Deletes a branch even if it isn't merged.", "Use git branch -d, which refuses unmerged branches.");
      if (/\bstash\s+(?:drop|clear)\b/.test(bare)) add("git-stash", "Deletes saved stashes for good.", "Check git stash list first.");
    }
    // SQL only counts when it goes to a database tool, not when it's text in grep or echo.
    if (SQL_TOOL.test(bare) || /^(?:psql|mysql|sqlite3)\b/.test(word)) {
      if (/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\b)/i.test(seg)) add("sql-drop", `Deletes a table or database${/--remote\b/.test(seg) ? " in production" : ""}.`, "Back it up first, or do it in a migration the user reviews.");
      if (/\bDELETE\s+FROM\s+\w+(?![^;]*\bWHERE\b)/i.test(seg)) add("sql-delete", "Deletes every row in a table (no WHERE).", "Add a WHERE clause, or back the table up first.");
    }
    if (/\bwrangler\s+d1\s+delete\b|\bdocker\s+system\s+prune\b|\bkubectl\s+delete\s+(?:ns|namespace)\b|\bterraform\s+destroy\b|\baws\s+s3\s+rb\b.*--force/.test(bare)) add("infra", "Deletes infrastructure or data that can't be brought back.", "Check with the user first and make a backup.");
    // A container given the host: privileged, the host's Docker socket, or the host's root folder.
    if (/^(?:docker|podman|nerdctl)$/i.test(word) && /\s(?:run|create)\b/.test(bare) && (/\s--privileged\b/.test(bare) || /(?<!unix:\/)\/var\/run\/docker\.sock|\/\/\.\/pipe\/docker_engine/.test(seg) || /\s(?:-v|--volume|--mount)[\s=](?:type=bind,\s*source=)?\/:\//.test(seg)))
      add("docker-host", "Starts a container with control of this machine (privileged, the Docker socket, or the whole disk mounted).", "Run it without --privileged and without mounting /var/run/docker.sock or /; mount only the folder it needs.");
    // Secrets leaving their file: shown to the agent (and its transcript), or sent somewhere.
    if (/^(?:cat|type|more|less|head|tail|bat|nl|Get-Content|gc|grep|egrep|rg|findstr|Select-String|sls|awk|sed|cut|strings|xxd|od|base64|cp|copy|Copy-Item|scp)$/i.test(word) && SECRET_FILE.test(/^(?:cp|copy|Copy-Item|scp)$/i.test(word) ? seg.replace(/\s+\S+\s*$/, "") : seg))
      add("secrets-out", "Shows or copies a file that holds secrets, so its keys end up in the conversation or somewhere new.", "Check only the key names (for example cut -d= -f1 .env), or ask the user for the one value you need.");
    if (/^(?:echo|printf|Write-Output|Write-Host|print|printenv)$/i.test(word) && (SECRET_VAR.test(seg) || (word === "printenv" && /\s[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|CREDENTIALS?)\w*\b/i.test(seg))))
      add("secrets-out", "Prints a secret value into the conversation.", "Check that it's set without printing it, for example [ -n \"$NAME\" ] && echo set.");
    if (/^(?:curl|wget|http|https|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|nc|ncat)$/i.test(word) && (/(?:@|--upload-file\s+|-T\s+|-InFile\s+)\S*(?:\.env\b(?!\.(?:example|sample|template))|id_rsa|\.pem\b|credentials\b|\.netrc\b)/i.test(seg) || SECRET_VAR.test(seg) && /\s(?:-d|--data\S*|-F|--form|-Body)\b/i.test(seg)))
      add("secrets-out", "Sends secrets from this machine to a web address.", "Don't send keys anywhere; if a service needs one, ask the user to set it there.");
    if (/(?:^|\s)>\s*\.env(?:\.\w+)?(?:\s|$)/.test(bare) || (word === "rm" && /(?:^|\s)\.env\b/.test(bare))) add("env", "Wipes the .env file with its secrets.", "Back it up, or edit only the line you need.");
    // Attacker-style commands: no app needs these to build or test, so the user decides.
    const ps = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(word);
    if (ps && /\s-(?:e|ec|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i.test(bare)) add("ps-hidden", "Runs PowerShell from base64, so nobody can read what it does.", "Run the plain command instead.");
    else if (ps && /\s-(?:w|win|window|windowstyle)\s+hidden\b/i.test(bare)) add("ps-hidden", "Runs PowerShell in a hidden window.", "Run it in the open.");
    if (/^(?:Set-MpPreference|Add-MpPreference)$/i.test(word) && /-Disable\w+|-Exclusion\w+/i.test(bare)) add("defender", "Turns off or carves holes in Windows Defender.", "Leave Defender on; ask the user to add an exclusion themselves if it's really needed.");
    if (/^netsh$/i.test(word) && /\bfirewall\b.*\b(?:add|set)\b/i.test(bare) || /^(?:New-NetFirewallRule|Set-NetFirewallProfile)$/i.test(word) || /fDenyTSConnections/i.test(seg) || /^Enable-PSRemoting$/i.test(word)) add("firewall", "Opens the firewall or remote access on this machine.", "Ask the user to change firewall or remote access themselves.");
    if (/^wevtutil$/i.test(word) && /\s(?:cl|clear-log)\b/i.test(bare) || /^(?:Clear-EventLog|Remove-EventLog)$/i.test(word) || (word === "history" && /\s-c\b/.test(bare)) || /^unset\s+HISTFILE\b|^(?:export\s+)?HIST(?:FILE)?SIZE=0\b/.test(bare) || /ConsoleHost_history\.txt|\.(?:bash|zsh)_history\b/.test(seg) && /^(?:rm|del|Remove-Item|Clear-Content|truncate)$/i.test(word)) add("wipe-logs", "Clears logs or shell history, which hides what was done.", "Leave logs and history alone.");
    if (/^schtasks(?:\.exe)?$/i.test(word) && /\/create\b/i.test(bare) || /^(?:Register-ScheduledTask|Register-ScheduledJob|New-Service)$/i.test(word) || /^sc(?:\.exe)?$/i.test(word) && /\screate\b/i.test(bare) || word === "crontab" && !/\s-l\b/.test(bare) || /^(?:reg(?:\.exe)?\s+add|New-ItemProperty|Set-ItemProperty)\b/i.test(bare) && /CurrentVersion\\Run|Winlogon|\\Services\\/i.test(seg) || /__EventFilter|CommandLineEventConsumer|__FilterToConsumerBinding/.test(seg) || /Start Menu\\Programs\\Startup|Library\/Launch(?:Agents|Daemons)|\/etc\/cron|systemctl\s+enable\b/i.test(seg) && !/^(?:ls|cat|dir|Get-\w+|grep|rg|find)$/i.test(word)) add("persist", "Makes something start by itself (a scheduled task, service, startup entry or cron job).", "Ask the user before adding anything that runs on its own.");
    if (/^certutil(?:\.exe)?$/i.test(word) && /-urlcache|-decode/i.test(bare) || /^bitsadmin(?:\.exe)?$/i.test(word) && /\/transfer\b/i.test(bare) || /^(?:mshta|regsvr32|rundll32)(?:\.exe)?$/i.test(word) && /https?:|\/i:/i.test(seg)) add("lolbin", "Uses a Windows system tool to download or run code, a common way to sneak past antivirus.", "Download with a normal tool into the project and check it first.");
    if (/\blsass\b/i.test(seg) && /^(?:procdump|rundll32|Get-Process|tasklist)/i.test(word) && /MiniDump|-ma\b|\.dmp\b/i.test(seg) || /\b(?:mimikatz|sekurlsa|lazagne)\b/i.test(bare)) add("creds", "Copies passwords out of memory or the system.", "Stop; this isn't something a coding task needs.");
    if (/^(?:winget|choco|brew|apt(?:-get)?|snap|npm|scoop)\b/.test(word) && /\binstall\b/.test(bare) && /\b(?:anydesk|teamviewer|rustdesk|screenconnect|atera|ngrok|cloudflared|tailscale)(?=[\s.@]|$)/i.test(bare)) add("remote-access", "Installs a tool that gives remote access to this machine.", "Ask the user to install remote-access tools themselves.");
    if (/(?:^|[\s>])(?:\/etc\/hosts|\S*drivers\\etc\\hosts)\b/i.test(seg) && /^(?:tee|echo|printf|Add-Content|Set-Content|Out-File|sed)$/i.test(word) || />>?\s*(?:\/etc\/hosts|\S*drivers\\etc\\hosts)/i.test(seg)) add("hosts", "Changes the hosts file, which redirects web addresses for the whole machine.", "Use a local config or .env value instead.");
    if (/^(?:python3?|node|ruby|perl)\b/.test(word) && /\s-[ce]\s/.test(seg) && /\b(?:shutil\.rmtree|os\.remove|os\.unlink|rmSync|rmdirSync|unlinkSync|rimraf|FileUtils\.rm_rf)\b/.test(seg)) add("inline", "Runs a script that deletes files.", "Delete specific files you can name, or move them aside first.");
  }
  return found;
}

async function main() {
  if ((process.env.LINTSURE_DANGER || process.env.LINTSURE_HOOK || "").toLowerCase() === "off") quiet();
  const inp = input();
  if (inp.tool_name !== "Bash" && inp.tool_name !== "PowerShell") quiet();
  let data = null; try { data = await rules(inp.cwd || process.cwd()); } catch { /* fine */ }
  // The workspace circuit breaker: a shell command can write too, so it waits for the user like an edit does.
  const h = holdAnswer(data); if (h) say(h);
  const found = danger(inp.tool_input?.command);
  if (!found.length) quiet();
  const g = guardSetting(data, "danger");
  if (g.off) quiet();
  const project = data?.project.name || "";
  // Only which kind of command it was goes to the workspace, never the command (it can hold paths or secrets).
  await report({ events: found.map((f) => ({ kind: "danger", project, detail: f.why, outcome: g.mode === 1 ? "refused" : "caught" })) });
  const why = `Lintsure Danger Guard: ${found.map((f) => `${f.why} Safer: ${f.safer}`).join(" ")}${g.note ? ` Team note: ${g.note}` : ""}`;
  // Guards page: "Asks user" (default) asks before running; "Tells agent" refuses and the agent uses the safer way.
  say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: g.mode === 1 ? "deny" : "ask", permissionDecisionReason: g.mode === 1 ? `${why} Use the safer way instead.` : why } });
}
if (process.argv[1] && process.argv[1].endsWith("danger.mjs")) main().catch(quiet);
