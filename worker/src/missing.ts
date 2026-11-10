// Papers we don't have a PDF for yet ("help us fill the gaps"): the homepage card, /missing and
// /api/missing. A paper counts as missing while it is live, has no mirrored PDF and has no upload
// waiting for review. The partial index papers_missing (db/schema.sql) serves these queries.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { card, hasTex, page } from "./layout";
import { originalUrl } from "./license";
import { fmtInt, json } from "./pages";

export interface MissingItem {
  id: string;
  year: number;
  num: number;
  title: string;
}

const MISSING_WHERE = `pdf_key IS NULL AND withdrawn = 0
  AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.paper_id = papers.id AND u.status = 'pending')`;

const PER_PAGE = 50;

/** Missing papers, newest first, plus the total (optionally for one year). */
export async function missingPapers(
  env: Env,
  limit: number,
  offset = 0,
  year: number | null = null,
): Promise<{ total: number; items: MissingItem[] }> {
  const where = year === null ? MISSING_WHERE : `${MISSING_WHERE} AND year = ?3`;
  const bind = (s: D1PreparedStatement, ...a: unknown[]) => (year === null ? s.bind(...a) : s.bind(...a, year));
  const [count, rows] = await env.DB.batch([
    bind(env.DB.prepare(`SELECT count(*) AS n FROM papers WHERE ${where.replace("?3", "?1")}`)),
    bind(
      env.DB.prepare(`SELECT id, year, num, title FROM papers WHERE ${where} ORDER BY year DESC, num DESC LIMIT ?1 OFFSET ?2`),
      limit,
      offset,
    ),
  ]);
  return {
    total: Number((count.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    items: (rows.results ?? []) as unknown as MissingItem[],
  };
}

async function missingByYear(env: Env): Promise<{ year: number; n: number }[]> {
  const r = await env.DB.prepare(
    `SELECT year, count(*) AS n FROM papers WHERE ${MISSING_WHERE} GROUP BY year ORDER BY year DESC`,
  ).all<{ year: number; n: number }>();
  return r.results ?? [];
}

/** One entry: id + title, linking to our paper page (which carries the upload box). */
function missingItem(p: MissingItem): Html {
  return html`<div class="recent-item">
  <small><a href="/${p.id}">${p.id}</a></small>
  <h6 class="recent-title tex"><a href="/${p.id}">${p.title || "Untitled"}</a></h6>
</div>`;
}

const papersWord = (n: number) => `${fmtInt(n)} paper${n === 1 ? "" : "s"}`;

/** Homepage side card. */
export async function missingCard(env: Env, limit = 15): Promise<{ card: Html; tex: boolean }> {
  const { total, items } = await missingPapers(env, limit);
  const content = total
    ? html`<p class="small mb-2"><strong>${papersWord(total)}</strong> don’t have a PDF here yet.
      If you can grab one from ePrint, please upload it on the paper’s page.</p>
      <div class="recent-list">${items.map((p) => missingItem(p))}</div>
      <p class="mt-2 mb-0"><a href="/missing">See all ${papersWord(total)} missing a PDF →</a></p>`
    : html`<p class="small mb-0">Every paper has a PDF here now. Thank you for helping!</p>`;
  return { card: card("Help us fill the gaps", content, "home-missing"), tex: hasTex(...items.map((p) => p.title)) };
}

interface MissingParams {
  page: number;
  year: number | null;
}

function missingParams(url: URL): MissingParams {
  const page = Math.min(10_000, Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
  const y = parseInt(url.searchParams.get("year") ?? "", 10);
  return { page, year: y >= 1990 && y <= 2200 ? y : null };
}

function missingHref(path: string, mp: MissingParams, page: number): string {
  const u = new URLSearchParams();
  if (mp.year !== null) u.set("year", String(mp.year));
  if (page > 1) u.set("page", String(page));
  const q = u.toString();
  return q ? `${path}?${q}` : path;
}

export async function missingPage(env: Env, url: URL): Promise<Response> {
  const mp = missingParams(url);
  const [{ total, items }, years] = await Promise.all([
    missingPapers(env, PER_PAGE, (mp.page - 1) * PER_PAGE, mp.year),
    missingByYear(env),
  ]);
  const all = years.reduce((s, y) => s + y.n, 0);
  const pages = Math.ceil(total / PER_PAGE);
  const body = html`<section class="missing-page">
  <div class="results-bar">
    <h4 class="results-h">Help us fill the gaps</h4>
    <small class="ms-auto">${pages > 1 ? html`Page ${mp.page} of ${pages} · ` : ""}<a href="${missingHref("/api/missing", mp, mp.page)}">JSON</a></small>
  </div>
  <p class="mt-3">${mp.year === null
    ? html`<strong>${papersWord(total)}</strong> don’t have a PDF here yet.`
    : html`<strong>${papersWord(total)}</strong> from ${mp.year} don’t have a PDF here yet.`}
  If you can grab one from ePrint, please upload it on the paper’s page. Uploads are anonymous, and
  a file that matches the paper appears right away. Papers with an upload awaiting review aren’t listed.</p>
  <form class="missing-filter" method="get" action="/missing">
    <label for="year" class="form-label mb-0">Year</label>
    <select class="form-select form-select-sm" id="year" name="year">
      <option value="">All years (${fmtInt(all)})</option>
      ${years.map((y) => html`<option value="${y.year}"${y.year === mp.year ? html` selected` : ""}>${y.year} (${fmtInt(y.n)})</option>`)}
    </select>
    <button class="btn btn-outline-dark btn-sm" type="submit">Show</button>
  </form>
  <div class="results">${items.length
    ? items.map((p) => missingItem(p))
    : html`<p>${total ? html`No papers on this page. <a href="${missingHref("/missing", mp, 1)}">Back to page 1</a>.` : "Nothing missing here. Thank you!"}</p>`}</div>
  ${pages > 1 &&
  html`<nav class="pager" aria-label="Pagination">
    ${mp.page > 1 ? html`<a class="btn btn-outline-dark btn-sm" href="${missingHref("/missing", mp, Math.min(mp.page - 1, pages))}" rel="prev">← Previous</a>` : html`<span></span>`}
    ${mp.page < pages ? html`<a class="btn btn-outline-dark btn-sm" href="${missingHref("/missing", mp, mp.page + 1)}" rel="next">Next →</a>` : html`<span></span>`}
  </nav>`}
</section>`;
  return page(env, {
    title: mp.year === null ? "Papers missing a PDF" : `Papers from ${mp.year} missing a PDF`,
    description: "Papers that don’t have a PDF on the mirror yet. Upload one to help fill the gaps.",
    body,
    noindex: true,
    katex: hasTex(...items.map((p) => p.title)),
    cache: "public, max-age=300",
  });
}

export async function apiMissing(env: Env, url: URL): Promise<Response> {
  const mp = missingParams(url);
  const origin = url.origin;
  const { total, items } = await missingPapers(env, PER_PAGE, (mp.page - 1) * PER_PAGE, mp.year);
  const totalPages = Math.ceil(total / PER_PAGE);
  return json(
    {
      total,
      page: mp.page,
      per_page: PER_PAGE,
      total_pages: totalPages,
      next: mp.page < totalPages ? `${origin}${missingHref("/api/missing", mp, mp.page + 1)}` : null,
      year: mp.year,
      results: items.map((p) => ({
        id: p.id,
        title: p.title,
        year: p.year,
        url: `${origin}/${p.id}`,
        original_url: originalUrl(env.ORIGIN_BASE, p.id),
        upload_url: `${origin}/${p.id}#upload`,
      })),
    },
    200,
    "public, max-age=300",
  );
}
