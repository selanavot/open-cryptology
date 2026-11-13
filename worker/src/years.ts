// Papers by year: the homepage card and the year pages (/YYYY). Each year page shows how much of
// the year we have as squares, then lists every paper of the year; it is also how crawlers reach
// the paper pages (search is noindex).
//
// A paper counts as missing while it has no mirrored PDF and no upload waiting for review.
// Withdrawn papers count too: ePrint no longer offers them, but a saved copy can be uploaded.
//
// Coverage is shown as squares: one tile per year, filled in green up to the share of its papers we
// have up to date, then yellow for those that may be outdated, and its percentage counts the green
// ones only; and one small square per paper of a year (green = PDF here, grey = missing, yellow =
// may be outdated (ePrint changed the paper after our copy was captured), blue = upload in review;
// grey and yellow ones link to the upload box).
import { canonicalId, parseAuthors, type Env } from "./db";
import { esc, html, raw, type Html } from "./html";
import { card, hasTex, messagePage, page } from "./layout";
import { fmtInt } from "./pages";
import { ogImage, siteOrigin } from "./seo";

const PENDING = `EXISTS (SELECT 1 FROM uploads u WHERE u.paper_id = papers.id AND u.status = 'pending')`;
/** We have a PDF, but ePrint changed the paper after it was captured (papers.pdf_maybe_stale, set
 *  by the harvest): a newer version may exist. Withdrawn papers are never "outdated". */
const STALE = `(pdf_key IS NOT NULL AND pdf_maybe_stale = 1 AND withdrawn = 0)`;

// ---------------------------------------------------------------------------- data

/** All papers of one year: how many have a PDF here, how many wait for review, how many of the
 *  missing ones were withdrawn (ePrint no longer offers those; only a saved copy fills them), and
 *  how many we have but may be outdated (counted in `have` too; none with an upload in review). */
interface YearStat {
  year: number;
  total: number;
  have: number;
  pending: number;
  gone: number;
  outdated: number;
}
const missingOf = (y: YearStat) => y.total - y.have - y.pending;

/** One paper of a year's grid. `title` is only selected for the papers that ask for an upload
 *  (the tooltip). `pending`: an upload waits for review (for a missing or an outdated PDF). */
interface Cell {
  num: number;
  have: number;
  pending: number;
  outdated: number;
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

/** Drop the cached counts after a paper's PDF or upload state changes, so this colo's homepage and
 *  year pages show it on the next view (other colos catch up within the 5-minute TTL). */
export async function coverageChanged(origin: string, paperId: string): Promise<void> {
  const year = paperId.slice(0, 4);
  try {
    await Promise.all(
      [YEARS_KEY, `${CELLS_KEY}-${year}`].map((k) => caches.default.delete(new Request(`${origin}/__cache/missing/${k}`))),
    );
  } catch {
    /* no cache */
  }
}
const YEARS_KEY = "years-v5";
const CELLS_KEY = "cells-v5";

/** A year's counts from its (fresh) cells, the same way yearStats counts them. */
function statOf(year: number, cells: Cell[]): YearStat {
  const s = { year, total: cells.length, have: 0, pending: 0, gone: 0, outdated: 0 };
  for (const c of cells) {
    if (c.have) {
      s.have++;
      if (c.outdated) s.outdated++;
    } else if (c.pending) s.pending++;
    else if (c.withdrawn) s.gone++;
  }
  return s;
}

async function yearStats(env: Env, origin: string): Promise<YearStat[]> {
  return cached(origin, YEARS_KEY, 300, async () => {
    const r = await env.DB.prepare(
      `SELECT year, count(*) AS total, sum(pdf_key IS NOT NULL) AS have,
         sum(pdf_key IS NULL AND ${PENDING}) AS pending,
         sum(pdf_key IS NULL AND withdrawn = 1 AND NOT ${PENDING}) AS gone,
         sum(${STALE} AND NOT ${PENDING}) AS outdated
       FROM papers GROUP BY year ORDER BY year DESC`,
    ).all<YearStat>();
    return (r.results ?? []).map((y) => ({
      year: y.year,
      total: Number(y.total),
      have: Number(y.have),
      pending: Number(y.pending),
      gone: Number(y.gone),
      outdated: Number(y.outdated),
    }));
  });
}

async function yearCells(env: Env, year: number): Promise<Cell[]> {
  const r = await env.DB.prepare(
    `SELECT num, pdf_key IS NOT NULL AS have, withdrawn,
       ((pdf_key IS NULL OR ${STALE}) AND ${PENDING}) AS pending,
       (${STALE} AND NOT ${PENDING}) AS outdated,
       CASE WHEN pdf_key IS NULL OR ${STALE} THEN title END AS title
     FROM papers WHERE year = ?1 ORDER BY num`,
  )
    .bind(year)
    .all<Cell>();
  return r.results ?? [];
}

/** The year to show first: the most recent one with papers still missing (`years` is newest first). */
const focusYear = (years: YearStat[]): YearStat | undefined => years.find((y) => missingOf(y) > 0);

// ---------------------------------------------------------------------------- rendering

const papersWord = (n: number) => `${fmtInt(n)} paper${n === 1 ? "" : "s"}`;
const pct = (have: number, total: number) => (total ? Math.floor((100 * have) / total) : 100);

/** Share of a year's papers as a CSS length for the tile gradient (unrounded, so a sliver still shows). */
const share = (n: number, total: number) => `${total ? ((100 * n) / total).toFixed(2) : 100}%`;

/** One tile per year, filled from the bottom: green for papers with an up-to-date PDF here, then
 *  yellow for those whose PDF may be outdated, light grey for the rest. The label is the green share. */
function yearTiles(years: YearStat[], selected: number | null = null): Html {
  return html`<div class="year-tiles">${years.map((y) => {
    const current = y.have - y.outdated;
    const p = pct(current, y.total);
    const m = missingOf(y);
    const tip = `${y.year}: ${fmtInt(y.have)} of ${papersWord(y.total)} have a PDF here${m ? ` · ${fmtInt(m)} missing` : ""}${y.gone ? ` (${fmtInt(y.gone)} withdrawn)` : ""}${y.outdated ? ` · ${fmtInt(y.outdated)} may be outdated` : ""}${y.pending ? ` · ${fmtInt(y.pending)} in review` : ""}`;
    return html`<a class="year-tile${p === 100 ? " full" : ""}${y.year === selected ? " sel" : ""}" href="/${y.year}" style="--cur:${share(current, y.total)};--fill:${share(y.have, y.total)}" title="${tip}"${y.year === selected ? html` aria-current="page"` : ""}><span class="yt-year">${y.year}</span>${p < 100 ? html`<span class="yt-pct">${p}%</span>` : ""}</a>`;
  })}</div>`;
}

/** One square per paper of a year, in number order, each a link to its paper. Missing and outdated
 *  papers link to their upload box and are the only ones in the tab order; the rest are hidden from
 *  assistive tech. Built as one string: a year has thousands of cells. The small (homepage) grid keeps
 *  the markup light: no titles in the tooltips. */
function paperGrid(year: number, cells: Cell[], small = false): Html {
  let out = `<div class="paper-grid${small ? " small" : ""}">`;
  for (const c of cells) {
    const id = canonicalId(year, c.num);
    if (small) {
      if (c.pending) out += `<a class="p" href="/${id}" title="${id} · upload in review" tabindex="-1" aria-hidden="true"></a>`;
      else if (c.outdated) out += `<a class="o" href="/${id}#upload" title="${id} · may be outdated"></a>`;
      else if (c.have) out += `<a href="/${id}" title="${id}" tabindex="-1" aria-hidden="true"></a>`;
      else out += `<a class="m" href="/${id}#upload" title="${id} · ${c.withdrawn ? "withdrawn, " : ""}no PDF yet"></a>`;
    } else if (c.pending) out += `<a class="p" href="/${id}" title="${esc(`${id} · upload in review · ${c.title ?? ""}`)}"></a>`;
    else if (c.outdated) out += `<a class="o" href="/${id}#upload" title="${esc(`${id} · may be outdated: ePrint changed it after our copy · ${c.title ?? ""}`)}"></a>`;
    else if (c.have) out += `<a href="/${id}" title="${id}${c.withdrawn ? " · withdrawn" : ""}" tabindex="-1" aria-hidden="true"></a>`;
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
  <li><i class="m"></i>missing</li>
  ${any((c) => c.outdated) && html`<li><i class="o"></i>may be outdated</li>`}
  ${any((c) => c.pending) && html`<li><i class="p"></i>in review</li>`}
</ul>`;
};

/** The homepage card's grid of one year, with arrows to the year before and after it. Without JS
 *  the arrows go to those years' pages; app.js swaps in /__grid/YYYY (gridFragment) instead. */
function homeGrid(years: YearStat[], shown: YearStat, cells: Cell[]): Html {
  const i = years.findIndex((y) => y.year === shown.year);
  const older = years[i + 1];
  const newer = i > 0 ? years[i - 1] : undefined;
  const arrow = (y: YearStat | undefined, cls: string, label: string, glyph: string) =>
    y
      ? html`<a class="grid-nav ${cls}" href="/${y.year}" data-grid-year="${y.year}" aria-label="${label} (${y.year})" title="${y.year}">${glyph}</a>`
      : html`<span class="grid-nav ${cls} off" aria-hidden="true">${glyph}</span>`;
  const m = missingOf(shown);
  return html`<div class="home-grid" data-year="${shown.year}">
  <p class="grid-head small mt-3 mb-1">${arrow(older, "prev", "Previous year", "‹")}<span><strong>${shown.year}</strong> · ${m ? `${fmtInt(m)} missing` : "none missing"}</span>${arrow(newer, "next", "Next year", "›")}</p>
  ${paperGrid(shown.year, cells, true)}
  ${legend(cells)}
  <p class="mt-2 mb-0"><a href="/${shown.year}">See all papers from ${shown.year} →</a></p>
</div>`;
}

const yearCellsCached = (env: Env, origin: string, year: number) =>
  cached(origin, `${CELLS_KEY}-${year}`, 300, () => yearCells(env, year));

/** Homepage side card (its grid starts at the newest year), and the year page to send people who
 *  want to fill gaps to. */
export async function missingCard(env: Env, origin: string): Promise<{ card: Html; tex: boolean; gapsYear: number }> {
  const years = await yearStats(env, origin);
  const total = years.reduce((s, y) => s + y.total, 0);
  const have = years.reduce((s, y) => s + y.have, 0);
  const focus = focusYear(years);
  const shown = years[0];
  const cells = shown ? await yearCellsCached(env, origin, shown.year) : [];
  const content = html`<p class="small mb-2"><strong>${fmtInt(have)} of ${papersWord(total)}</strong> have a PDF here.
    ${focus ? "Can you upload a missing one?" : "No paper is waiting for an upload now. Thank you for helping!"}</p>
  ${yearTiles(years)}
  ${shown && homeGrid(years, shown, cells)}`;
  return { card: card("Papers by year", content, "home-missing"), tex: false, gapsYear: (focus ?? shown)?.year ?? new Date().getUTCFullYear() };
}

/** /__grid/YYYY: the homepage card's grid for another year (HTML fragment, fetched by app.js). */
export async function gridFragment(env: Env, origin: string, year: number): Promise<Response> {
  const years = await yearStats(env, origin);
  const shown = years.find((y) => y.year === year);
  const headers = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" };
  if (!shown) return new Response("No papers from that year\n", { status: 404, headers: { ...headers, "cache-control": "no-store" } });
  const cells = await yearCellsCached(env, origin, year);
  return new Response(homeGrid(years, shown, cells).toString(), { headers: { ...headers, "cache-control": "public, max-age=300" } });
}

/** A year's papers, newest first, with what the grid needs. */
interface YearRow extends Cell {
  id: string;
  authors: string;
}

/** /YYYY: coverage of the year (tiles, squares), then every paper of the year. */
export async function yearPage(env: Env, url: URL, year: number): Promise<Response> {
  const [cachedYears, r] = await Promise.all([
    yearStats(env, url.origin),
    env.DB.prepare(
      `SELECT id, num, title, authors, pdf_key IS NOT NULL AS have, withdrawn,
         ((pdf_key IS NULL OR ${STALE}) AND ${PENDING}) AS pending,
         (${STALE} AND NOT ${PENDING}) AS outdated
       FROM papers WHERE year = ?1 ORDER BY num`,
    )
      .bind(year)
      .all<YearRow>(),
  ]);
  const rows = r.results ?? [];
  if (!rows.length) {
    return messagePage(env, 404, `No papers from ${year}`, html`<p>The mirror has no papers from ${year}. Pick a year:</p>${yearTiles(cachedYears)}`);
  }
  // The selected year is read fresh; its tile and heading come from the same read, so they agree
  // right after an upload even while the other years come from the cache.
  const sel = statOf(year, rows);
  const years = cachedYears.map((y) => (y.year === year ? sel : y));
  const missing = missingOf(sel);
  // Withdrawn papers we know nothing about have no page worth listing (still a square in the grid).
  const listed = rows.filter((p) => !p.withdrawn || p.title).reverse();
  const origin = siteOrigin(env, url);
  const body = html`<section class="year-page">
  <h3 class="mb-3">Papers from ${year}</h3>
  ${yearTiles(years, year)}
  <h5 class="mt-4">${papersWord(sel.total)}${missing ? html` · ${fmtInt(missing)} missing` : ""}${sel.outdated ? html` · ${fmtInt(sel.outdated)} may be outdated` : ""}</h5>
  ${!!(missing || sel.outdated) && html`<p class="small mb-2">Click a grey or yellow square to upload.</p>`}
  ${paperGrid(year, rows)}
  ${legend(rows)}
  <h5 class="mt-4">All ${papersWord(listed.length)}, newest first</h5>
  <ol class="year-list">
    ${listed.map((p) => {
      const authors = parseAuthors(p.authors);
      const status = p.pending
        ? html` <span class="text-muted small">upload in review</span>`
        : p.outdated
        ? html` <a class="small" href="/${p.id}#upload">may be outdated: upload the latest</a>`
        : p.have
        ? html` <a href="/${p.id}.pdf">(PDF)</a>`
        : html` <a class="small" href="/${p.id}#upload">no PDF yet: upload it</a>`;
      return html`<li><a class="paperlink" href="/${p.id}">${p.id}</a>${status}${p.withdrawn ? html` <span class="badge bg-secondary">withdrawn</span>` : ""}
      <div><a class="result-title tex" href="/${p.id}">${p.title || "Withdrawn paper"}</a>${authors.length ? html`<span class="year-authors"> · ${authors.length > 6 ? `${authors.slice(0, 6).join(", ")}, and ${authors.length - 6} more` : authors.join(", ")}</span>` : ""}</div></li>\n`;
    })}
  </ol>
</section>`;
  return page(env, {
    title: `Papers from ${year}`,
    description: `All ${fmtInt(listed.length)} papers from the Cryptology ePrint Archive in ${year}, with abstracts and PDFs, on Open Cryptology.`,
    body,
    canonical: `${origin}/${year}`,
    ogImage: ogImage(origin),
    katex: hasTex(...listed.map((p) => p.title)),
    cache: "public, max-age=300",
  });
}
