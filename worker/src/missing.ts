// The work list: every paper that needs an upload, newest first, as a page (/missing) and as JSON
// (/api/missing) for agents. A paper is on it when it has no PDF here ("missing") or ePrint changed
// it after our copy was captured ("outdated"), and no upload for it waits for review. The same
// definitions as the year pages (years.ts).
import { canonicalId, parseAuthors, type Env } from "./db";
import { html } from "./html";
import { hasTex, page } from "./layout";
import { originalUrl, versionsUrl } from "./license";
import { fmtInt, json } from "./pages";
import { siteOrigin } from "./seo";
import { PENDING, STALE } from "./years";

type Status = "all" | "missing" | "outdated";
const STATUSES: Status[] = ["all", "missing", "outdated"];
const HTML_PER_PAGE = 500;
const API_PER_PAGE = 1000;

interface Row {
  id: string;
  year: number;
  num: number;
  title: string | null;
  authors: string;
  withdrawn: number;
  missing: number;
  newer: number | null;
}

interface Query {
  status: Status;
  year: number | null;
  page: number;
}

function parseQuery(url: URL): Query {
  const s = url.searchParams.get("status") as Status | null;
  const y = Number(url.searchParams.get("year"));
  const p = Number(url.searchParams.get("page"));
  return {
    status: s && STATUSES.includes(s) ? s : "all",
    year: Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null,
    page: Number.isInteger(p) && p > 1 ? p : 1,
  };
}

const WHERE = (status: Status) =>
  `NOT ${PENDING} AND (?1 IS NULL OR year = ?1) AND ${
    status === "missing" ? "pdf_key IS NULL" : status === "outdated" ? STALE : `(pdf_key IS NULL OR ${STALE})`
  }`;

async function load(env: Env, q: Query, perPage: number) {
  const [counts, rows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT coalesce(sum(pdf_key IS NULL), 0) AS missing, coalesce(sum(${STALE}), 0) AS outdated
         FROM papers WHERE ${WHERE("all")}`,
    ).bind(q.year),
    env.DB.prepare(
      // newer: 1 = ePrint's current PDF has another size than ours, 0 = same size, null = unknown.
      `SELECT id, year, num, title, authors, withdrawn, pdf_key IS NULL AS missing,
         CASE WHEN pdf_key IS NOT NULL AND pdf_size IS NOT NULL AND pdf_latest_size IS NOT NULL
              AND pdf_latest_at = updated THEN pdf_latest_size != pdf_size END AS newer
         FROM papers WHERE ${WHERE(q.status)}
        ORDER BY year DESC, num DESC LIMIT ?2 OFFSET ?3`,
    ).bind(q.year, perPage, (q.page - 1) * perPage),
  ]);
  const c = (counts.results?.[0] ?? {}) as { missing?: number; outdated?: number };
  const missing = Number(c.missing ?? 0);
  const outdated = Number(c.outdated ?? 0);
  const total = q.status === "missing" ? missing : q.status === "outdated" ? outdated : missing + outdated;
  return { missing, outdated, total, rows: (rows.results ?? []) as unknown as Row[] };
}

function link(base: string, q: Query, change: Partial<Query>): string {
  const n = { ...q, ...change };
  const sp = new URLSearchParams();
  if (n.status !== "all") sp.set("status", n.status);
  if (n.year) sp.set("year", String(n.year));
  if (n.page > 1) sp.set("page", String(n.page));
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/** GET /api/missing?status=all|missing|outdated&year=YYYY&page=N */
export async function apiMissing(env: Env, url: URL): Promise<Response> {
  const q = parseQuery(url);
  const origin = url.origin;
  const { missing, outdated, total, rows } = await load(env, q, API_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(total / API_PER_PAGE));
  return json(
    {
      status: q.status,
      year: q.year,
      counts: { missing, outdated },
      total,
      page: q.page,
      per_page: API_PER_PAGE,
      total_pages: totalPages,
      next: q.page < totalPages ? origin + link("/api/missing", q, { page: q.page + 1 }) : null,
      results: rows.map((r) => {
        const id = canonicalId(r.year, r.num);
        return {
          id,
          status: r.missing ? "missing" : "outdated",
          title: r.title || null,
          authors: parseAuthors(r.authors),
          withdrawn: !!r.withdrawn,
          newer_on_eprint: r.missing || r.newer == null ? null : !!r.newer,
          url: `${origin}/${id}`,
          api_url: `${origin}/api/papers/${id}`,
          // Where a person can download the latest PDF (for withdrawn papers: ePrint's version archive).
          download_from: r.withdrawn ? versionsUrl(env.ORIGIN_BASE, id) : originalUrl(env.ORIGIN_BASE, id),
          upload_url: `${origin}/${id}#upload`,
          api_upload_url: `${origin}/api/upload/${id}`,
        };
      }),
    },
    200,
    "public, max-age=60",
  );
}

/** GET /missing: the same list as a page. */
export async function missingPage(env: Env, url: URL): Promise<Response> {
  const q = parseQuery(url);
  const { missing, outdated, total, rows } = await load(env, q, HTML_PER_PAGE);
  const pages = Math.max(1, Math.ceil(total / HTML_PER_PAGE));
  const tab = (s: Status, label: string, n: number) =>
    q.status === s ? html`<strong>${label} (${fmtInt(n)})</strong>` : html`<a href="${link("/missing", q, { status: s, page: 1 })}">${label} (${fmtInt(n)})</a>`;
  const body = html`<section class="year-page">
  <h3 class="mb-3">${q.year ? `Papers from ${q.year} that need a PDF` : "Papers that need a PDF"}</h3>
  <p class="small">Missing: no PDF here yet. Outdated: ePrint changed the paper after our copy.
  Download the latest PDF from ePrint and upload it on the paper’s page.
  ${q.year ? html`<a href="${link("/missing", q, { year: null, page: 1 })}">All years</a> · ` : ""}<a href="${link("/api/missing", q, {})}">JSON</a></p>
  <p class="small">${tab("all", "All", missing + outdated)} · ${tab("missing", "Missing", missing)} · ${tab("outdated", "Outdated", outdated)}${pages > 1 ? ` · page ${q.page} of ${pages}` : ""}</p>
  ${!rows.length && html`<p>Nothing here. Thank you for helping!</p>`}
  <ol class="year-list">
    ${rows.map((r) => {
      const id = canonicalId(r.year, r.num);
      const authors = parseAuthors(r.authors);
      return html`<li><a class="paperlink" href="/${id}">${id}</a> ${r.missing
        ? html`<a class="small" href="/${id}#upload">no PDF yet: upload it</a>`
        : html`<a class="small" href="/${id}#upload">${r.newer ? "newer PDF on ePrint" : "may be outdated"}: upload the latest</a>`}${r.withdrawn ? html` <span class="badge bg-secondary">withdrawn</span>` : ""}
      <div><a class="result-title tex" href="/${id}">${r.title || (r.withdrawn ? "Withdrawn paper" : "Untitled")}</a>${authors.length ? html`<span class="year-authors"> · ${authors.length > 6 ? `${authors.slice(0, 6).join(", ")}, and ${authors.length - 6} more` : authors.join(", ")}</span>` : ""}</div></li>\n`;
    })}
  </ol>
  ${pages > 1 &&
  html`<nav class="pager" aria-label="Pagination">
    ${q.page > 1 ? html`<a class="btn btn-outline-dark btn-sm" href="${link("/missing", q, { page: q.page - 1 })}" rel="prev">← Previous</a>` : html`<span></span>`}
    ${q.page < pages ? html`<a class="btn btn-outline-dark btn-sm" href="${link("/missing", q, { page: q.page + 1 })}" rel="next">Next →</a>` : html`<span></span>`}
  </nav>`}
</section>`;
  return page(env, {
    title: "Papers that need a PDF",
    description: "Cryptology ePrint papers with no PDF on Open Cryptology yet, or whose PDF may be outdated.",
    body,
    canonical: `${siteOrigin(env, url)}/missing`,
    noindex: true,
    head: html`<link rel="alternate" type="application/json" href="${link("/api/missing", q, {})}">`,
    katex: hasTex(...rows.map((r) => r.title ?? "")),
    cache: "public, max-age=60",
  });
}
