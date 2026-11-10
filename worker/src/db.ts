import { HL_CLOSE, HL_OPEN } from "./html";

export interface Env {
  DB: D1Database;
  PDFS: R2Bucket;
  ASSETS: Fetcher;
  SITE_NAME: string;
  ISSUES_URL: string;
  ORIGIN_BASE: string;
  /** Contact form (optional): send_email binding + addresses. CONTACT_TO is a secret. */
  MAILER?: SendEmail;
  CONTACT_TO?: string;
  CONTACT_FROM?: string;
  /** "1" = private preview: only requests that passed Cloudflare Access are served. */
  REQUIRE_ACCESS?: string;
}

export interface Paper {
  id: string;
  year: number;
  num: number;
  title: string;
  authors: string; // JSON array
  abstract: string | null;
  category: string | null;
  license_url: string | null;
  license_code: string | null;
  retro_license: number;
  submitted: string | null;
  updated: string | null;
  withdrawn: number;
  pdf_key: string | null;
  pdf_sha256: string | null;
  pdf_size: number | null;
  pdf_source: string | null;
  pdf_source_date: string | null;
  pdf_maybe_stale: number;
}

export interface Source {
  paper_id: string;
  kind: string;
  url: string;
  captured_at: string | null;
  size: number | null;
}

export interface ListItem {
  id: string;
  year: number;
  num: number;
  title: string;
  authors: string;
  category: string | null;
  license_code: string | null;
  submitted: string | null;
  withdrawn: number;
  has_pdf: number;
}

export function parseAuthors(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
  } catch {
    return [json];
  }
}

export const canonicalId = (year: number, num: number): string =>
  `${year}/${String(num).padStart(3, "0")}`;

export async function getPaper(env: Env, id: string): Promise<Paper | null> {
  return env.DB.prepare("SELECT * FROM papers WHERE id = ?1").bind(id).first<Paper>();
}

export async function getSources(env: Env, id: string): Promise<Source[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM sources WHERE paper_id = ?1 ORDER BY captured_at DESC",
  )
    .bind(id)
    .all<Source>();
  return r.results ?? [];
}

const LIST_COLS =
  "id, year, num, title, authors, category, license_code, submitted, withdrawn, (pdf_key IS NOT NULL) AS has_pdf";

export async function homeData(env: Env, limit = 15) {
  const [stats, latest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT SUM(withdrawn = 0) AS papers, SUM(pdf_key IS NOT NULL AND withdrawn = 0) AS pdfs FROM papers",
    ),
    env.DB.prepare(
      `SELECT ${LIST_COLS} FROM papers WHERE withdrawn = 0 ORDER BY year DESC, num DESC LIMIT ?1`,
    ).bind(limit),
  ]);
  const s = (stats.results?.[0] ?? {}) as { papers?: number; pdfs?: number };
  return {
    papers: Number(s.papers ?? 0),
    pdfs: Number(s.pdfs ?? 0),
    latest: (latest.results ?? []) as unknown as ListItem[],
  };
}

// ---------------------------------------------------------------------------- search

export interface SearchHit extends ListItem {
  title_hl: string;
  authors_hl: string;
  snip: string | null;
}

/**
 * Turn free-form user input into a safe FTS5 query: every term is quoted (so FTS syntax
 * characters are inert), terms are ANDed, a trailing * keeps prefix search, "quoted phrases"
 * stay phrases, and `title:` / `author:` / `abstract:` restrict a term to one column.
 */
export function toFtsQuery(q: string): string {
  const parts: string[] = [];
  const re = /(?:(title|author|authors|abstract):)?(?:"([^"]*)"|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) && parts.length < 16) {
    const col = m[1] ? (m[1].toLowerCase().startsWith("author") ? "authors" : m[1].toLowerCase()) : null;
    let term = (m[2] ?? m[3] ?? "").trim();
    const prefix = m[2] === undefined && term.endsWith("*");
    // Keep letters, digits and spaces; everything else separates words.
    term = term.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!term) continue;
    const quoted = `"${term}"${prefix ? "*" : ""}`;
    parts.push(col ? `${col} : ${quoted}` : quoted);
  }
  return parts.join(" ");
}

export async function search(
  env: Env,
  ftsQuery: string,
  page: number,
  perPage: number,
  sort: "relevance" | "new",
): Promise<{ total: number; hits: SearchHit[] }> {
  const order = sort === "new" ? "p.year DESC, p.num DESC" : "score";
  const offset = (page - 1) * perPage;
  const [count, rows] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS n FROM papers_fts WHERE papers_fts MATCH ?1").bind(ftsQuery),
    env.DB.prepare(
      `SELECT p.id, p.year, p.num, p.title, p.authors, p.category, p.license_code, p.submitted,
              p.withdrawn, (p.pdf_key IS NOT NULL) AS has_pdf,
              highlight(papers_fts, 1, ?4, ?5) AS title_hl,
              highlight(papers_fts, 2, ?4, ?5) AS authors_hl,
              snippet(papers_fts, 3, ?4, ?5, '…', 36) AS snip,
              bm25(papers_fts, 0.0, 10.0, 5.0, 1.0) AS score
         FROM papers_fts JOIN papers p ON p.rowid = papers_fts.rowid
        WHERE papers_fts MATCH ?1
        ORDER BY ${order}
        LIMIT ?2 OFFSET ?3`,
    ).bind(ftsQuery, perPage, offset, HL_OPEN, HL_CLOSE),
  ]);
  const total = Number((count.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return { total, hits: (rows.results ?? []) as unknown as SearchHit[] };
}
