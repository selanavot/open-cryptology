// OAI-PMH record parsing and the D1 upsert, used by the scheduled harvest (harvest.ts) with the
// same normalization as pipeline/harvest_oai.py. Requests from visitors never reach ePrint: the
// harvest (every 4 hours) is the only thing that talks to it.

import { type Env } from "./db";
import { licenseCode } from "./license";

export interface OaiRecord {
  id: string;
  year: number;
  num: number;
  updated: string | null;
  withdrawn: number;
  retro_license: number;
  title?: string;
  authors?: string;
  abstract?: string | null;
  category?: string | null;
  license_url?: string | null;
  license_code?: string | null;
  submitted?: string | null;
}

// ------------------------------------------------------------------------- XML helpers

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) =>
      c.replace(/&/g, "\u0000amp;"),
    )
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, e: string) => {
      const l = e.toLowerCase();
      if (l === "lt") return "<";
      if (l === "gt") return ">";
      if (l === "quot") return '"';
      if (l === "apos") return "'";
      if (l === "amp") return "&";
      const cp = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return "";
      }
    })
    .replace(/\u0000amp;/g, "&");
}

/** All text contents of <prefix:name ...>...</prefix:name> (or self-closing → ""). */
function elements(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>)`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1] ?? ""));
  return out;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function parseGetRecord(
  xml: string,
): { error: string } | { record: OaiRecord } {
  const err = /<error\b[^>]*\bcode="([^"]*)"/.exec(xml);
  if (err) return { error: err[1] };
  const header = /<header\b([^>]*)>([\s\S]*?)<\/header>/.exec(xml);
  if (!header) return { error: "malformed" };
  const ident = norm(elements(header[2], "identifier")[0]);
  const m = /^oai:eprint\.iacr\.org:(\d{4})\/(\d+)$/.exec(ident);
  if (!m) return { error: "malformed" };
  const year = Number(m[1]);
  const num = Number(m[2]);
  const rec: OaiRecord = {
    id: `${year}/${m[2]}`,
    year,
    num,
    updated: norm(elements(header[2], "datestamp")[0]) || null,
    withdrawn: /\bstatus="deleted"/.test(header[1]) ? 1 : 0,
    retro_license: year < 2022 ? 1 : 0,
  };
  const dc = /<(?:\w+:)?dc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?dc>/.exec(xml);
  if (dc && !rec.withdrawn) {
    const body = dc[1];
    const rights = norm(elements(body, "rights")[0]) || null;
    const desc = elements(body, "description");
    const dates = elements(body, "date").map(norm);
    rec.title = norm(elements(body, "title")[0]);
    rec.authors = JSON.stringify(elements(body, "creator").map(norm).filter(Boolean));
    rec.abstract = desc.length ? desc[0].trim() : null;
    rec.category = norm(elements(body, "subject")[0]) || null;
    rec.license_url = rights;
    rec.license_code = licenseCode(rights);
    rec.submitted = dates[0] || null;
  }
  return { record: rec };
}

// ------------------------------------------------------------------------- upsert

const META_COLS = [
  "title", "authors", "abstract", "category", "license_url", "license_code",
  "retro_license", "submitted", "updated", "withdrawn",
] as const;

/** ePrint changed the paper after our copy was captured, so the PDF may be an older revision
 *  ("may be outdated": yellow on the year pages, uploads accepted). Only when the datestamp moves
 *  forward, so re-reading the same record never re-flags a copy an upload confirmed since.
 *  Same expression in pipeline/harvest_remote.py (the harvester that runs) and harvest_oai.py. */
const STALE_SET = `pdf_maybe_stale=CASE WHEN papers.pdf_key IS NOT NULL
  AND (papers.updated IS NULL OR excluded.updated > papers.updated)
  AND (papers.pdf_source_date IS NULL OR julianday(papers.pdf_source_date) < julianday(excluded.updated))
  THEN 1 ELSE papers.pdf_maybe_stale END`;

export async function upsert(env: Env, r: OaiRecord): Promise<void> {
  const guard = "WHERE papers.updated IS NULL OR excluded.updated >= papers.updated";
  let stmt: D1PreparedStatement;
  if (r.withdrawn) {
    // Deleted records carry no metadata. An existing paper keeps all of its metadata and PDFs
    // (ePrint keeps the abstract page too); only the flag, the datestamp and the withdrawal day
    // change. withdrawn_on = the deleted record's datestamp unless a date is already known.
    stmt = env.DB.prepare(
      `INSERT INTO papers (id,year,num,title,authors,retro_license,updated,withdrawn,withdrawn_on)
       VALUES (?1,?2,?3,'','[]',?4,?5,1,substr(?5,1,10))
       ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, withdrawn=1,
         withdrawn_on=CASE WHEN papers.withdrawn = 1 AND papers.withdrawn_on IS NOT NULL
                           THEN papers.withdrawn_on ELSE excluded.withdrawn_on END ${guard}`,
    ).bind(r.id, r.year, r.num, r.retro_license, r.updated);
  } else {
    const cols = ["id", "year", "num", ...META_COLS];
    const vals = cols.map((c) => (r as unknown as Record<string, unknown>)[c] ?? null);
    const sets = META_COLS.map((c) => `${c}=excluded.${c}`).join(", ");
    // A live record clears any withdrawal; affiliations (not in OAI) survive only while the
    // author list is unchanged.
    stmt = env.DB.prepare(
      `INSERT INTO papers (${cols.join(",")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(",")})
       ON CONFLICT(id) DO UPDATE SET ${sets}, withdrawn_on=NULL,
         affiliations=CASE WHEN excluded.authors = papers.authors THEN papers.affiliations ELSE NULL END,
         ${STALE_SET} ${guard}`,
    ).bind(...vals);
  }
  // External-content FTS: drop the old index entry (if the row exists), then index the row as
  // it is after the upsert. Both run in one batch (a transaction).
  const ftsDelete = env.DB.prepare(
    `INSERT INTO papers_fts(papers_fts, rowid, id, title, authors, abstract)
     SELECT 'delete', rowid, id, title, authors, abstract FROM papers WHERE id = ?1`,
  ).bind(r.id);
  const ftsInsert = env.DB.prepare(
    `INSERT INTO papers_fts(rowid, id, title, authors, abstract)
     SELECT rowid, id, title, authors, abstract FROM papers WHERE id = ?1`,
  ).bind(r.id);
  await env.DB.batch([ftsDelete, stmt, ftsInsert]);
}
