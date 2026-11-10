import { homeData, parseAuthors, search, toFtsQuery, type Env, type ListItem, type SearchHit } from "./db";
import { highlighted, html, stripMarks, type Html } from "./html";
import { card, categoryBadge, hasTex, messagePage, page } from "./layout";

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
export const fmtInt = (n: number): string => n.toLocaleString("en-US");

function authorLine(names: string[], max = 6): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, and ${names.length - max} more`;
}

/** ePrint homepage "Recent papers" entry: small id, h6 title, italic authors. */
function recentItem(p: ListItem): Html {
  return html`<div class="recent-item">
  <small><a href="/${p.id}">${p.id}</a></small>
  <h6 class="recent-title tex"><a href="/${p.id}">${p.title || "Untitled"}</a></h6>
  <div class="recent-authors">${authorLine(parseAuthors(p.authors))}</div>
</div>`;
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
    ${p.withdrawn ? html`<span class="badge bg-secondary">withdrawn</span>` : ""}
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

export async function homePage(env: Env): Promise<Response> {
  const { latest } = await homeData(env, 16);
  const body = html`<div class="home-top">
  <div class="home-intro">
    <p class="mb-1">Hello cryptographers!</p>
    <p class="text-justify mb-0">This is an unofficial, non-commercial mirror of the
    <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>. AI agents have become useful for
    research, including literature review, but only if they can access prior work. ePrint’s access
    control currently blocks them from fetching the PDFs. This mirror is meant to make that kind of
    work easy again.</p>
  </div>
  <div class="home-search">
    <form method="get" action="/search" role="search">
      <div class="input-group">
        <input type="text" name="q" class="form-control" placeholder="Search papers, or go to 2024/123" aria-label="Search titles, authors and abstracts, or enter a paper ID">
        <button class="btn btn-outline-dark" type="submit">Search</button>
      </div>
    </form>
  </div>
</div>
<div class="home-grid">
  ${card(
    "Recent papers",
    html`<div class="recent-grid">${latest.map(recentItem)}</div>
    <p class="text-end mt-2 mb-0"><a href="/search">More recent papers →</a></p>`,
    "home-recent",
  )}
  <div class="home-side">
    ${card(
      "New papers",
      html`<p>New papers appear here within minutes of being accepted on ePrint. We don’t take
      submissions; submit to ePrint as usual.</p>
      <div class="btn-row"><a href="${env.ORIGIN_BASE}/submit" class="btn btn-outline-dark" rel="noopener">Submit on ePrint ↗</a></div>`,
    )}
    ${card(
      "PDFs",
      html`<p>PDFs come from existing public copies, and readers fill in the gaps: if one is missing,
      download it from ePrint and upload it anonymously here.</p>`,
    )}
    ${card(
      "Licenses",
      html`<p>Every paper keeps its authors’ license and links back to the original. Please respect it:
      credit the authors, no commercial use for NC papers, unmodified copies only for ND.</p>
      <p><a href="/about#licenses">More on licenses →</a></p>`,
    )}
    ${card(
      "What’s next",
      html`<p>The vision is a one-stop place for everything known about each paper, kept up to date as
      cryptography moves on: discussion, links between papers and the protocols they build on, and
      known attacks on each construction.</p>`,
    )}
    ${card(
      "Contact",
      html`<p>Something wrong or missing? <a href="/contact">Contact us</a> or
      <a href="${env.ISSUES_URL}">open an issue</a>. Want to help? <a href="/contact">Get in touch!</a></p>
      <p>Thanks for visiting,<br>Sela</p>`,
    )}
  </div>
</div>`;
  return page(env, {
    title: env.SITE_NAME,
    description:
      "Unofficial mirror of the Cryptology ePrint Archive: fast search and easy access to papers for humans and AI assistants.",
    body,
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
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
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
  const { total, hits, error } = await runSearch(env, sp);
  return json(
    {
      query: sp.q,
      id_match: id ? { id, url: `${origin}/${id}`, api_url: `${origin}/api/papers/${id}` } : null,
      total,
      page: sp.page,
      per_page: PER_PAGE,
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
        has_pdf: !!h.has_pdf,
        snippet: h.snip ? stripMarks(h.snip) : null,
        url: `${origin}/${h.id}`,
        api_url: `${origin}/api/papers/${h.id}`,
        pdf_url: h.has_pdf ? `${origin}/${h.id}.pdf` : null,
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

export function aboutPage(env: Env): Response {
  const body = html`<article class="prose">
<h2 class="page-title">About ${env.SITE_NAME}</h2>
<p>${env.SITE_NAME} is an <strong>unofficial, non-commercial mirror</strong> of the
<a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a>, run independently and <strong>not affiliated
with or endorsed by the IACR</strong>. Its goal is to make ePrint papers easier to obtain and search —
for people, and for AI assistants acting on their behalf — while always crediting authors and pointing
back to the original.</p>

<h4 id="how">How the mirror is populated</h4>
<ul>
  <li><strong>Metadata</strong> (titles, authors, abstracts, categories, licenses, dates) comes from ePrint’s
  public <a href="${env.ORIGIN_BASE}/oai">OAI-PMH interface</a>, which is published under CC0. It is
  harvested incrementally and politely; a paper that is not here yet is looked up on demand, one
  record at a time.</li>
  <li><strong>PDFs</strong> come from <em>existing public copies</em> (for example community mirrors and the
  Internet Archive’s Wayback Machine) and from <em>verified uploads</em>. Each copy shows where it came from
  and when it was captured, and is flagged if a newer revision may exist on ePrint.</li>
  <li><strong>We never scrape PDFs from eprint.iacr.org.</strong> ePrint’s robots.txt disallows it and we respect that.</li>
  <li>Withdrawn papers are shown as tombstones, without content.</li>
</ul>

<h4 id="licenses">Using papers: license guidance for humans and AI agents</h4>
<p>Every paper keeps the Creative Commons license its authors chose on ePrint; it is shown on each paper
page, in the <a href="/api">JSON API</a>, and in the <code>Link: rel="license"</code> and <code>X-License</code>
headers of every PDF. These obligations apply equally to people and to automated agents that quote,
summarize, or redistribute papers:</p>
<dl class="license-table">
  <dt><span class="cc">CC BY</span></dt>
  <dd>Attribution. You may share and adapt the paper, including commercially, if you <strong>credit the authors</strong>,
  <strong>link the original</strong> ePrint entry and the license, and indicate changes.</dd>
  <dt><span class="cc">SA</span> ShareAlike</dt>
  <dd>Adaptations must be distributed under the same license.</dd>
  <dt><span class="cc">NC</span> NonCommercial</dt>
  <dd>No commercial use of the paper or adaptations of it.</dd>
  <dt><span class="cc">ND</span> NoDerivatives</dt>
  <dd>You may redistribute the paper <strong>verbatim only</strong>; do not distribute modified or derived versions
  (such as translations or rewritten excerpts presented as the paper).</dd>
  <dt><span class="cc">CC0</span></dt>
  <dd>Public domain dedication; attribution is still good scholarly practice.</dd>
</dl>
<p>Papers posted to ePrint before 2022 had their license assigned retroactively by the IACR; their pages
say so. When in doubt, consult the license deed linked from each paper and the original ePrint page.</p>

<h4 id="cite">How to cite</h4>
<p>Cite the <strong>original ePrint entry</strong>, not this mirror. Each paper page has a BibTeX entry
(<code>cryptoeprint:YYYY/NNN</code>) whose URL points to <code>${env.ORIGIN_BASE}/YYYY/NNN</code>.
If a paper has since been published at a venue, prefer citing that version.</p>

<h4 id="agents">For AI assistants and crawlers</h4>
<p>See <a href="/llms.txt">/llms.txt</a> for URL patterns and the JSON API. Please fetch individual
papers as needed rather than crawling the whole site; bulk access may be offered later.</p>

<h4 id="contact">Takedowns, corrections and contact</h4>
<p>If you are an author and want a copy removed or corrected, or if anything here is wrong, please
<a href="${env.ISSUES_URL}">open an issue</a>. We act on takedown requests promptly.</p>
</article>`;
  return page(env, {
    title: "About",
    description: "What this unofficial ePrint mirror is, how it is populated, and how to respect paper licenses.",
    body,
    cache: "public, max-age=3600",
  });
}

export function apiDocsPage(env: Env, origin: string): Response {
  const ex = "2024/123";
  const body = html`<article class="prose">
<h2 class="page-title">JSON API</h2>
<p>Read-only, no key required, CORS enabled. Responses are JSON (UTF-8). Please be gentle: fetch
what you need, cache responses, and don’t bulk-crawl. Paper IDs look like <code>YYYY/NNN</code>
(at least three digits, e.g. <code>2024/007</code>, <code>2024/1234</code>).</p>

<h4>Paper</h4>
<pre><code>GET ${origin}/api/papers/${ex}</code></pre>
<p>Returns <code>id</code>, <code>title</code>, <code>authors</code> (array), <code>abstract</code> (may contain TeX),
<code>category</code>, <code>license</code> <code>{code, url, label, attribution, retroactive}</code>,
<code>dates</code> <code>{submitted, updated}</code>, <code>original_url</code>, <code>url</code>,
<code>pdf</code> <code>{url, sha256, size, source, source_date, maybe_stale}</code> or <code>null</code>,
<code>other_sources</code> (array of <code>{kind, url, captured_at, size}</code>), <code>withdrawn</code>,
and <code>bibtex</code>. Status 404 if unknown, 410 for withdrawn papers.</p>

<h4>Search</h4>
<pre><code>GET ${origin}/api/search?q=zero+knowledge&amp;page=1&amp;sort=relevance</code></pre>
<p>Full-text search over titles, authors and abstracts (BM25 ranking). <code>sort</code> is
<code>relevance</code> (default) or <code>new</code>. Supports <code>"phrases"</code>, <code>prefix*</code> and
<code>author:</code> / <code>title:</code> / <code>abstract:</code> field filters. Returns
<code>{query, id_match, total, page, per_page, results[]}</code>; each result has <code>id</code>,
<code>title</code>, <code>authors</code>, <code>snippet</code>, <code>license</code>, <code>has_pdf</code>,
<code>url</code>, <code>api_url</code>, <code>pdf_url</code>.</p>

<h4>PDF</h4>
<pre><code>GET ${origin}/${ex}.pdf</code></pre>
<p>The mirrored PDF, when available. Headers: <code>Link: &lt;license&gt;; rel="license"</code>,
<code>X-License</code>, <code>ETag</code> (sha256), range requests supported. 404 if not mirrored.</p>

<h4>Licenses</h4>
<p>Every response carries the paper’s license. Honour it: attribute authors and link the original,
no commercial use for NC, verbatim-only redistribution for ND. See <a href="/about#licenses">About</a>.</p>
</article>`;
  return page(env, { title: "API", body, cache: "public, max-age=3600" });
}

export function notFound(env: Env, what = "Page not found"): Response {
  return messagePage(env, 404, what, html`<p>Try the <a href="/search">search</a> or go to the <a href="/">homepage</a>.</p>`);
}
