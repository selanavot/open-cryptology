// Papers we don't have a PDF for yet ("help us fill the gaps"): the homepage card, /missing and
// /api/missing. A paper counts as missing while it has no mirrored PDF and no upload waiting for
// review. Withdrawn papers count too: ePrint no longer offers them, but a saved copy can be uploaded. The partial index papers_missing (db/schema.sql) serves the API queries.
//
// The pages show coverage as squares rather than lists: one tile per year, filled in green up to
// the share of its papers we have, and one small square per paper of a year (green = PDF here,
// grey = missing, linking to the upload box).
import { canonicalId, type Env } from "./db";
import { esc, html, raw, type Html } from "./html";
import { card, page } from "./layout";
import { originalUrl } from "./license";
import { fmtInt, json } from "./pages";

export interface MissingItem {
  id: string;
  year: number;
  num: number;
  title: string;
  withdrawn: number;
}

const PENDING = `EXISTS (SELECT 1 FROM uploads u WHERE u.paper_id = papers.id AND u.status = 'pending')`;
const MISSING_WHERE = `pdf_key IS NULL AND NOT ${PENDING}`;

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
      env.DB.prepare(`SELECT id, year, num, title, withdrawn FROM papers WHERE ${where} ORDER BY year DESC, num DESC LIMIT ?1 OFFSET ?2`),
      limit,
      offset,
    ),
  ]);
  return {
    total: Number((count.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    items: (rows.results ?? []) as unknown as MissingItem[],
  };
}

// ---------------------------------------------------------------------------- data

/** All papers of one year: how many have a PDF here, how many wait for review, and how many of the
 *  missing ones were withdrawn (ePrint no longer offers those; only a saved copy fills them). */
interface YearStat {
  year: number;
  total: number;
  have: number;
  pending: number;
  gone: number;
}
const missingOf = (y: YearStat) => y.total - y.have - y.pending;

/** One paper of a year's grid. `title` is only selected for papers without a PDF (the tooltip). */
interface Cell {
  num: number;
  have: number;
  pending: number;
  withdrawn: number;
  title: string | null;
}

/** Small JSON results kept in the colo's cache for a few minutes, so the homepage doesn't scan
 *  every paper on each view. Falls back to computing when the Cache API isn't there. */
async function cached<T>(origin: string, key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const req = new Request(`${origin}/__cache/missing/${key}`);
  try {
    const hit = await caches.default.match(req);
    if (hit) return (await hit.json()) as T;
  } catch {
    /* no cache: compute */
  }
  const v = await fn();
  try {
    await caches.default.put(
      req,
      new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } }),
    );
  } catch {
    /* ignore */
  }
  return v;
}

async function yearStats(env: Env, origin: string): Promise<YearStat[]> {
  return cached(origin, "years-v4", 300, async () => {
    const r = await env.DB.prepare(
      `SELECT year, count(*) AS total, sum(pdf_key IS NOT NULL) AS have,
         sum(pdf_key IS NULL AND ${PENDING}) AS pending,
         sum(pdf_key IS NULL AND withdrawn = 1 AND NOT ${PENDING}) AS gone
       FROM papers GROUP BY year ORDER BY year DESC`,
    ).all<YearStat>();
    return (r.results ?? []).map((y) => ({
      year: y.year,
      total: Number(y.total),
      have: Number(y.have),
      pending: Number(y.pending),
      gone: Number(y.gone),
    }));
  });
}

async function yearCells(env: Env, year: number): Promise<Cell[]> {
  const r = await env.DB.prepare(
    `SELECT num, pdf_key IS NOT NULL AS have, withdrawn,
       (pdf_key IS NULL AND ${PENDING}) AS pending,
       CASE WHEN pdf_key IS NULL THEN title END AS title
     FROM papers WHERE year = ?1 ORDER BY num`,
  )
    .bind(year)
    .all<Cell>();
  return r.results ?? [];
}

/** The year to show first: the one with the most papers still missing (newest on ties). */
function focusYear(years: YearStat[]): YearStat | undefined {
  let best: YearStat | undefined;
  for (const y of years) if (missingOf(y) > 0 && (!best || missingOf(y) > missingOf(best))) best = y;
  return best;
}

// ---------------------------------------------------------------------------- rendering

const papersWord = (n: number) => `${fmtInt(n)} paper${n === 1 ? "" : "s"}`;
const pct = (have: number, total: number) => (total ? Math.floor((100 * have) / total) : 100);

/** One tile per year, filled in green up to the share of papers with a PDF here. */
function yearTiles(years: YearStat[], selected: number | null = null): Html {
  return html`<div class="year-tiles">${years.map((y) => {
    const p = pct(y.have, y.total);
    const m = missingOf(y);
    const tip = `${y.year}: ${fmtInt(y.have)} of ${papersWord(y.total)} have a PDF here${m ? ` · ${fmtInt(m)} missing` : ""}${y.pending ? ` · ${fmtInt(y.pending)} in review` : ""}${y.gone ? ` (${fmtInt(y.gone)} withdrawn)` : ""}`;
    return html`<a class="year-tile${p === 100 ? " full" : ""}${y.year === selected ? " sel" : ""}" href="/missing?year=${y.year}" style="--fill:${p}%" title="${tip}"${y.year === selected ? html` aria-current="page"` : ""}><span class="yt-year">${y.year}</span>${p < 100 ? html`<span class="yt-pct">${p}%</span>` : ""}</a>`;
  })}</div>`;
}

/** One square per paper of a year, in number order. Missing papers link to their upload box and
 *  are the only ones in the tab order; the rest are decoration for assistive tech. Built as one
 *  string: a year has thousands of cells. The small (homepage) grid keeps the markup light: plain
 *  squares for papers we have, and no titles in the tooltips. */
function paperGrid(year: number, cells: Cell[], small = false): Html {
  let out = `<div class="paper-grid${small ? " small" : ""}">`;
  for (const c of cells) {
    const id = canonicalId(year, c.num);
    if (small) {
      if (c.have) out += `<i></i>`;
      else if (c.pending) out += `<i class="p"></i>`;
      else out += `<a class="m" href="/${id}#upload" title="${id} · ${c.withdrawn ? "withdrawn, " : ""}no PDF yet"></a>`;
    } else if (c.have) out += `<a href="/${id}" title="${id}${c.withdrawn ? " · withdrawn" : ""}" tabindex="-1" aria-hidden="true"></a>`;
    else if (c.pending) out += `<a class="p" href="/${id}" title="${esc(`${id} · upload in review · ${c.title ?? ""}`)}"></a>`;
    else {
      const what = c.withdrawn ? "withdrawn, no PDF yet" : "no PDF yet";
      out += `<a class="m" href="/${id}#upload" title="${esc(`${id} · ${what} · ${c.title || (c.withdrawn ? "title unknown" : "Untitled")}`)}"></a>`;
    }
  }
  return raw(out + "</div>");
}

const legend = (cells: Cell[]) => {
  const any = (f: (c: Cell) => unknown) => cells.some(f);
  return html`<ul class="grid-legend small">
  <li><i></i>PDF here</li>
  <li><i class="m"></i>missing: click to upload</li>
  ${any((c) => c.pending) && html`<li><i class="p"></i>upload in review</li>`}
</ul>`;
};

/** Homepage side card. */
export async function missingCard(env: Env, origin: string): Promise<{ card: Html; tex: boolean }> {
  const years = await yearStats(env, origin);
  const total = years.reduce((s, y) => s + y.total, 0);
  const have = years.reduce((s, y) => s + y.have, 0);
  const focus = focusYear(years);
  const cells = focus ? await cached(origin, `cells-v4-${focus.year}`, 300, () => yearCells(env, focus.year)) : [];
  const content = html`<p class="small mb-2"><strong>${fmtInt(have)} of ${papersWord(total)}</strong> have a PDF here.
    ${focus ? "Can you upload a missing one?" : "No paper is waiting for an upload now. Thank you for helping!"}</p>
  ${yearTiles(years)}
  ${focus &&
  html`<p class="small mt-3 mb-1"><strong>${focus.year}</strong>: ${fmtInt(missingOf(focus))} of ${papersWord(focus.total)} still need a PDF.
    Each square is a paper; grey ones are missing.</p>
  ${paperGrid(focus.year, cells, true)}
  ${legend(cells)}
  <p class="mt-2 mb-0"><a href="/missing?year=${focus.year}">See the gaps by year →</a></p>`}`;
  return { card: card("Help us fill the gaps", content, "home-missing"), tex: false };
}

function missingYearParam(url: URL): number | null {
  const y = parseInt(url.searchParams.get("year") ?? "", 10);
  return y >= 1990 && y <= 2200 ? y : null;
}

export async function missingPage(env: Env, url: URL): Promise<Response> {
  const years = await yearStats(env, url.origin);
  const asked = missingYearParam(url);
  const sel = years.find((y) => y.year === asked) ?? (asked === null ? (focusYear(years) ?? years[0]) : undefined);
  const cells = sel ? await yearCells(env, sel.year) : [];
  const missing = years.reduce((s, y) => s + missingOf(y), 0);
  const body = html`<section class="missing-page">
  <div class="results-bar">
    <h4 class="results-h">Help us fill the gaps</h4>
    <small class="ms-auto"><a href="/api/missing${sel ? `?year=${sel.year}` : ""}">JSON</a></small>
  </div>
  <p class="mt-3"><strong>${papersWord(missing)}</strong> ${missing === 1 ? "doesn’t" : "don’t"} have a PDF here yet.
  Grab one from ePrint and upload it on the paper’s page: it’s anonymous, and a matching file appears right away.
</p>
  <h5 class="mt-4">By year</h5>
  ${yearTiles(years, sel?.year ?? null)}
  ${sel
    ? html`<h5 class="mt-4">${sel.year}: ${fmtInt(sel.have)} of ${papersWord(sel.total)} have a PDF here${missingOf(sel)
        ? html`, ${fmtInt(missingOf(sel))} missing`
        : ""}</h5>
  <p class="small mb-2">Each square is a paper, in number order. Hover for its ID; click a grey one to upload its PDF.</p>
  ${paperGrid(sel.year, cells)}
  ${legend(cells)}`
    : html`<p class="mt-4">No papers from ${asked} here. Pick a year above.</p>`}
</section>`;
  return page(env, {
    title: asked === null ? "Papers missing a PDF" : `Papers from ${asked} missing a PDF`,
    description: "Papers that don’t have a PDF on the mirror yet. Upload one to help fill the gaps.",
    body,
    noindex: true,
    cache: "public, max-age=300",
  });
}

// ---------------------------------------------------------------------------- API

interface MissingParams {
  page: number;
  year: number | null;
}

function missingParams(url: URL): MissingParams {
  const page = Math.min(10_000, Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
  return { page, year: missingYearParam(url) };
}

function missingHref(path: string, mp: MissingParams, page: number): string {
  const u = new URLSearchParams();
  if (mp.year !== null) u.set("year", String(mp.year));
  if (page > 1) u.set("page", String(page));
  const q = u.toString();
  return q ? `${path}?${q}` : path;
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
        withdrawn: !!p.withdrawn,
        url: `${origin}/${p.id}`,
        original_url: originalUrl(env.ORIGIN_BASE, p.id),
        upload_url: `${origin}/${p.id}#upload`,
      })),
    },
    200,
    "public, max-age=300",
  );
}
