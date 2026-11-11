// Findability: what search engines (Google, Bing, which also feeds ChatGPT search and Copilot,
// Brave, Google Scholar) and AI agents need to find and describe each paper here.
//   - siteOrigin: the public origin used in canonical URLs, sitemaps and social tags.
//   - paperHead: <head> tags of a paper page (Scholar citation_* tags, schema.org JSON-LD,
//     Open Graph). Paper pages are their own canonical; ePrint is named as the original in the
//     JSON-LD and in the Scholar tags (as the report's institution), and the BibTeX cites ePrint.
//   - /sitemap.xml (an index) -> /sitemaps/site.xml + /sitemaps/YYYY.xml (one per year).
//   - /YYYY: every paper of a year, an indexable page that links to all of them (search and
//     /missing are noindex, so without it crawlers had no path to the paper pages).
import { parseAuthors, type Env, type Paper } from "./db";
import { html, raw, type Html } from "./html";
import { hasTex, messagePage, page } from "./layout";
import type { LicenseInfo } from "./license";
import { day } from "./pages";

/** ePrint's first year. */
export const FIRST_YEAR = 1996;
export const lastYear = (): number => new Date().getUTCFullYear();

/** The public origin for canonical URLs: SITE_URL (https://opencryptology.org) when set, so a
 *  copy reached through workers.dev or a preview still points search engines at the real site. */
export function siteOrigin(env: Env, url: URL): string {
  return (env.SITE_URL || url.origin).replace(/\/$/, "");
}

/** Social preview image (1280x640), in worker/public/static. */
export const ogImage = (origin: string): string => `${origin}/static/social-preview.png`;

/** JSON for a <script type="application/ld+json"> block; "<" is escaped so no text can close it. */
function jsonLd(v: unknown): Html {
  return raw(`<script type="application/ld+json">${JSON.stringify(v).replace(/</g, "\\u003c")}</script>`);
}

/** Google Scholar wants YYYY/MM/DD. */
const scholarDate = (iso: string | null): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).replace(/-/g, "/") : null);

export interface PaperHeadOpts {
  p: Paper;
  origin: string;
  orig: string; // the ePrint page
  originBase: string; // ePrint's homepage
  title: string;
  pdfUrl: string | null; // absolute; null when we have no PDF
  lic: LicenseInfo;
}

export function paperHead(o: PaperHeadOpts): Html {
  const { p } = o;
  const self = `${o.origin}/${p.id}`;
  const authors = parseAuthors(p.authors);
  const withdrawn = !!p.withdrawn;
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    "@id": self,
    url: self,
    name: o.title,
    headline: o.title.slice(0, 110),
    author: authors.map((name) => ({ "@type": "Person", name })),
    abstract: p.abstract || undefined,
    datePublished: day(p.submitted) || undefined,
    dateModified: day(p.updated) || undefined,
    genre: p.category || undefined,
    identifier: `Cryptology ePrint Archive, Paper ${p.id}`,
    // The original: ePrint's entry for this paper.
    sameAs: o.orig,
    isBasedOn: o.orig,
    isPartOf: { "@type": "CreativeWorkSeries", name: "Cryptology ePrint Archive", url: o.originBase },
    license: o.lic.url || undefined,
    isAccessibleForFree: true,
    encoding: o.pdfUrl ? { "@type": "MediaObject", contentUrl: o.pdfUrl, encodingFormat: "application/pdf" } : undefined,
    creativeWorkStatus: withdrawn ? "Withdrawn" : undefined,
  };
  return html`<link rel="alternate" type="application/json" href="/api/papers/${p.id}">
${!withdrawn &&
html`<meta name="citation_title" content="${o.title}">
${authors.map((a) => html`<meta name="citation_author" content="${a}">\n`)}${scholarDate(p.submitted) && html`<meta name="citation_publication_date" content="${scholarDate(p.submitted)}">`}
<meta name="citation_technical_report_institution" content="Cryptology ePrint Archive">
<meta name="citation_technical_report_number" content="${p.id}">
<meta name="citation_abstract_html_url" content="${self}">
${o.pdfUrl && html`<meta name="citation_pdf_url" content="${o.pdfUrl}">`}`}
${jsonLd(ld)}`;
}

// ---------------------------------------------------------------------------- sitemaps

function xml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

const xesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Papers that have a page worth indexing: not withdrawn ones we know nothing about. */
const LISTED = "(withdrawn = 0 OR title <> '')";

/** /sitemap.xml: index of the site sitemap and one sitemap per year. */
export async function sitemapIndex(env: Env, url: URL): Promise<Response> {
  const origin = siteOrigin(env, url);
  const r = await env.DB.prepare(
    `SELECT year, max(updated) AS updated FROM papers WHERE ${LISTED} GROUP BY year ORDER BY year DESC`,
  ).all<{ year: number; updated: string | null }>();
  const rows = r.results ?? [];
  const entry = (loc: string, mod?: string | null) =>
    `  <sitemap><loc>${xesc(loc)}</loc>${mod ? `<lastmod>${xesc(day(mod))}</lastmod>` : ""}</sitemap>`;
  return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[entry(`${origin}/sitemaps/site.xml`, rows[0]?.updated), ...rows.map((y) => entry(`${origin}/sitemaps/${y.year}.xml`, y.updated))].join("\n")}
</sitemapindex>
`);
}

const urlEntry = (loc: string, mod?: string | null) =>
  `  <url><loc>${xesc(loc)}</loc>${mod ? `<lastmod>${xesc(day(mod))}</lastmod>` : ""}</url>`;

/** /sitemaps/site.xml: the homepage and the year pages. */
export async function siteSitemap(env: Env, url: URL): Promise<Response> {
  const origin = siteOrigin(env, url);
  const r = await env.DB.prepare(
    `SELECT year, max(updated) AS updated FROM papers WHERE ${LISTED} GROUP BY year ORDER BY year DESC`,
  ).all<{ year: number; updated: string | null }>();
  const rows = r.results ?? [];
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[urlEntry(`${origin}/`, rows[0]?.updated), ...rows.map((y) => urlEntry(`${origin}/${y.year}`, y.updated))].join("\n")}
</urlset>
`);
}

/** /sitemaps/YYYY.xml: every paper page of a year. lastmod is the later of ePrint's last change
 *  and when we last added a PDF for it (a new PDF changes the page: PDF link, citation_pdf_url). */
export async function yearSitemap(env: Env, url: URL, year: number): Promise<Response | null> {
  const origin = siteOrigin(env, url);
  const r = await env.DB.prepare(
    `SELECT p.id, p.updated, (SELECT max(v.added_at) FROM versions v WHERE v.paper_id = p.id) AS added
       FROM papers p WHERE p.year = ?1 AND ${LISTED} ORDER BY p.num`,
  )
    .bind(year)
    .all<{ id: string; updated: string | null; added: string | null }>();
  const rows = r.results ?? [];
  if (!rows.length) return null;
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((p) => urlEntry(`${origin}/${p.id}`, later(p.updated, p.added))).join("\n")}
</urlset>
`);
}

// ---------------------------------------------------------------------------- year pages

interface YearItem {
  id: string;
  title: string;
  authors: string;
  withdrawn: number;
  has_pdf: number;
}

/** Links to every year page, newest first ("Browse by year"). */
export function yearLinks(selected: number | null = null): Html {
  const years: number[] = [];
  for (let y = lastYear(); y >= FIRST_YEAR; y--) years.push(y);
  return html`<nav class="year-links" aria-label="Browse by year">${years.map(
    (y) => html`<a href="/${y}"${y === selected ? html` aria-current="page"` : ""}>${y}</a> `,
  )}</nav>`;
}

/** /YYYY: all papers of a year, newest first. */
export async function yearPage(env: Env, url: URL, year: number): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT id, title, authors, withdrawn, (pdf_key IS NOT NULL) AS has_pdf
       FROM papers WHERE year = ?1 AND ${LISTED} ORDER BY num DESC`,
  )
    .bind(year)
    .all<YearItem>();
  const items = r.results ?? [];
  if (!items.length) {
    return messagePage(env, 404, `No papers from ${year}`, html`<p>The mirror has no papers from ${year}.</p>${yearLinks()}`);
  }
  const origin = siteOrigin(env, url);
  const n = items.length;
  const body = html`<section class="year-page">
  <h3>Papers from ${year}</h3>
  <p class="text-muted">${n.toLocaleString("en-US")} paper${n === 1 ? "" : "s"} from the Cryptology ePrint Archive, newest first.
  Each links to its abstract page here${items.some((p) => p.has_pdf) ? ", with the PDF where we have it" : ""}.</p>
  ${yearLinks(year)}
  <ol class="year-list" reversed>
    ${items.map((p) => {
      const authors = parseAuthors(p.authors);
      return html`<li><a class="paperlink" href="/${p.id}">${p.id}</a>${p.has_pdf ? html` <a href="/${p.id}.pdf">(PDF)</a>` : ""}${p.withdrawn ? html` <span class="badge bg-secondary">withdrawn</span>` : ""}
      <div><a class="result-title tex" href="/${p.id}">${p.title || "Withdrawn paper"}</a>${authors.length ? html`<span class="year-authors"> · ${authors.length > 6 ? `${authors.slice(0, 6).join(", ")}, and ${authors.length - 6} more` : authors.join(", ")}</span>` : ""}</div></li>\n`;
    })}
  </ol>
</section>`;
  return page(env, {
    title: `Papers from ${year}`,
    description: `All ${n.toLocaleString("en-US")} papers from the Cryptology ePrint Archive in ${year}, with abstracts and PDFs where available, on Open Cryptology.`,
    body,
    canonical: `${origin}/${year}`,
    ogImage: ogImage(origin),
    katex: hasTex(...items.map((p) => p.title)),
    cache: "public, max-age=600",
  });
}
