// Lintsure code checks: calls to things that don't exist, and copies of things that do.
// Built to stay quiet when unsure: a false note in Guide mode makes the agent change working code.
import { readFileSync, statSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { isPrivate } from "./lib.mjs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const SRC = /\.(m?[jt]sx?|cjs)$/i;
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
const lineOf = (text, needle) => { const i = text.indexOf(needle); return i < 0 ? 0 : text.slice(0, i).split("\n").length; };

/** The file an import points at, or null. Tries the usual extensions and index files, and .js imports of .ts files. */
export function resolveFile(base) {
  for (const x of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".vue", ".svelte", ".astro", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) if (isFile(base + x)) return base + x;
  if (/\.js$/.test(base) && isFile(base.replace(/\.js$/, ".ts"))) return base.replace(/\.js$/, ".ts");
  if (/\.js$/.test(base) && isFile(base.replace(/\.js$/, ".tsx"))) return base.replace(/\.js$/, ".tsx");
  return null;
}

/** Names a JS/TS file exports, or null when it can't tell (re-exports everything, CommonJS, not a source file). */
export function exportsOf(file) {
  if (!SRC.test(file)) return null;
  const src = read(file);
  if (src === null || /export\s*\*|module\.exports|exports\.[\w$]+\s*=|export\s*=/.test(src)) return null;
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|abstract\s+class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim(); if (n) names.add(n); }
  if (/export\s+default\b/.test(src) || /\bas\s+default\b/.test(src)) names.add("default");
  return names;
}

/** Named or default imports from the project's own files that those files don't export. */
export function missingExports(abs, text, whole) {
  const out = [];
  for (const m of text.matchAll(/import\s+(?!type\b)([^'";]*?)\s+from\s*['"](\.[^'"\n]+)['"]/g)) {
    const clause = m[1].trim(), spec = m[2];
    if (clause.startsWith("*")) continue;
    const target = resolveFile(resolve(dirname(abs), spec.split("?")[0]));
    if (!target) continue; // a missing file is the made-up-file check's job
    const ex = exportsOf(target);
    if (!ex) continue;
    const wanted = [];
    const named = clause.match(/\{([^}]*)\}/);
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (def) wanted.push(["default", def]);
    if (named) for (const part of named[1].split(",")) { const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim(); if (n && !/^type\s/.test(part.trim())) wanted.push([n, n]); }
    for (const [name, local] of wanted) {
      if (ex.has(name)) continue;
      const have = [...ex].filter((x) => x !== "default").slice(0, 8);
      out.push({ kind: "made_up", line: lineOf(whole, m[0]), detail: name === "default" ? `Imports ${local} as the default from "${spec}", but that file has no default export.` : `Imports ${name} from "${spec}", but that file doesn't export it.${have.length ? ` It exports: ${have.join(", ")}.` : ""}` });
    }
  }
  return out;
}

// Names that frameworks expect in many files, so a repeat means nothing.
const COMMON = new Set("handle handler default GET POST PUT PATCH DELETE HEAD OPTIONS ALL load prerender getStaticPaths getStaticProps getServerSideProps generateMetadata generateStaticParams metadata config middleware onRequest setup main init run render App Page Layout loader action meta links headers fetch scheduled test describe".split(" "));
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".astro", ".output", "coverage", ".wrangler", "vendor", "out"]);

/** Exported functions across the project, by name. Cached and rebuilt when any source file changes. */
function exportIndex(root) {
  const files = [];
  const go = (d, depth) => {
    if (files.length > 3000 || depth > 8) return;
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = join(d, e.name); if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) go(p, depth + 1); } else if (SRC.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name)) files.push(p); }
  };
  go(root, 0);
  const stamp = createHash("sha256").update(files.map((f) => { try { return `${f}:${statSync(f).mtimeMs}`; } catch { return f; } }).join("|")).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "lintsure-drift"), cache = join(dir, `exports-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.json`);
  try { const c = JSON.parse(readFileSync(cache, "utf8")); if (c.stamp === stamp) return c.index; } catch { /* rebuild */ }
  const index = {};
  for (const f of files) {
    const src = read(f); if (!src || src.length > 300_000) continue;
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?\s+([\w$]+)|const\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/g)) {
      const n = m[1] || m[2]; if (!n || COMMON.has(n)) continue;
      (index[n] ||= []).push(relative(root, f).replace(/\\/g, "/"));
    }
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(cache, JSON.stringify({ stamp, index })); } catch { /* fine */ }
  return index;
}

/** New exported functions in the added text whose name already exists in another file. */
export function duplicateFunctions(root, rel, text, whole) {
  if (!SRC.test(rel) || /\.(test|spec)\.|\.d\.ts$/.test(rel)) return [];
  const index = exportIndex(root), out = [];
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?\s+([\w$]+)|const\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/g)) {
    const n = m[1] || m[2];
    if (!n || COMMON.has(n)) continue;
    const elsewhere = (index[n] || []).filter((f) => f !== rel);
    if (elsewhere.length) out.push({ kind: "duplicate", line: lineOf(whole, m[0]), detail: `${n} already exists in ${elsewhere[0]}. Reuse it if it does the same thing.` });
  }
  return out;
}

// Shortcuts agents take when they're stuck. Counted in the edit's new text against what it replaced, so editing near
// an old shortcut doesn't flag it. Comments count as intent: `catch { /* optional file */ }` is not flagged.
const BAND_AIDS = [
  { re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g, say: "Adds an empty catch, so errors here are now hidden. If it covers a real failure, handle or fix it; if it's on purpose, say why in a comment." },
  { re: /@ts-ignore|@ts-nocheck|@ts-expect-error/g, say: "Switches off a type check (@ts-ignore or similar). Fix the type if you can." },
  { re: /eslint-disable(?:-next-line|-line)?\b/g, say: "Switches off a lint rule. Fix what it reports if you can." },
  { re: /\bas\s+any\b/g, say: "Casts to any, which hides type errors. Use the real type if you can." },
  { re: /new Promise\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\(|\bawait\s+(?:sleep|delay|wait)\(\s*\d|\btime\.sleep\(\s*\d/g, say: "Adds a fixed wait. If it papers over a timing problem, fix the cause instead." },
];
const TEST_SKIP = /\b(?:it|test|describe)\.(?:skip|only)\(|\bx(?:it|describe|test)\(/g;
const count = (s, re) => (String(s).match(re) || []).length;

/** before: the text this edit replaced (old_string, or the file's last committed version for a Write). */
export function bandAids(rel, added, before, whole) {
  if (!SRC.test(rel) || /\.d\.ts$/.test(rel)) return [];
  const out = [], lineAt = (re) => { re.lastIndex = 0; const m = re.exec(whole); return m ? lineOf(whole, m[0]) : 0; };
  for (const b of BAND_AIDS) if (count(added, b.re) > count(before, b.re)) out.push({ kind: "band_aid", line: lineAt(b.re), detail: b.say });
  if (/\.(test|spec)\.|(^|\/)tests?\//.test(rel) && count(added, TEST_SKIP) > count(before, TEST_SKIP)) out.push({ kind: "band_aid", line: lineAt(TEST_SKIP), detail: "Skips or isolates a test (.skip, .only, xit). Make the test pass instead of switching it off." });
  return out;
}

/** Where the project's own functions live, short enough to replace a search: at most 12 files and 40 names.
 *  Shared helpers (lib, utils, services) first, since those are the ones an agent goes looking for. */
export function projectMap(root, maxFiles = 12, maxNames = 40) {
  let index; try { index = exportIndex(root); } catch { return []; }
  const byFile = {};
  for (const [name, files] of Object.entries(index)) for (const f of files) (byFile[f] ||= []).push(name);
  const rank = (f) => (/(^|\/)(lib|utils?|helpers?|services?|shared|core)\//.test(f) ? 0 : 1);
  // Files marked lintsure:private are never named in Memory.
  const files = Object.keys(byFile).filter((f) => !isPrivate(root, f)).sort((a, b) => rank(a) - rank(b) || byFile[b].length - byFile[a].length || a.localeCompare(b)).slice(0, maxFiles);
  const out = []; let n = 0;
  for (const f of files) {
    if (n >= maxNames) break;
    const names = byFile[f].sort().slice(0, maxNames - n); n += names.length;
    out.push(`- ${f}: ${names.join(", ")}`);
  }
  return n >= 2 ? out : [];
}

// Test Guard: ways to make tests pass without fixing anything. Same idea as the shortcut checks: compare the new text
// with what it replaced, so only what this edit did counts.
const IS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|spec)\/|_test\.py$|(^|\/)test_[^/]+\.py$/;
const ASSERTS = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\bassert\s+(?!True\b)|\.should\b|\bt\.(?:is|deepEqual|true|false)\s*\(/g;
const TESTS = /\b(?:it|test)(?:\.(?:skip|only|todo))?\s*\(\s*['"`]|\bx(?:it|test)\s*\(\s*['"`]|\bdef\s+test_\w+/g; // a skipped test still counts as a test
const TRIVIAL = /expect\s*\(\s*(true|1|['"`][^'"`]*['"`])\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy)\s*\(\s*\1?\s*\)|\bassert\s+True\b|\bassert(?:\.ok)?\s*\(\s*true\s*\)|expect\s*\(\s*true\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/g;
const HARNESS = /process\.env\.(?:NODE_ENV\s*===?\s*['"]test['"]|VITEST\b|JEST_WORKER_ID\b)|['"]pytest['"]\s+in\s+sys\.modules|import\.meta\.vitest/g;

/** expect(x).toBe(y) and assert.equal(x, y): the expression and the expected value, to spot a changed expected value. */
function expectations(s) {
  const out = new Map();
  for (const m of String(s).matchAll(/expect\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(([^()]*)\)/g)) out.set(m[1].trim(), m[2].trim());
  for (const m of String(s).matchAll(/assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(([^,()]*(?:\([^()]*\))?[^,()]*),\s*([^()]*?)\)/g)) out.set(m[1].trim(), m[2].trim());
  return out;
}

export function testGuard(rel, added, before, whole) {
  const out = [];
  if (IS_TEST.test(rel)) {
    const lineAt = (re) => { re.lastIndex = 0; const m = re.exec(whole); return m ? lineOf(whole, m[0]) : 0; };
    const lostTests = count(before, TESTS) - count(added, TESTS), lostChecks = count(before, ASSERTS) - count(added, ASSERTS);
    if (lostTests > 0) out.push({ kind: "test", line: 0, detail: `Removes ${lostTests} test${lostTests > 1 ? "s" : ""}. If the code is wrong, fix the code; delete a test only if the user asked.` });
    else if (lostChecks > 0) out.push({ kind: "test", line: 0, detail: `Removes ${lostChecks} check${lostChecks > 1 ? "s" : ""} from the tests. Fix the code instead of removing what the test checks.` });
    if (count(added, TRIVIAL) > count(before, TRIVIAL)) out.push({ kind: "test", line: lineAt(TRIVIAL), detail: "Adds a check that can't fail (like expect(true).toBe(true)). It tests nothing." });
    const was = expectations(before), now = expectations(added);
    for (const [expr, val] of now) if (was.has(expr) && was.get(expr) !== val) { out.push({ kind: "test", line: lineOf(whole, expr), detail: `Changes what the test expects for ${expr.slice(0, 40)} (${was.get(expr).slice(0, 20)} to ${val.slice(0, 20)}). Only do that if the old value was wrong, not to match a bug.` }); break; }
  } else if (SRC.test(rel) && count(added, HARNESS) > count(before, HARNESS)) {
    out.push({ kind: "test", line: lineOf(whole, (added.match(HARNESS) || [""])[0]), detail: "Makes the code behave differently when tests run. Tests then check something other than what ships." });
  }
  return out;
}

// Package Guard. Offline: a new package whose name is one letter off a well-known or already-installed package.
// Online (on by default, off with LINTSURE_PACKAGES=offline): only the name and version of a package this edit adds go to
// the npm registry and OSV, the same lookup an install does: does it exist, how new, install scripts, known holes.
const POPULAR = "react react-dom next vue nuxt svelte astro angular express fastify koa hono axios lodash underscore moment dayjs date-fns zod yup joi ajv uuid nanoid chalk commander yargs dotenv cors helmet body-parser cookie-parser jsonwebtoken bcrypt bcryptjs passport mongoose sequelize prisma typeorm drizzle-orm knex pg mysql2 sqlite3 better-sqlite3 redis ioredis stripe openai @anthropic-ai/sdk aws-sdk @aws-sdk/client-s3 firebase supabase @supabase/supabase-js graphql apollo-server socket.io ws node-fetch cross-fetch got superagent cheerio puppeteer playwright jest vitest mocha chai sinon typescript ts-node tsx esbuild vite webpack rollup babel-loader @babel/core eslint prettier tailwindcss postcss autoprefixer sass styled-components @emotion/react classnames clsx framer-motion three d3 chart.js recharts rxjs immer redux @reduxjs/toolkit zustand jotai swr @tanstack/react-query react-router react-router-dom formik react-hook-form i18next sharp multer nodemailer winston pino morgan debug semver glob rimraf fs-extra mkdirp minimist inquirer ora execa cross-env concurrently nodemon pm2 husky lint-staged".split(" ");
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // swapped letters
  }
  return d[a.length][b.length];
}
const norm = (n) => n.toLowerCase().replace(/[-_.]/g, "");
export function lookalike(name, known) {
  if (known.includes(name) || name.replace(/^@[^/]+\//, "").length < 4) return null; // too short to tell a typo from a real name
  return known.find((k) => k !== name && (editDistance(name, k) === 1 || (norm(k) === norm(name)))) ?? null;
}
async function getJson(url, init) {
  try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) }); return r.status === 404 ? { missing: true } : r.ok ? await r.json() : null; } catch { return null; }
}
/** names: packages added in this edit, with their versions; installed: what package.json already had. */
export async function packageGuard(added, installed, whole, online = !["offline", "off"].includes((process.env.LINTSURE_PACKAGES || "").toLowerCase())) {
  const at = (n) => lineOf(whole, `"${n}"`);
  // Up to 10 packages per edit, checked side by side so a big edit still fits in the hook's time.
  const each = await Promise.all(added.slice(0, 10).map(async ([name, version]) => {
    const out = [];
    const twin = lookalike(name, [...new Set([...POPULAR, ...installed])]);
    if (twin) out.push({ kind: "package", line: at(name), detail: `Adds "${name}", one letter off the well-known "${twin}". Lookalike names are a common trick. Check it's the package you meant.` });
    if (!online || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return out;
    const meta = await getJson(`https://registry.npmjs.org/${name.replaceAll("/", "%2F")}`);
    if (meta?.missing) { out.push({ kind: "package", line: at(name), detail: `Adds "${name}", which doesn't exist on npm. It may be made up; someone could register that name later.` }); return out; }
    if (!meta) return out;
    const created = Date.parse(meta.time?.created || ""), latest = meta["dist-tags"]?.latest, v = meta.versions?.[latest] || {};
    if (created && Date.now() - created < 30 * 864e5) out.push({ kind: "package", line: at(name), detail: `Adds "${name}", first published less than 30 days ago. New packages are where most supply-chain attacks start.` });
    if (v.scripts?.preinstall || v.scripts?.install || v.scripts?.postinstall) out.push({ kind: "package", line: at(name), detail: `Adds "${name}", which runs a script when installed. Check what it does first.` });
    const ver = String(version || latest || "").replace(/^[^\d]*/, "");
    const osv = ver ? await getJson("https://api.osv.dev/v1/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package: { name, ecosystem: "npm" }, version: ver }) }) : null;
    if (osv?.vulns?.length) out.push({ kind: "package", line: at(name), detail: `Adds "${name}" ${ver}, which has ${osv.vulns.length} known security hole${osv.vulns.length > 1 ? "s" : ""} (${osv.vulns.slice(0, 2).map((x) => x.id).join(", ")}). Use a fixed version.` });
    return out;
  }));
  return each.flat();
}

// Scope Guard: files that shouldn't change as a side effect. Lock files by hand are a slip; CI and .env are the
// user's call (decision), unless they asked.
export function scopeGuard(rel, tool) {
  const name = rel.split("/").pop();
  if (/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/.test(name)) return [{ kind: "scope", line: 0, detail: `Edits ${name} by hand. Lock files are written by the package manager; change package.json and run the install instead.` }];
  if (/^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\//.test(rel)) return [{ kind: "scope", decide: true, line: 0, rule: "Change CI only when the task is about CI", detail: `Edits the CI pipeline (${rel}). Changes there can skip checks or expose secrets.` }];
  if (/^\.env(\.(?!example$|sample$|template$)[\w.-]+)?$/.test(name) && tool !== "Read") return [{ kind: "scope", decide: true, line: 0, rule: "Leave .env files to the user", detail: `Edits ${rel}, which holds this machine's secrets and settings.` }];
  return [];
}

// Secret Guard: keys and passwords written into code, tests or config. The finding never contains the secret itself.
const SECRETS = [
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "an AWS access key"],
  [/\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g, "a live Stripe key"],
  [/\bsk-ant-[\w-]{20,}/g, "an Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g, "an OpenAI API key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/g, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "a Slack webhook"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "a Google API key"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, "a private key"],
  [/\b(?:api[_-]?key|secret|passw(?:or)?d|token|auth)\w*["']?\s*[:=]\s*["'](?!(?:your|xxx|example|changeme|placeholder|test|dummy|\*{3}|<|\$\{))[^"'\s]{16,}["']/gi, "a password or key"],
];
export function secretGuard(rel, added, before) {
  if (/(^|\/)\.env(\.[\w.-]+)?$|\.(md|mdx|lock)$/.test(rel)) return [];
  const out = [];
  for (const [re, what] of SECRETS) if (!(what === "a password or key" && IS_TEST.test(rel)) && count(added, re) > count(before, re)) out.push({ kind: "secret", line: 0, detail: `Writes ${what} into ${rel}. Read it from an environment variable instead. If it's a real key, it should be replaced, since it's now in the file.` });
  return out.slice(0, 2);
}

// Privacy Guard: new personal data fields, and personal data written to logs.
const PII = /\b(e_?mail|phone(?:_?number)?|mobile|ssn|social_security\w*|date_?of_?birth|dob|birth_?date|home_?address|street_?address|passport\w*|national_?id|ip_?address|first_?name|last_?name|full_?name|credit_?card\w*|card_?number|iban)\b/gi;
export function privacyGuard(rel, added, before) {
  const out = [];
  const schema = /\.(sql|prisma)$|(^|\/)(schema|models?|entities|migrations?)\b/.test(rel);
  if (schema) {
    const field = (t) => new Set([...String(t).matchAll(PII)].map((m) => m[1].toLowerCase()));
    const was = field(before), fresh = [...field(added)].filter((f) => !was.has(f));
    if (fresh.length) out.push({ kind: "privacy", line: 0, detail: `Adds personal data (${fresh.slice(0, 4).join(", ")}). Keep it only if the feature needs it, and make sure the privacy notice covers it.` });
  }
  const LOGS = /\b(?:console\.(?:log|info|debug|warn|error)|log(?:ger)?\.(?:info|debug|warn|error|log)|log)\s*\(([^)]*)\)/g;
  const leaks = (t) => [...String(t).matchAll(LOGS)].filter((m) => /\b(password|passwd|token|secret|ssn|card_?number|e_?mail|phone)\b/i.test(m[1])).length;
  if (leaks(added) > leaks(before)) out.push({ kind: "privacy", line: 0, detail: "Writes personal data or a secret to the logs. Log an id instead, or mask the value." });
  return out;
}
