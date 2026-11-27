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
//            only addresses that opened 2+ pages besides the sign-in/contact links or arrived from
//            another site: a crawler on home connections that makes one request per address
//            (seen Nov 2026) otherwise passes for thousands of readers
//   agents   AI assistants fetching for a person (ChatGPT-User, Claude-User, scripts in OpenAI's
//            sandboxes...), by name; minus you
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
const people = new Map([...byIp].filter(([, a]) => !DATACENTER.test(a.org) && (a.pages >= 2 || a.ext)));

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
const refs = top(count([...people.values()].filter((a) => a.ext).map((a) => [a.ext, 1])), 10);
console.log("  came from: " + (refs.length ? refs.map(([k, v]) => `${k} ${v}`).join(", ") : "(no other sites)"));
const pplPapers = top(count(paperRows.filter((r) => people.has(r.ip)).map((r) => [r.paper, 1])), 15);
console.log("  papers (by readers): " + pplPapers.map(([k, v]) => `${k} ${v}`).join(", ") + "\n");

const agentRows = paperRows.filter((r) => r.client === "agent" && !mine(r.ip));
console.log(`Agents: ${agentRows.reduce((s, r) => s + r.n, 0)} paper fetches across ${new Set(agentRows.map((r) => r.paper)).size} papers.`);
for (const a of agentNames) {
  const ar = rows.filter((r) => r.client === "agent" && (r.agent || "other") === a && !mine(r.ip));
  console.log(`  ${pad(a, 16)} ${num(ar.reduce((s, r) => s + r.n, 0))} requests`);
}
console.log("  papers (by fetches): " + top(count(agentRows.map((r) => [r.paper, r.n])), 15).map(([k, v]) => `${k} ${v}`).join(", "));
