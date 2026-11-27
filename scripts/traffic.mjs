#!/usr/bin/env node
// Who uses the site: people, their AI agents, crawlers and scripts, from the Analytics Engine
// dataset the Worker writes one data point per request to (worker/src/reqlog.ts, kept ~3 months).
//
//   node scripts/traffic.mjs                  # last 7 days
//   node scripts/traffic.mjs --days 30
//   node scripts/traffic.mjs --me "Sela Navot" # whose requests to leave out (default: git user.name)
//   node scripts/traffic.mjs --sql "SELECT blob1 AS client, SUM(_sample_interval) AS n FROM open_cryptology_requests GROUP BY client"
//
// Signs in with your Wrangler login (`npx --prefix worker wrangler login`); no API token needed.
// Counts are SUM(_sample_interval), so they stay right if Analytics Engine samples.
//
// Who counts as what:
//   you      addresses that sent a request signed in as --me, or from our own tools ("site"
//            client); IPv6 addresses by their /64, since a home connection rotates within it
//   people   "person" clients (real browser headers) minus you, minus datacenter networks, and
//            only addresses that opened 2+ pages besides the sign-in/contact links, arrived from
//            another site or followed a link in a ChatGPT answer: a crawler on home connections that makes one request per address
//            (seen Nov 2026) otherwise passes for thousands of readers
//   agents   AI assistants fetching for a person (ChatGPT-User, Claude-User, scripts in OpenAI's
//            sandboxes...), by name; minus you
//
// "What they do" replays people's and agents' requests in order (sampled rows count once):
//   people   how they arrived (a ChatGPT answer's link carries ?utm_source=chatgpt.com), what a
//            visit looks like (one paper's PDF, an abstract only, several papers...), longest visits
//   agents   sessions (one address, no gap over 3 minutes): one paper means "tell me about this
//            paper"; 3+ papers within minutes is a survey of a topic, shown with titles from D1
// Field positions (blob1 = client, ...) are listed in dataPoint() in worker/src/reqlog.ts.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATASET = "open_cryptology_requests";
const DATACENTER =
  /alibaba|amazon|aws|google cloud|google llc|microsoft|azure|oracle|hetzner|ovh|digitalocean|linode|akamai|vultr|leaseweb|hostroyale|oculus|truview|rackn|contabo|datacamp|m247|tencent|huawei cloud|scaleway|choopa|netutils|cirrascale|spartan host|code200|hostinger|ionos/i;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const days = Number(opt("days", "7"));
if (!Number.isInteger(days) || days < 1 || days > 92) throw new Error("--days must be 1..92 (Analytics Engine keeps ~3 months)");
let me = opt("me", "");
if (!me) {
  try {
    me = execFileSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    me = "";
  }
}

// ---- Cloudflare access through the Wrangler login

const token = execFileSync("npx", ["--prefix", join(root, "worker"), "wrangler", "auth", "token"], {
  cwd: join(root, "worker"),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
})
  .trim()
  .split("\n")
  .pop()
  .trim();
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text;
}
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  const list = JSON.parse(await cf("/accounts")).result;
  if (list.length !== 1) throw new Error("several Cloudflare accounts: set CLOUDFLARE_ACCOUNT_ID");
  account = list[0].id;
}
async function sql(query) {
  const text = await cf(`/accounts/${account}/analytics_engine/sql`, { method: "POST", body: `${query} FORMAT JSON` });
  return JSON.parse(text).data;
}

if (opt("sql")) {
  console.table(await sql(opt("sql")));
  process.exit(0);
}

// ---- data

const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const rows = await sql(`
  SELECT toDate(timestamp) AS day, blob7 AS ip, blob1 AS client, blob2 AS agent,
    argMax(blob8, timestamp) AS country, argMax(blob11, timestamp) AS org,
    argMax(blob17, length(blob17)) AS login,
    argMax(blob12, if(blob12 IN ('', 'opencryptology.org', 'www.opencryptology.org'), 0, 1)) AS extRef,
    SUM(_sample_interval) AS n,
    SUM(if(blob3 IN ('/contact', '/account') OR startsWith(blob3, '/auth/'), _sample_interval, 0)) AS bait
  FROM ${DATASET} WHERE ${since}
  GROUP BY day, ip, client, agent ORDER BY day LIMIT 200000`);
const paperRows = await sql(`
  SELECT blob1 AS client, blob2 AS agent, blob4 AS paper, blob7 AS ip, SUM(_sample_interval) AS n
  FROM ${DATASET} WHERE ${since} AND blob4 != ''
  GROUP BY client, agent, paper, ip LIMIT 200000`);
const RAW_LIMIT = 300000;
const raw = await sql(`
  SELECT timestamp AS t, blob7 AS ip, blob1 AS client, blob2 AS agent, blob3 AS path, blob4 AS paper,
    blob18 AS query, blob12 AS ref, blob8 AS country, blob11 AS org
  FROM ${DATASET} WHERE ${since} AND blob1 IN ('person', 'agent')
  ORDER BY t LIMIT ${RAW_LIMIT}`);
for (const r of [...rows, ...paperRows]) r.n = Number(r.n);
for (const r of rows) r.bait = Number(r.bait);
if (!rows.length) {
  console.log(`No data in the last ${days} days (the dataset fills from the first deploy with reqlog's dataPoint).`);
  process.exit(0);
}

const isExternal = (ref) => ref && ref !== "opencryptology.org" && ref !== "www.opencryptology.org";
const netOf = (ip) => (ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip);

// you
const myNets = new Set();
const meLower = me.toLowerCase();
for (const r of rows) if (r.client === "site" || (meLower && r.login.toLowerCase() === meLower)) myNets.add(netOf(r.ip));
const mine = (ip) => myNets.has(netOf(ip));

// people: per address over the whole window
const byIp = new Map();
for (const r of rows) {
  if (r.client !== "person" || mine(r.ip)) continue;
  const a = byIp.get(r.ip) ?? { pages: 0, ext: "", org: r.org, country: r.country, days: new Set() };
  a.pages += r.n - r.bait;
  if (isExternal(r.extRef)) a.ext = r.extRef;
  if (r.n - r.bait > 0) a.days.add(r.day);
  byIp.set(r.ip, a);
}
const fromAnswer = (r) => /(^|&)utm_source=chatgpt\.com/.test(r.query) || /(^|\.)chatgpt\.com$/.test(r.ref);
const answerIps = new Set(raw.filter((r) => r.client === "person" && fromAnswer(r)).map((r) => r.ip));
const people = new Map([...byIp].filter(([ip, a]) => !DATACENTER.test(a.org) && (a.pages >= 2 || a.ext || answerIps.has(ip))));

// ---- report

const pad = (s, n) => String(s).padEnd(n);
const col = (s) => String(s).padStart(8);
const num = (x) => col(Math.round(x));
const top = (m, k = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
const count = (iter) => {
  const m = new Map();
  for (const [k, v] of iter) m.set(k, (m.get(k) ?? 0) + v);
  return m;
};

console.log(`Open Cryptology traffic, last ${days} days${me ? ` (leaving out ${me}: ${myNets.size} address(es))` : ""}\n`);

const dayList = [...new Set(rows.map((r) => r.day))].sort();
const agentNames = [...new Set(rows.filter((r) => r.client === "agent").map((r) => r.agent || "other"))].sort();
console.log(pad("day", 11) + col("people") + agentNames.map((a) => col(a.slice(0, 7))).join("") + col("crawler") + col("script") + col("you") + col("all"));
for (const d of dayList) {
  const dr = rows.filter((r) => r.day === d);
  const ppl = new Set(dr.filter((r) => people.has(r.ip) && r.n - r.bait > 0).map((r) => r.ip)).size;
  const sum = (f) => dr.filter(f).reduce((s, r) => s + r.n, 0);
  console.log(
    pad(d, 11) + num(ppl) +
      agentNames.map((a) => num(sum((r) => r.client === "agent" && (r.agent || "other") === a && !mine(r.ip)))).join("") +
      num(sum((r) => r.client === "crawler")) + num(sum((r) => r.client === "script" && !mine(r.ip))) +
      num(sum((r) => mine(r.ip))) + num(sum(() => true)),
  );
}
console.log("(people = distinct addresses; the other columns are requests)\n");

const returning = [...people.values()].filter((a) => a.days.size >= 2).length;
console.log(`People: ${people.size} addresses, ${returning} came back on another day.`);
console.log("  from:      " + top(count([...people.values()].map((a) => [a.country, 1])), 10).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("  networks:  " + top(count([...people.values()].map((a) => [a.org, 1])), 10).map(([k, v]) => `${k} (${v})`).join(", "));
const pplPapers = top(count(paperRows.filter((r) => people.has(r.ip)).map((r) => [r.paper, 1])), 15);
console.log("  papers (by readers): " + pplPapers.map(([k, v]) => `${k} ${v}`).join(", ") + "\n");

const agentRows = paperRows.filter((r) => r.client === "agent" && !mine(r.ip));
console.log(`Agents: ${agentRows.reduce((s, r) => s + r.n, 0)} paper fetches across ${new Set(agentRows.map((r) => r.paper)).size} papers.`);
for (const a of agentNames) {
  const ar = rows.filter((r) => r.client === "agent" && (r.agent || "other") === a && !mine(r.ip));
  console.log(`  ${pad(a, 16)} ${num(ar.reduce((s, r) => s + r.n, 0))} requests`);
}
console.log("  papers (by fetches): " + top(count(agentRows.map((r) => [r.paper, r.n])), 15).map(([k, v]) => `${k} ${v}`).join(", "));

// ---- what they do

const at = (r) => Date.parse(r.t.replace(" ", "T") + "Z");
const kind = (r) => {
  const p = r.path;
  if (r.paper) return p.endsWith(".pdf") ? "pdf" : "abstract";
  if (p === "/search" || p === "/api/search") return "search";
  if (p === "/manuscripts" || p === "/submit") return "manuscripts";
  if (p === "/contact" || p === "/account" || p.startsWith("/auth/")) return "sign-in";
  return "";
};
const share = (k, n) => `${k} (${n ? Math.round((100 * k) / n) : 0}%)`;
const line = (m) => top(m, 20).map(([k, v]) => `${k} ${v}`).join(", ");
const group = (list, key) => {
  const m = new Map();
  for (const r of list) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

console.log("\n\nWhat they do" + (raw.length >= RAW_LIMIT ? ` (first ${RAW_LIMIT} requests only: use fewer --days)` : ""));

// people
const visits = group(raw.filter((r) => r.client === "person" && people.has(r.ip)), (r) => r.ip);
const arrived = new Map();
const shape = new Map();
let abstracts = 0;
let thenPdf = 0;
let searched = 0;
let manuscripts = 0;
let signIn = 0;
const long = [];
for (const [ip, rs] of visits) {
  const ext = rs.find((r) => isExternal(r.ref))?.ref ?? "";
  const how = answerIps.has(ip) ? "ChatGPT answer" : /scholar\.google/.test(ext) ? "Google Scholar" :
    /google|bing|duckduckgo|yandex|baidu|ecosia|brave/.test(ext) ? "search engine" : ext ? ext : "no referrer";
  arrived.set(how, (arrived.get(how) ?? 0) + 1);
  const kinds = new Set(rs.map(kind));
  const papers = group(rs.filter((r) => r.paper), (r) => r.paper);
  for (const pr of papers.values()) {
    const ks = new Set(pr.map(kind));
    if (ks.has("abstract")) {
      abstracts++;
      if (ks.has("pdf")) thenPdf++;
    }
  }
  const s = papers.size === 0 ? "no paper" : papers.size === 1 ? (kinds.has("pdf") ? "one paper's PDF" : "one abstract only") :
    kinds.has("pdf") ? "several papers with PDFs" : "several abstracts";
  shape.set(s, (shape.get(s) ?? 0) + 1);
  if (kinds.has("search")) searched++;
  if (kinds.has("manuscripts")) manuscripts++;
  if (kinds.has("sign-in")) signIn++;
  long.push({ ip, rs, papers: papers.size, min: Math.round((at(rs.at(-1)) - at(rs[0])) / 60000), how });
}
const nv = visits.size;
console.log(`People (${nv}):`);
console.log("  arrived from:  " + line(arrived));
console.log("  visits:        " + line(shape));
console.log(`  abstracts opened: ${abstracts}, then the PDF: ${share(thenPdf, abstracts)}`);
console.log(`  searched: ${share(searched, nv)}; looked at manuscripts: ${share(manuscripts, nv)}; reached sign-in or contact: ${share(signIn, nv)}`);
console.log("  most papers opened:");
for (const v of long.sort((a, b) => b.papers - a.papers || b.rs.length - a.rs.length).slice(0, 5).filter((v) => v.papers >= 2))
  console.log(`    ${pad(v.rs[0].country, 3)}${pad(v.rs[0].org.slice(0, 28), 29)} ${String(v.papers).padStart(3)} papers over ${v.min} min (${v.how})`);

// agents
const sessions = [];
for (const rs of group(raw.filter((r) => r.client === "agent" && !mine(r.ip)), (r) => `${r.agent}|${r.ip}`).values()) {
  let cur = [];
  for (const r of rs) {
    if (cur.length && at(r) - at(cur.at(-1)) > 180e3) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  sessions.push(cur);
}
const papersIn = (s) => [...new Set(s.map((r) => r.paper).filter(Boolean))];
console.log("\nAgents (a session = one address, no gap over 3 minutes):");
for (const [a, ss] of [...group(sessions, (s) => s[0].agent || "other")].sort((x, y) => y[1].length - x[1].length)) {
  const n = ss.length;
  const one = ss.filter((s) => papersIn(s).length === 1).length;
  const two = ss.filter((s) => papersIn(s).length === 2).length;
  const many = ss.filter((s) => papersIn(s).length >= 3).length;
  const fetches = ss.flat().filter((r) => r.paper);
  const pdfs = fetches.filter((r) => r.path.endsWith(".pdf")).length;
  console.log(`  ${pad(a, 16)} ${String(n).padStart(6)} sessions: one paper ${share(one, n)}, two ${two}, 3+ ${many}; ${share(pdfs, fetches.length)} of paper fetches are PDFs`);
}

// the papers agents were asked about most, and topic surveys, with titles
const askedBy = new Map();
for (const r of raw) if (r.client === "agent" && r.paper && !mine(r.ip)) (askedBy.get(r.paper) ?? askedBy.set(r.paper, new Set()).get(r.paper)).add(r.ip);
const asked = [...askedBy].map(([p, ips]) => [p, ips.size]).sort((a, b) => b[1] - a[1]).slice(0, 10);
const surveys = sessions.filter((s) => papersIn(s).length >= 3).sort((a, b) => papersIn(b).length - papersIn(a).length).slice(0, 6);
const titles = await titlesOf([...asked.map(([p]) => p), ...surveys.flatMap((s) => papersIn(s).slice(0, 5))]);
const title = (p) => (titles.get(p) ?? "").slice(0, 90);
console.log("  asked about most (addresses):");
for (const [p, n] of asked) console.log(`    ${pad(p, 11)}${String(n).padStart(4)}  ${title(p)}`);
console.log(`  topic surveys (3+ papers in one session): ${sessions.filter((s) => papersIn(s).length >= 3).length}; largest:`);
for (const s of surveys) {
  const ps = papersIn(s);
  console.log(`    ${s[0].t.slice(0, 16)} ${s[0].agent}, ${ps.length} papers in ${Math.round((at(s.at(-1)) - at(s[0])) / 1000)} s:`);
  for (const p of ps.slice(0, 5)) console.log(`      ${pad(p, 11)}${title(p)}`);
}

// a person clicking a ChatGPT answer's link soon after ChatGPT read that paper: the whole loop
const gptRead = group(raw.filter((r) => r.agent === "chatgpt" && r.paper), (r) => r.paper);
const clicks = raw.filter((r) => r.client === "person" && r.paper && !mine(r.ip) && fromAnswer(r));
const loop = clicks.filter((c) => (gptRead.get(c.paper) ?? []).some((g) => at(g) <= at(c) && at(c) - at(g) < 30 * 60e3)).length;
console.log(`  clicks on a ChatGPT answer's link: ${clicks.length}, ${share(loop, clicks.length)} within 30 min of ChatGPT reading that paper`);

/** Paper titles from production D1 (read-only). */
async function titlesOf(ids) {
  const list = [...new Set(ids)].filter((p) => /^\d{4}\/\d{1,6}$/.test(p));
  const out = new Map();
  if (!list.length) return out;
  try {
    const text = execFileSync(
      "npx",
      ["--prefix", join(root, "worker"), "wrangler", "d1", "execute", "open-cryptology", "--remote", "--json",
        "--command", `SELECT id, title FROM papers WHERE id IN (${list.map((p) => `'${p}'`).join(",")})`],
      { cwd: join(root, "worker"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 },
    );
    for (const r of JSON.parse(text.slice(text.indexOf("[")))[0].results) out.set(r.id, r.title);
  } catch {
    // titles are a nicety; the ids still show
  }
  return out;
}
