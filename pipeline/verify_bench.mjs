#!/usr/bin/env node
// Benchmark for upload verification (worker/src/match.ts, used by worker/src/verify.ts).
//
// Samples papers that already have a PDF on the live site, downloads each PDF once from
// https://opencryptology.org/YYYY/NNNN.pdf (never from eprint.iacr.org; at most 4 at a time),
// extracts the text items of pages 1-2 with unpdf exactly as the Worker does, caches only those
// items under data/verifycheck/text/ and deletes the PDF. Then it measures, for the current
// matcher and the previous one ("old"):
//   false rejects: the paper's own PDF fails the check against its own metadata
//   false accepts: the PDF passes against another paper's metadata (a random paper, the nearest
//                  same-year paper, and another paper sharing an author: the likeliest mix-up)
//
// Usage (Node >= 23, which runs the TypeScript matcher directly):
//   # candidates: read-only D1 query, run in worker/
//   npx --no-install wrangler d1 execute DB --remote --json --command \
//     "SELECT id,year,title,authors FROM papers WHERE pdf_key IS NOT NULL AND withdrawn=0 ORDER BY random() LIMIT 4000" \
//     > ../data/verifycheck/candidates.json
//   node pipeline/verify_bench.mjs [--n 300] [--seed 1] [--show 40]
//
// Output: summary on stdout, per-paper details in data/verifycheck/report.json.

import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinItems, matchPaper, TITLE_THRESHOLD } from "../worker/src/match.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "verifycheck");
const TEXT = join(DATA, "text");
const TMP = join(DATA, "tmp");
const SITE = "https://opencryptology.org";
const UA = "open-cryptology-verify-bench/0.1 (upload verification benchmark)";
const MAX_BYTES = 30 * 1024 * 1024; // the API's limit; larger files always go to review

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const N = Number(arg("n", 300));
const SEED = Number(arg("seed", 1));
const SHOW = Number(arg("show", 40));

const require = createRequire(join(ROOT, "worker", "package.json"));
const { getDocumentProxy } = await import(require.resolve("unpdf").replace(/index\.cjs$/, "index.mjs"));

// ------------------------------------------------------------------ previous matcher (before this PR)
const oldNorm = (s) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\$[^$]*\$/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
function oldMatch(items, title, authors) {
  const text = items.map((p) => p.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("")).join(" ");
  const hay = ` ${oldNorm(text)} `;
  const words = [...new Set(oldNorm(title).split(" ").filter((w) => w.length > 2))];
  const score = words.length ? words.filter((w) => hay.includes(` ${w} `)).length / words.length : 0;
  const surname = (n) => {
    const parts = oldNorm(n).split(" ").filter(Boolean);
    const last = parts[parts.length - 1];
    return last && last.length >= 3 ? last : null;
  };
  const hit = authors.map(surname).find((s) => s && hay.includes(` ${s} `)) ?? null;
  return { ok: score >= 0.85 && !!hit, titleScore: Math.round(score * 100) / 100, authorHit: hit };
}
// The Worker's current matcher.
const newMatch = (items, title, authors) => matchPaper(items.map(joinItems), title, authors);

// ------------------------------------------------------------------ sampling
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}
const rand = rng(SEED);
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const cand = JSON.parse(readFileSync(join(DATA, "candidates.json"), "utf8"))[0].results.map((r) => ({
  ...r,
  authors: JSON.parse(r.authors),
}));
const lastTok = (a) => a.trim().split(/\s+/).pop() ?? "";
const CJK = new Set(
  ("wang zhang li liu chen yang huang zhao zhou wu xu sun ma zhu hu guo he lin luo gao zheng liang song tang " +
    "han feng deng cao peng zeng xiao tian dong pan yuan cai jiang yu du ye wei kim lee park choi jung kang cho " +
    "yoon jang lim shin seo kwon hwang ahn song hong nguyen tran le pham").split(" "),
);
const strata = [
  ["pre-2005", 45, (p) => p.year < 2005],
  ["2024+", 40, (p) => p.year >= 2024],
  ["6+ authors", 35, (p) => p.authors.length >= 6],
  ["2-letter surname", 45, (p) => p.authors.some((a) => lastTok(a).length < 3)],
  ["CJK names", 45, (p) => p.authors.some((a) => a.split(/\s+/).some((t) => CJK.has(t.toLowerCase())))],
  ["TeX title", 30, (p) => /[$\\{}^_]/.test(p.title)],
];
const picked = new Map();
const pool = shuffle([...cand]);
for (const [name, k, f] of strata) {
  let n = 0;
  for (const p of pool) {
    if (n >= k) break;
    if (!picked.has(p.id) && f(p)) {
      picked.set(p.id, p);
      n++;
    }
  }
}
for (const p of pool) {
  if (picked.size >= N) break;
  if (!picked.has(p.id)) picked.set(p.id, p);
}
const sample = [...picked.values()];
const tags = (p) => strata.filter(([, , f]) => f(p)).map(([n]) => n);

// ------------------------------------------------------------------ download + extract (cached)
mkdirSync(TEXT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const cachePath = (id) => join(TEXT, id.replace("/", "-") + ".json");

async function extract(id) {
  const cp = cachePath(id);
  if (existsSync(cp)) return JSON.parse(readFileSync(cp, "utf8"));
  const tmp = join(TMP, id.replace("/", "-") + ".pdf");
  try {
    const res = await fetch(`${SITE}/${id}.pdf`, { headers: { "user-agent": UA } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (size > MAX_BYTES) {
      const out = { size, skipped: "over 30 MB" };
      writeFileSync(cp, JSON.stringify(out));
      return out;
    }
    const t0 = performance.now();
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(tmp)));
    const pages = [];
    for (let i = 1; i <= Math.min(2, pdf.numPages); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(
        tc.items
          .filter((it) => "str" in it)
          .map((it) => ({ str: it.str, hasEOL: it.hasEOL, transform: it.transform.map((x) => Math.round(x * 100) / 100), width: Math.round(it.width * 100) / 100 })),
      );
      page.cleanup();
    }
    const ms = Math.round(performance.now() - t0);
    await pdf.loadingTask.destroy();
    const out = { size, numPages: pdf.numPages, ms, pages };
    writeFileSync(cp, JSON.stringify(out));
    return out;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(tmp, { force: true });
  }
}

const docs = new Map();
let next = 0;
let done = 0;
async function worker() {
  while (next < sample.length) {
    const p = sample[next++];
    docs.set(p.id, await extract(p.id));
    if (++done % 25 === 0) process.stderr.write(`  ${done}/${sample.length}\n`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

// ------------------------------------------------------------------ evaluate
const usable = sample.filter((p) => docs.get(p.id)?.pages);
const textChars = (d) => d.pages.reduce((n, pg) => n + pg.reduce((m, it) => m + it.str.trim().length, 0), 0);
const byYear = new Map();
for (const c of cand) (byYear.get(c.year) ?? byYear.set(c.year, []).get(c.year)).push(c);
const neighbor = (p) =>
  (byYear.get(p.year) ?? []).filter((c) => c.id !== p.id).sort((a, b) => Math.abs(Number(a.id.split("/")[1]) - Number(p.id.split("/")[1])) - Math.abs(Number(b.id.split("/")[1]) - Number(p.id.split("/")[1])))[0];
const byAuthor = new Map();
for (const c of cand) for (const a of c.authors) (byAuthor.get(a) ?? byAuthor.set(a, []).get(a)).push(c);
const coauthored = (p) => {
  for (const a of p.authors) {
    const o = (byAuthor.get(a) ?? []).find((c) => c.id !== p.id);
    if (o) return o;
  }
  return null;
};

const matchers = { old: oldMatch, new: newMatch };
const results = {};
const details = [];
for (const [name, fn] of Object.entries(matchers)) {
  const r = (results[name] = { reject: [], acceptRandom: 0, acceptNeighbor: 0, acceptCoauthor: 0, nCoauthor: 0, titleOnlyRandom: 0, authorOnlyRandom: 0, ms: [], falseScores: [], trueScores: [] });
  for (const [i, p] of usable.entries()) {
    const d = docs.get(p.id);
    const t0 = performance.now();
    const own = fn(d.pages, p.title, p.authors);
    r.ms.push(performance.now() - t0);
    r.trueScores.push(own.titleScore);
    if (!own.ok) r.reject.push({ id: p.id, tags: tags(p), chars: textChars(d), title: p.title, authors: p.authors, ...own });
    let o = usable[(i + 1 + Math.floor(rand() * (usable.length - 1))) % usable.length];
    if (o.id === p.id) o = usable[(i + 1) % usable.length];
    const ro = fn(d.pages, o.title, o.authors);
    r.falseScores.push(ro.titleScore);
    if (name === "new" && ro.titleScore >= 0.6) details.push({ matcher: name, near: "random", pdf: p.id, pdfTitle: p.title, meta: o.id, title: o.title, ...ro });
    if (ro.ok) r.acceptRandom++;
    if (ro.titleScore >= (name === "old" ? 0.85 : TITLE_THRESHOLD)) r.titleOnlyRandom++;
    if (ro.authorHit) r.authorOnlyRandom++;
    const nb = neighbor(p);
    const rn = nb && fn(d.pages, nb.title, nb.authors);
    if (rn) r.falseScores.push(rn.titleScore);
    if (name === "new" && rn?.titleScore >= 0.6) details.push({ matcher: name, near: "neighbor", pdf: p.id, pdfTitle: p.title, meta: nb.id, title: nb.title, ...rn });
    if (rn?.ok) {
      r.acceptNeighbor++;
      details.push({ matcher: name, falseAccept: "neighbor", pdf: p.id, meta: nb.id, title: nb.title });
    }
    const co = coauthored(p);
    if (co) {
      r.nCoauthor++;
      const rc = fn(d.pages, co.title, co.authors);
      r.falseScores.push(rc.titleScore);
      if (name === "new" && rc.titleScore >= 0.6) details.push({ matcher: name, near: "coauthor", pdf: p.id, pdfTitle: p.title, meta: co.id, title: co.title, ...rc });
      if (rc.ok) {
        r.acceptCoauthor++;
        details.push({ matcher: name, falseAccept: "coauthor", pdf: p.id, pdfTitle: p.title, meta: co.id, title: co.title, ...rc });
      }
    }
    if (ro.ok) details.push({ matcher: name, falseAccept: "random", pdf: p.id, meta: o.id, title: o.title, ...ro });
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "n/a");
const noTextIds = new Set(results.new.reject.filter((x) => x.noText).map((x) => x.id));
const noText = noTextIds.size;
const exMs = usable.map((p) => docs.get(p.id).ms).filter((x) => x != null).sort((a, b) => a - b);
console.log(`sample ${sample.length}; usable ${usable.length} (failed ${sample.filter((p) => docs.get(p.id)?.error).length}, over 30 MB ${sample.filter((p) => docs.get(p.id)?.skipped).length}); no readable text on pages 1-2 (scans, fonts without Unicode map): ${noText}`);
if (exMs.length) console.log(`text extraction (pages 1-2, Node): median ${exMs[exMs.length >> 1]} ms, p95 ${exMs[Math.floor(exMs.length * 0.95)]} ms, max ${exMs.at(-1)} ms`);
console.log("strata:", Object.fromEntries(strata.map(([n, , f]) => [n, usable.filter(f).length])));
for (const [name, r] of Object.entries(results)) {
  const ms = r.ms.sort((a, b) => a - b);
  console.log(`\n[${name}] false reject ${r.reject.length}/${usable.length} = ${pct(r.reject.length, usable.length)}` +
    `  (excluding PDFs without readable text: ${r.reject.filter((x) => !noTextIds.has(x.id)).length}/${usable.length - noText} = ${pct(r.reject.filter((x) => !noTextIds.has(x.id)).length, usable.length - noText)})`);
  console.log(`  false accept: random ${r.acceptRandom}/${usable.length}, same-year neighbor ${r.acceptNeighbor}/${usable.length}, shared-author paper ${r.acceptCoauthor}/${r.nCoauthor}`);
  console.log(`  random other paper: title passes ${pct(r.titleOnlyRandom, usable.length)}, an author name found ${pct(r.authorOnlyRandom, usable.length)}`);
  console.log(`  match time: median ${ms[ms.length >> 1].toFixed(2)} ms, max ${ms.at(-1).toFixed(2)} ms`);
  const dist = (xs) => [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 1].map((t) => `>=${t}: ${xs.filter((x) => x >= t).length}`).join(", ");
  console.log(`  title score, wrong-paper pairs (${r.falseScores.length}): ${dist(r.falseScores)}`);
  console.log(`  title score, own paper (${r.trueScores.length}): ${dist(r.trueScores)}`);
  const byTag = {};
  for (const x of r.reject) for (const t of x.tags.length ? x.tags : ["other"]) byTag[t] = (byTag[t] ?? 0) + 1;
  console.log("  rejects by stratum:", byTag);
  const th = name === "old" ? 0.85 : TITLE_THRESHOLD;
  console.log("  rejects: title failed", r.reject.filter((x) => x.titleScore < th && x.authorHit).length,
    "author failed", r.reject.filter((x) => x.titleScore >= th && !x.authorHit).length,
    "both failed", r.reject.filter((x) => x.titleScore < th && !x.authorHit).length);
}
for (const x of results.new.reject.slice(0, SHOW))
  console.log(`  - ${x.id} [${x.tags.join(",")}] ${x.noText ? 'NO-TEXT ' : ''}title=${x.titleScore} author=${x.authorHit ?? "-"} | ${x.title.slice(0, 70)} | ${x.authors.slice(0, 4).join("; ")}`);
const fa = details.filter((d) => d.matcher === "new" && !d.near);
if (fa.length) console.log("\nnew false accepts:", fa);
const near = details.filter((d) => d.near);
if (near.length && SHOW) console.log("\nnew: wrong-paper pairs with title score >= 0.6:\n" + near.map((d) => `  ${d.near} pdf ${d.pdf} vs ${d.meta}: title=${d.titleScore} author=${d.authorHit ?? "-"} | ${d.pdfTitle.slice(0, 60)} || ${d.title.slice(0, 60)}`).join("\n"));
writeFileSync(join(DATA, "report.json"), JSON.stringify({ results, details }, null, 1));
