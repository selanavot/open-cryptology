import { contactForm } from "./contact";
import { homeData, parseAuthors, search, toFtsQuery, type Env, type ListItem, type SearchHit } from "./db";
import { highlighted, html, stripMarks, type Html } from "./html";
import { categoryBadge, hasTex, messagePage, page } from "./layout";
import { missingCard } from "./years";
import { ogImage, siteOrigin } from "./seo";

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

export async function homePage(env: Env, url: URL): Promise<Response> {
  const missing = await missingCard(env, url.origin);
  const body = html`<div class="home-layout">
  <form method="get" action="/search" role="search" class="home-search">
    <div class="input-group">
      <input type="text" name="q" class="form-control" placeholder="Search, or go to 2024/123" aria-label="Search titles, authors and abstracts, or enter a paper ID">
      <button class="btn btn-outline-dark" type="submit">Search</button>
    </div>
  </form>
  <article class="home-letter">
    <p>Hello cryptographers!</p>
    <p>This is an unofficial, non-commercial mirror of the
    <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>. ePrint’s access control blocks AI
    agents from fetching PDFs; this mirror lets them read prior work for literature review, search
    and more.</p>
    <p><strong>New papers</strong> appear here within days of being accepted on ePrint. We don’t
    take submissions; <a href="${env.ORIGIN_BASE}/submit" rel="noopener">submit to ePrint</a> as usual.</p>
    <p><strong>PDFs</strong> come from public copies; readers <a href="/${missing.gapsYear}">fill in the gaps</a>.</p>
    <p><strong>Licenses.</strong> Every paper keeps its authors’ license and links back to the
    original. Please respect it: credit the authors, no commercial use for NC papers, unmodified
    copies only for ND.</p>
    <p><strong>What’s next.</strong> One place for everything known about each paper: discussion,
    the protocols it builds on, and known attacks.</p>
    <p>Something wrong or missing? <a href="#contact">Write to us</a> or
    <a href="${env.ISSUES_URL}">open an issue</a>. Want to help? Get in touch!</p>
    <details id="contact" class="contact-panel"${url.searchParams.has("paper") ? html` open` : ""}>
      <summary>Write to us</summary>
      ${contactForm(env, url)}
    </details>
  </article>
  <aside class="home-side">
    ${missing.card}
  </aside>
</div>`;
  return page(env, {
    title: env.SITE_NAME,
    description:
      "Unofficial mirror of the Cryptology ePrint Archive: fast search and easy access to papers for humans and AI assistants.",
    body,
    canonical: `${siteOrigin(env, url)}/`,
    ogImage: ogImage(siteOrigin(env, url)),
    katex: missing.tex,
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
  const { fts, total, hits, error } = await runSearch(env, sp);
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
      ? html`<h4 class="results-h">Recent papers</h4>
      <div class="results">${recent.map((p) => resultItem(p))}</div>`
      : html`<div class="results-bar">
        <h4 class="results-h">${error ? error : html`${fmtInt(total)} result${total === 1 ? "" : "s"} sorted by ${sp.sort === "new" ? "date" : "relevance"}`}</h4>
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
    katex: fts ? hasTex(...hits.map((h) => stripMarks(h.title_hl ?? ""))) : hasTex(...recent.map((p) => p.title)),
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
