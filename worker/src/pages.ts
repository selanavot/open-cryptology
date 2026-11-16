import { contactForm } from "./contact";
import { homeData, parseAuthors, search, toFtsQuery, type Env, type ListItem, type SearchHit } from "./db";
import { highlighted, html, stripMarks, type Html } from "./html";
import { categoryBadge, hasTex, messagePage, page } from "./layout";
import { missingCard } from "./years";
import { ogImage, siteOrigin } from "./seo";
import { latestManuscripts, searchManuscripts } from "./manuscripts";

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

// The letter is Sela's (drafted together on 2026-11-16); don't reword it without asking.
export async function homePage(env: Env, url: URL): Promise<Response> {
  const [{ gapsYear }, latest] = await Promise.all([missingCard(env, url.origin), latestManuscripts(env, 6)]);
  const body = html`<div class="hm">
  <div class="hm-cta">
    <a class="btn hm-primary hm-submit" href="/submit">Submit an original manuscript</a>
  </div>
  <article class="home-letter hm-letter">
    <p>Hello cryptographers!</p>
    <p>Research is changing. AI agents now help with everything from literature review to finding
    attacks, results come faster, and more of them come from new kinds of collaboration. The
    traditional publishing model, ePrint included, wasn’t built for this: it is slow to post, it has
    no way to say who or what did the work, and its papers are hard for agents to read.</p>
    <p>Open Cryptology offers two things:</p>
    <p><strong>Original manuscripts.</strong> <a href="/submit">Post a result</a> the day you have it:
    an attack, a bound, a proof sketch, an open question. It is public right away at a permanent,
    citable link, and the authors line says who did the work, people or models.</p>
    <p><strong>Everything in one place, for you and your agents.</strong> All
    <a href="/manuscripts">original manuscripts</a>, plus an unofficial, non-commercial
    <a href="/eprint">mirror</a> of the <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>,
    searchable and readable by AI agents. New ePrint papers appear within days, and readers
    <a href="/${gapsYear}">fill in the gaps</a> when a PDF is missing.</p>
    <p><strong>What’s next.</strong> The vision is a one-stop place for everything known about each
    paper, kept up to date as cryptography moves on: discussion, links between papers and the
    protocols they build on, and known attacks on each construction.</p>
    <p>Something wrong or missing? <a href="#contact">Write to us</a> or
    <a href="${env.ISSUES_URL}">open an issue</a>. Want to help? Get in touch!</p>
    <details id="contact" class="contact-panel"${url.searchParams.has("paper") ? html` open` : ""}>
      <summary>Write to us</summary>
      ${contactForm(env, url)}
    </details>
  </article>
  <section class="hm-latest" aria-labelledby="hm-latest-h">
    <div class="hm-latest-head"><h2 class="ms-day" id="hm-latest-h">Latest original manuscripts</h2>${latest.count ? html`<a class="ms-more" href="/manuscripts">All →</a>` : ""}</div>
    ${latest.rows ?? html`<p class="text-muted small">None yet. <a href="/submit">Be the first.</a></p>`}
  </section>
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
  const [{ card, gapsYear }, { latest }] = await Promise.all([missingCard(env, url.origin), homeData(env, 10)]);
  const body = html`<div class="ep-head">
  <h1 class="ms-title">ePrint papers</h1>
  <p class="ep-lede">An unofficial, non-commercial mirror of the <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>,
  readable by you and your AI agents. New papers appear within days of being accepted on ePrint; to post one,
  <a href="${env.ORIGIN_BASE}/submit" rel="noopener">submit to ePrint</a> as usual. Missing a PDF? <a href="/${gapsYear}">Fill in the gaps</a>.</p>
</div>
<div class="ep-grid">
  <section>
    <div class="hm-latest-head"><h2 class="ms-day">Newest ePrint papers</h2><a class="ms-more" href="/search">More →</a></div>
    <ol class="ms-list">${latest.map((p) => html`<li class="ms-row"><div class="ms-row-main">
      <a class="ms-row-title tex" href="/${p.id}">${p.title || "Untitled"}</a>${p.category ? html` ${categoryBadge(p.category)}` : ""}
      <div class="ms-row-authors">${authorLine(parseAuthors(p.authors))}</div></div></li>`)}</ol>
  </section>
  <aside class="home-side ep-side">${card}</aside>
</div>`;
  return page(env, {
    title: "ePrint papers",
    description: "An unofficial, non-commercial mirror of the Cryptology ePrint Archive: every paper, readable by people and AI agents.",
    body,
    canonical: `${siteOrigin(env, url)}/eprint`,
    katex: hasTex(...latest.map((p) => p.title)),
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
