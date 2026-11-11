// Findability for search engines (Google, Google Scholar, Bing, which also feeds ChatGPT search
// and Copilot) and AI agents:
//   - paperHead: Google Scholar citation_* tags and a link to the paper's JSON.
//   - /sitemap.xml: the homepage, the year pages and every paper page.
//   (The year pages, /YYYY, are in years.ts.)
// Attribution to ePrint is for people and lives on the page itself (link, BibTeX, footer).
import { parseAuthors, type Env, type Paper } from "./db";
import { html, type Html } from "./html";
import { day } from "./pages";

/** The public origin for canonical URLs: SITE_URL (https://opencryptology.org) when set, so a
 *  copy reached through workers.dev or a preview still points search engines at the real site. */
export function siteOrigin(env: Env, url: URL): string {
  return (env.SITE_URL || url.origin).replace(/\/$/, "");
}

/** Social preview image (1280x640), in worker/public/static. */
export const ogImage = (origin: string): string => `${origin}/static/social-preview.png`;

/** Google Scholar wants YYYY/MM/DD. */
const scholarDate = (iso: string | null): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).replace(/-/g, "/") : null);

/** Extra <head> tags of a paper page. No Scholar tags for withdrawn papers. */
export function paperHead(p: Paper, title: string, pdfUrl: string | null): Html {
  const date = scholarDate(p.submitted);
  return html`<link rel="alternate" type="application/json" href="/api/papers/${p.id}">
${!p.withdrawn &&
html`<meta name="citation_title" content="${title}">
${parseAuthors(p.authors).map((a) => html`<meta name="citation_author" content="${a}">\n`)}${date && html`<meta name="citation_publication_date" content="${date}">`}
${pdfUrl && html`<meta name="citation_pdf_url" content="${pdfUrl}">`}`}`;
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

const urlEntry = (loc: string, mod?: string | null) =>
  `  <url><loc>${xesc(loc)}</loc>${mod ? `<lastmod>${xesc(day(mod))}</lastmod>` : ""}</url>`;

/** /sitemap.xml: the homepage, the year pages and every paper page (one file: the 50,000-URL
 *  limit of a sitemap leaves room for ~20,000 more papers). A paper's lastmod is the later of
 *  ePrint's last change and when we last added a PDF for it (that changes the page too). */
export async function sitemap(env: Env, url: URL): Promise<Response> {
  const origin = siteOrigin(env, url);
  const r = await env.DB.prepare(
    `SELECT p.id, p.year, p.updated, (SELECT max(v.added_at) FROM versions v WHERE v.paper_id = p.id) AS added
       FROM papers p WHERE ${LISTED} ORDER BY p.year DESC, p.num DESC`,
  ).all<{ id: string; year: number; updated: string | null; added: string | null }>();
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  const papers = (r.results ?? []).map((p) => ({ id: p.id, year: p.year, mod: later(p.updated, p.added) }));
  const years = new Map<number, string | null>();
  for (const p of papers) years.set(p.year, later(years.get(p.year) ?? null, p.mod));
  const newest = [...years.values()].reduce<string | null>(later, null);
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
  urlEntry(`${origin}/`, newest),
  ...[...years].map(([y, mod]) => urlEntry(`${origin}/${y}`, mod)),
  ...papers.map((p) => urlEntry(`${origin}/${p.id}`, p.mod)),
].join("\n")}
</urlset>
`);
}
