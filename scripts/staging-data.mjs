#!/usr/bin/env node
// Staging's database and bucket (docs/STAGING.md). Writes only to staging; reads production with
// SELECTs (paper metadata, public and CC0) and copies a few PDFs, never users, comments, sessions,
// uploads or logs.
//
//   node scripts/staging-data.mjs schema              # db/schema.sql on an empty staging D1
//   node scripts/staging-data.mjs sql FILE            # run statements (e.g. a schema change) on staging D1
//   node scripts/staging-data.mjs seed [--years 2] [--pdfs 20] [--ids 2024/123,2025/001]
//        # papers of the last N years from production (plus --ids), and the PDFs and versions of a
//        # sample of them; other papers show as "no PDF yet". Re-running replaces those rows.
//   node scripts/staging-data.mjs status              # row counts on staging
//
// Scratch files go to data/staging/ (gitignored).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "worker");
const scratch = join(root, "data", "staging");

spawnSync("bash", [join(root, "scripts", "worker-deps.sh")], { stdio: "inherit" });
delete process.env.CLOUDFLARE_ENV;
delete process.env.WRANGLER_ENV;

const { unstable_readConfig } = await import(pathToFileURL(createRequire(join(worker, "package.json")).resolve("wrangler")).href);
const cfgPath = join(worker, "wrangler.jsonc");
const prod = unstable_readConfig({ config: cfgPath });
const staging = unstable_readConfig({ config: cfgPath, env: "staging" });
const prodDb = prod.d1_databases.find((d) => d.binding === "DB");
const stagingDb = staging.d1_databases.find((d) => d.binding === "DB");
const prodBucket = prod.r2_buckets.find((b) => b.binding === "PDFS").bucket_name;
const stagingBucket = staging.r2_buckets.find((b) => b.binding === "PDFS").bucket_name;
if (staging.name === prod.name || stagingDb.database_id === prodDb.database_id || stagingBucket === prodBucket) {
  throw new Error("the staging config points at production resources; refusing (test/config.test.ts)");
}

function wrangler(args, { input, quiet } = {}) {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], {
    cwd: worker,
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: [input ? "pipe" : "inherit", "pipe", quiet ? "pipe" : "inherit"],
  });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${r.stdout ?? ""}${quiet ? (r.stderr ?? "") : ""}`);
  return r.stdout;
}
/** SELECT on production (read-only). */
function prodQuery(sql) {
  const out = wrangler(["d1", "execute", prodDb.database_name, "--remote", "--json", "--command", sql], { quiet: true });
  return JSON.parse(out)[0].results;
}
/** Statements on staging D1. */
function stagingExec(file) {
  wrangler(["d1", "execute", "DB", "--env", "staging", "--remote", "--yes", "--file", file]);
}
function stagingQuery(sql) {
  const out = wrangler(["d1", "execute", "DB", "--env", "staging", "--remote", "--json", "--command", sql], { quiet: true });
  return JSON.parse(out)[0].results;
}

const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table, rows) =>
  rows.map((r) => `INSERT OR REPLACE INTO ${table} (${Object.keys(r).join(", ")}) VALUES (${Object.values(r).map(lit).join(", ")});`);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];
mkdirSync(scratch, { recursive: true });

if (cmd === "schema") {
  stagingExec(join(root, "db", "schema.sql"));
  console.log(`staging-data: db/schema.sql applied to ${stagingDb.database_name}`);
} else if (cmd === "sql") {
  const file = process.argv[3];
  if (!file) throw new Error("usage: staging-data.mjs sql FILE");
  stagingExec(file);
  console.log(`staging-data: ${file} ran on ${stagingDb.database_name}`);
} else if (cmd === "status") {
  for (const t of ["papers", "versions", "users", "comments", "uploads"]) {
    const [r] = stagingQuery(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`${t.padEnd(10)} ${r.n}`);
  }
  const [p] = stagingQuery("SELECT COUNT(*) AS n FROM papers WHERE pdf_key IS NOT NULL");
  console.log(`with PDF   ${p.n}`);
} else if (cmd === "seed") {
  const years = Number(arg("years", "2"));
  const nPdfs = Number(arg("pdfs", "20"));
  const ids = (arg("ids", "") || "").split(",").filter((s) => /^\d{4}\/\d{1,6}$/.test(s));
  const since = new Date().getUTCFullYear() - years + 1;
  const where = `year >= ${since}${ids.length ? ` OR id IN (${ids.map(lit).join(",")})` : ""}`;
  console.log(`staging-data: reading papers (${where}) from production...`);
  const papers = prodQuery(`SELECT * FROM papers WHERE ${where}`);

  // PDF sample: the --ids first, then one paper per license, then spread over the rest.
  const withPdf = papers.filter((p) => p.pdf_key).sort((a, b) => a.id.localeCompare(b.id));
  const pick = new Set(ids.filter((id) => withPdf.some((p) => p.id === id)));
  for (const p of withPdf) if (![...pick].some((id) => papers.find((q) => q.id === id).license_code === p.license_code)) pick.add(p.id);
  for (let i = 0; pick.size < Math.min(nPdfs, withPdf.length) && i < 4 * withPdf.length; i++) pick.add(withPdf[Math.floor((i * 7919) % withPdf.length)].id);
  const sample = [...pick].slice(0, Math.max(nPdfs, ids.length));
  const versions = sample.length
    ? prodQuery(`SELECT * FROM versions WHERE paper_id IN (${sample.map(lit).join(",")})`)
    : [];

  // Copy those PDFs: production bucket -> staging bucket, through a temp file.
  const keys = new Set([...papers.filter((p) => pick.has(p.id)).map((p) => p.pdf_key), ...versions.map((v) => v.r2_key)]);
  const tmp = join(scratch, "pdf.tmp");
  let copied = 0;
  for (const key of keys) {
    wrangler(["r2", "object", "get", `${prodBucket}/${key}`, "--remote", "--file", tmp], { quiet: true });
    wrangler(["r2", "object", "put", `${stagingBucket}/${key}`, "--remote", "--file", tmp, "--content-type", "application/pdf"], { quiet: true });
    copied++;
    process.stdout.write(`\rstaging-data: copied ${copied}/${keys.size} PDFs`);
  }
  rmSync(tmp, { force: true });
  if (keys.size) process.stdout.write("\n");

  // Papers outside the sample have no PDF on staging.
  for (const p of papers) {
    if (pick.has(p.id)) continue;
    Object.assign(p, { pdf_key: null, pdf_sha256: null, pdf_size: null, pdf_source: null, pdf_source_date: null, pdf_maybe_stale: 0 });
  }
  const sql = [
    ...insert("papers", papers),
    `DELETE FROM versions WHERE paper_id IN (${papers.map((p) => lit(p.id)).join(",") || "''"});`,
    ...insert("versions", versions),
    "INSERT INTO papers_fts(papers_fts) VALUES('rebuild');",
  ];
  const file = join(scratch, "seed.sql");
  writeFileSync(file, sql.join("\n") + "\n");
  console.log(`staging-data: writing ${papers.length} papers (${sample.length} with PDFs) and ${versions.length} versions to staging...`);
  stagingExec(file);
  console.log("staging-data: done");
} else {
  console.error("usage: node scripts/staging-data.mjs schema | sql FILE | seed [--years N] [--pdfs N] [--ids a,b] | status");
  process.exit(2);
}
