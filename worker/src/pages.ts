import { homeData, parseAuthors, search, toFtsQuery, type Env, type ListItem, type SearchHit } from "./db";
import { highlighted, html, stripMarks, type Html } from "./html";
import { categoryBadge, hasTex, messagePage, page } from "./layout";
import { missingCard, yearStats } from "./years";
import { ogImage, siteOrigin } from "./seo";
import { manuscriptsAtAGlance, searchManuscripts } from "./manuscripts";

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
export const fmtInt = (n: number): string => n.toLocaleString("en-US");

function authorLine(names: string[], max = 6): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, and ${names.length - max} more`;
}

/** ePrint search-results entry. */
function resultItem(p: ListItem, hit?: SearchHit): Html {
  const authors = (() => {
    if (!hit) return parseAuthors(p.authors);
    const a = parseAuthors(hit.authors_hl);
    return a.length ? a : parseAuthors(p.authors);
  })();
  const titleText = p.title || (p.withdrawn ? "Withdrawn paper" : "Untitled");
  return html`<div class="result">
  <div class="result-head"><a class="paperlink" href="/${p.id}">${p.id}</a>
    ${p.has_pdf ? html`<span><a href="/${p.id}.pdf">(PDF)</a></span>` : ""}
    ${p.withdrawn ? html`<span class="badge bg-secondary" title="Withdrawn by the authors${p.withdrawn_on ? ` on ${day(p.withdrawn_on)}` : ""}">withdrawn</span>` : ""}
    ${p.submitted && html`<small class="ms-auto">Submitted: ${day(p.submitted)}</small>`}
  </div>
  <div class="result-body">
    <div class="result-row">
      <div>
        <strong class="tex"><a class="result-title" href="/${p.id}">${hit && hit.title_hl ? highlighted(hit.title_hl) : titleText}</a></strong>
        <div class="result-authors">${hit ? highlighted(authorLine(authors)) : authorLine(authors)}</div>
      </div>
      ${p.category && html`<div class="result-cat">${categoryBadge(p.category)}</div>`}
    </div>
    ${hit?.snip && html`<p class="search-abstract">${highlighted(hit.snip)}</p>`}
  </div>
</div>`;
}

// ---------------------------------------------------------------------------- home

/** Small line icons for the homepage tiles (stroke follows the text color). */
function icon(name: "file" | "archive" | "mail"): Html {
  const d = {
    file: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
    archive: "M4 5h16v4H4zM5 9v10h14V9M10 13h4",
    mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  }[name];
  return html`<svg class="pt-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** Papers per year, oldest to newest, as a small bar chart. */
function yearBars(years: { year: number; total: number }[]): Html {
  const ys = [...years].sort((a, b) => a.year - b.year);
  if (!ys.length) return html``;
  const max = Math.max(...ys.map((y) => y.total));
  const w = 6, gap = 2, h = 48;
  const width = ys.length * (w + gap) - gap;
  return html`<figure class="pt-bars"><svg viewBox="0 0 ${width} ${h}" preserveAspectRatio="none" role="img" aria-label="ePrint papers per year, ${ys[0].year} to ${ys[ys.length - 1].year}">
${ys.map((y, i) => { const bh = Math.max(1, Math.round((y.total / max) * h)); return html`<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1"><title>${y.year}: ${fmtInt(y.total)} papers</title></rect>`; })}
</svg><figcaption><span>${ys[0].year}</span><span>${ys[ys.length - 1].year}</span></figcaption></figure>`;
}

// The letter is Sela's (drafted together on 2026-11-16); don't reword it without asking.
export async function homePage(env: Env, url: URL): Promise<Response> {
  const [ms, years] = await Promise.all([manuscriptsAtAGlance(env, 2), yearStats(env, url.origin)]);
  const papers = years.reduce((n, y) => n + y.total, 0);
  const body = html`<div class="hm">
  <article class="home-letter hm-letter">
    <p>Hello cryptographers!</p>
    <p>Research is changing, and so is the way we share it. Open Cryptology does two things:</p>
    <p><strong>1. Original manuscripts.</strong> Anything useful goes: a result, an open problem, an
    unverified idea from your agent, or the approaches it spent tokens on that didn’t work. Each gets
    published immediately with a citable link, and authorship is flexible: humans, models, or the
    universe itself.</p>
    <p><strong>2. An ePrint mirror.</strong> Agents need prior work, but the Cryptology ePrint Archive
    blocks them from fetching PDFs. Our unofficial, non-commercial mirror gives them access.</p>
    <p><strong>What’s next.</strong> One place for everything known about each paper: discussion,
    links between papers and the protocols they build on, and known attacks. Ideas welcome!</p>
    <p>Something wrong or missing? Want to help? Get in touch!</p>
  </article>
  <div class="pt-col">
    <section class="pt">
      <h2><a class="pt-link" href="/manuscripts">${icon("file")} Original manuscripts</a></h2>
      <p class="pt-sub">Post anything, published instantly</p>
      ${ms.latest.length ? html`<ul class="pt-titles">${ms.latest.map((m) => html`<li class="tex">${m.title}</li>`)}</ul>` : ""}
      <a class="pt-action" href="/submit">Submit a manuscript</a>
    </section>
    <section class="pt">
      <h2><a class="pt-link" href="/eprint">${icon("archive")} ePrint mirror</a></h2>
      <p class="pt-sub">${fmtInt(papers)} papers, readable by agents</p>
      ${yearBars(years)}
    </section>
    <section class="pt">
      <h2><a class="pt-link" href="/contact">${icon("mail")} Get in touch</a></h2>
      <p class="pt-sub">Something wrong or missing? Want to help?</p>
      <a class="pt-action" href="${env.ISSUES_URL}">Open an issue</a>
    </section>
  </div>
</div>`;
  return page(env, {
    title: env.SITE_NAME,
    description:
      "Original manuscripts in cryptography, published the day you post them, and an unofficial mirror of the Cryptology ePrint Archive: readable by people and AI agents.",
    body,
    canonical: `${siteOrigin(env, url)}/`,
    ogImage: ogImage(siteOrigin(env, url)),
    katex: true,
    cache: "public, max-age=120",
  });
}

// ---------------------------------------------------------------------------- ePrint papers

/** /eprint: what the mirror is, the newest ePrint papers, and the papers-by-year card. Paper pages
 *  keep their URLs (/2024/123). */
export async function eprintPage(env: Env, url: URL): Promise<Response> {
  const { card, gapsYear } = await missingCard(env, url.origin);
  const body = html`<h1 class="ms-title">ePrint papers</h1>
<div class="ep-layout">
<div class="home-side ep-main">${card}</div>
<aside class="ep-text">
  <p>An unofficial, non-commercial mirror of the <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>,
  readable by you and your AI agents.</p>
  <ul class="ep-points">
    <li><strong>New papers</strong> appear here within days of being accepted on ePrint; to post one,
    <a href="${env.ORIGIN_BASE}/submit" rel="noopener">submit to ePrint</a> as usual.</li>
    <li><strong>PDFs</strong> come from existing public copies, and readers <a href="/${gapsYear}">fill in the gaps</a>: if one is
    missing, download it from ePrint and upload it anonymously here.</li>
    <li><strong>Licenses.</strong> Every paper keeps its authors’ license and links back to the original. Please respect it.</li>
  </ul>
</aside>
</div>`;
  return page(env, {
    title: "ePrint papers",
    description: "An unofficial, non-commercial mirror of the Cryptology ePrint Archive: every paper, readable by people and AI agents.",
    body,
    canonical: `${siteOrigin(env, url)}/eprint`,
    cache: "public, max-age=300",
  });
}

// ---------------------------------------------------------------------------- search

const PER_PAGE = 20;
const MAX_PAGE = 50;

/** Recognise "2024/123", "ia.cr/2024/123", "https://eprint.iacr.org/2024/123.pdf". */
export function idFromQuery(q: string): string | null {
  const m = /^\s*(?:https?:\/\/)?(?:(?:eprint\.iacr\.org|ia\.cr)\/)?(\d{4})\s*\/\s*(\d{1,5})(?:\.pdf)?\/?\s*$/i.exec(q);
  if (!m) return null;
  return `${m[1]}/${String(Number(m[2])).padStart(3, "0")}`;
}

export interface SearchParams {
  q: string;
  page: number;
  sort: "relevance" | "new";
}

export function searchParams(url: URL): SearchParams {
  const q = (url.searchParams.get("q") ?? "").slice(0, 300);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const sort = url.searchParams.get("sort") === "new" ? "new" : "relevance";
  return { q, page, sort };
}

export async function runSearch(env: Env, sp: SearchParams) {
  const fts = toFtsQuery(sp.q);
  if (!fts) return { fts, total: 0, hits: [] as SearchHit[], error: null as string | null };
  try {
    const r = await search(env, fts, sp.page, PER_PAGE, sp.sort);
    return { fts, ...r, error: null };
  } catch (e) {
    console.warn("search failed", fts, String(e));
    return { fts, total: 0, hits: [] as SearchHit[], error: "Could not run that search." };
  }
}

export async function searchPage(env: Env, url: URL): Promise<Response> {
  const sp = searchParams(url);
  sp.page = Math.min(sp.page, MAX_PAGE);
  const id = idFromQuery(sp.q);
  if (id) return Response.redirect(new URL(`/${id}`, url).toString(), 302);
  const [{ fts, total, hits, error }, ms] = await Promise.all([
    runSearch(env, sp),
    sp.page === 1 && toFtsQuery(sp.q) ? searchManuscripts(env, sp.q, 10) : Promise.resolve({ rows: null, count: 0 }),
  ]);
  // With no query, the results column lists the most recent papers ("Papers" in the navbar).
  const recent = fts ? [] : (await homeData(env, PER_PAGE)).latest;
  const pages = Math.min(MAX_PAGE, Math.ceil(total / PER_PAGE));
  const link = (p: number, sort = sp.sort) => {
    const u = new URLSearchParams({ q: sp.q });
    if (sort !== "relevance") u.set("sort", sort);
    if (p > 1) u.set("page", String(p));
    return `/search?${u}`;
  };
  const body = html`<div class="search-layout">
  <div class="search-form-col">
    <form class="search-form" method="get" action="/search" role="search">
      <label for="anything" class="form-label">Match anything</label>
      <input type="text" name="q" class="form-control form-control-sm" id="anything" value="${sp.q}" placeholder="Words, &quot;a phrase&quot;, or 2024/123">
      <label for="sort" class="form-label mt-4">Sort by</label>
      <select class="form-select form-select-sm" id="sort" name="sort">
        <option value="relevance"${sp.sort === "relevance" ? html` selected` : ""}>Relevance</option>
        <option value="new"${sp.sort === "new" ? html` selected` : ""}>Newest first</option>
      </select>
      <div class="mt-3"><button class="btn btn-outline-dark btn-sm" type="submit">Search</button></div>
    </form>
    <div class="search-help small">
      <p class="mb-1"><strong>Tips</strong></p>
      <ul>
        <li><code>"zero knowledge"</code> matches a phrase</li>
        <li><code>lattic*</code> matches a prefix</li>
        <li><code>author:boneh</code>, <code>title:snark</code> or <code>abstract:…</code> target one field</li>
        <li>an ID like <code>2024/123</code> goes straight to the paper</li>
      </ul>
    </div>
  </div>
  <div class="search-results-col">
    ${!fts
      ? html`<h4 class="results-h">Recent ePrint papers</h4>
      <div class="results">${recent.map((p) => resultItem(p))}</div>`
      : html`${ms.rows && html`<section class="search-ms"><h4 class="results-h">Original manuscripts</h4>${ms.rows}</section>`}
      <div class="results-bar">
        <h4 class="results-h">${error ? error : html`${fmtInt(total)} ePrint paper${total === 1 ? "" : "s"} sorted by ${sp.sort === "new" ? "date" : "relevance"}`}</h4>
        <small class="ms-auto">${pages > 1 ? html`Page ${sp.page} of ${pages} · ` : ""}Sort:
          ${sp.sort === "relevance" ? html`<strong>relevance</strong>` : html`<a href="${link(1, "relevance")}">relevance</a>`} ·
          ${sp.sort === "new" ? html`<strong>newest</strong>` : html`<a href="${link(1, "new")}">newest</a>`}
          · <a href="/api/search?${new URLSearchParams({ q: sp.q }).toString()}">JSON</a></small>
      </div>
      <div class="results">${hits.map((h) => resultItem(h, h))}</div>
      ${pages > 1 &&
      html`<nav class="pager" aria-label="Pagination">
        ${sp.page > 1 ? html`<a class="btn btn-outline-dark btn-sm" href="${link(sp.page - 1)}" rel="prev">← Previous</a>` : html`<span></span>`}
        ${sp.page < pages ? html`<a class="btn btn-outline-dark btn-sm" href="${link(sp.page + 1)}" rel="next">Next →</a>` : html`<span></span>`}
      </nav>`}`}
  </div>
</div>`;
  return page(env, {
    title: sp.q ? `Search: ${sp.q}` : "Search",
    body,
    query: sp.q,
    noindex: true,
    katex: !!ms.rows || (fts ? hasTex(...hits.map((h) => stripMarks(h.title_hl ?? ""))) : hasTex(...recent.map((p) => p.title))),
    cache: "public, max-age=60",
  });
}

export async function apiSearch(env: Env, url: URL): Promise<Response> {
  const sp = searchParams(url);
  const origin = url.origin;
  const id = idFromQuery(sp.q);
  const beyond = sp.page > MAX_PAGE;
  const { total, hits, error } = beyond ? { total: 0, hits: [], error: undefined } : await runSearch(env, sp);
  const totalPages = Math.min(MAX_PAGE, Math.ceil(total / PER_PAGE));
  const next = sp.page < totalPages ? (() => { const u = new URL(url); u.searchParams.set("page", String(sp.page + 1)); return u.toString(); })() : null;
  return json(
    {
      query: sp.q,
      id_match: id ? { id, url: `${origin}/${id}`, api_url: `${origin}/api/papers/${id}` } : null,
      total,
      page: sp.page,
      per_page: PER_PAGE,
      total_pages: totalPages,
      next,
      sort: sp.sort,
      error,
      results: hits.map((h) => ({
        id: h.id,
        title: h.title,
        authors: parseAuthors(h.authors),
        category: h.category,
        license: h.license_code,
        submitted: h.submitted,
        withdrawn: !!h.withdrawn,
        withdrawn_on: h.withdrawn_on ?? null,
        has_pdf: !!h.has_pdf,
        snippet: h.snip ? stripMarks(h.snip) : null,
        url: `${origin}/${h.id}`,
        api_url: `${origin}/api/papers/${h.id}`,
        pdf_url: h.has_pdf ? `${origin}/${h.id}.pdf` : null,
        upload_url: h.has_pdf ? null : `${origin}/${h.id}#upload`,
      })),
    },
    error ? 400 : 200,
    "public, max-age=60",
  );
}

export function json(data: unknown, status = 200, cache = "public, max-age=300"): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------------------- about / api docs

export function notFound(env: Env, what = "Page not found"): Response {
  return messagePage(env, 404, what, html`<p>Try the <a href="/search">search</a> or go to the <a href="/">homepage</a>.</p>`);
}
