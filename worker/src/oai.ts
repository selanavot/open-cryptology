// On-demand freshness: when /YYYY/NNNN is not in D1 (e.g. posted minutes ago), ask ePrint's
// OAI-PMH endpoint (metadata is CC0, not behind the challenge) for that single record and
// upsert it with the same normalization as pipeline/harvest_oai.py. Never fetches PDFs.

import { canonicalId, getPaper, type Env, type Paper } from "./db";
import { licenseCode } from "./license";

const USER_AGENT =
  "open-cryptology-worker/0.1 (unofficial non-commercial ePrint mirror; on-demand single-record OAI lookup)";
const NEG_TTL_MISSING = 600; // s: OAI says idDoesNotExist
const NEG_TTL_ERROR = 120; // s: upstream unreachable/blocked; don't hammer it
const MAX_AHEAD = 300; // only look up ids at most this far past the newest known id of a year

export type Lookup =
  | { kind: "found"; paper: Paper; fresh?: boolean }
  | { kind: "missing"; upstreamError?: boolean };

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

export async function upsert(env: Env, r: OaiRecord): Promise<void> {
  const guard = "WHERE papers.updated IS NULL OR excluded.updated >= papers.updated";
  let stmt: D1PreparedStatement;
  if (r.withdrawn) {
    stmt = env.DB.prepare(
      `INSERT INTO papers (id,year,num,title,authors,retro_license,updated,withdrawn)
       VALUES (?1,?2,?3,'','[]',?4,?5,1)
       ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, withdrawn=1 ${guard}`,
    ).bind(r.id, r.year, r.num, r.retro_license, r.updated);
  } else {
    const cols = ["id", "year", "num", ...META_COLS];
    const vals = cols.map((c) => (r as unknown as Record<string, unknown>)[c] ?? null);
    const sets = META_COLS.map((c) => `${c}=excluded.${c}`).join(", ");
    stmt = env.DB.prepare(
      `INSERT INTO papers (${cols.join(",")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(",")})
       ON CONFLICT(id) DO UPDATE SET ${sets} ${guard}`,
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

// ------------------------------------------------------------------------- lookup

const negKey = (id: string) => `https://negative-cache.open-cryptology.invalid/oai/${id}`;

async function eligible(env: Env, year: number, num: number): Promise<boolean> {
  const nowYear = new Date().getUTCFullYear();
  if (year < 1996 || year > nowYear || num < 1) return false;
  const row = await env.DB.prepare("SELECT max(num) AS n FROM papers WHERE year = ?1")
    .bind(year)
    .first<{ n: number | null }>();
  const max = row?.n ?? null;
  // The harvest is complete for older ids, so a gap there is not a fresh paper.
  if (max === null) return year >= nowYear - 1 && num <= MAX_AHEAD;
  return num > max && num <= max + MAX_AHEAD;
}

export async function lookupPaper(
  env: Env,
  ctx: ExecutionContext,
  year: number,
  num: number,
): Promise<Lookup> {
  const id = canonicalId(year, num);
  const existing = await getPaper(env, id);
  if (existing) return { kind: "found", paper: existing };
  if (!(await eligible(env, year, num))) return { kind: "missing" };

  const cache = caches.default;
  const cached = await cache.match(negKey(id));
  if (cached) return { kind: "missing", upstreamError: cached.headers.get("x-neg") === "error" };

  const remember = (why: "missing" | "error", ttl: number) =>
    ctx.waitUntil(
      cache.put(
        negKey(id),
        new Response("", { headers: { "cache-control": `max-age=${ttl}`, "x-neg": why } }),
      ),
    );

  const url =
    `${env.ORIGIN_BASE.replace(/\/$/, "")}/oai?verb=GetRecord&metadataPrefix=oai_dc` +
    `&identifier=oai:eprint.iacr.org:${id}`;
  let xml: string;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/xml, text/xml" },
      signal: AbortSignal.timeout(8000),
    });
    xml = await res.text();
    if (!res.ok || !xml.includes("<OAI-PMH")) throw new Error(`OAI HTTP ${res.status}`);
  } catch (e) {
    console.warn(`OAI lookup for ${id} failed:`, String(e));
    remember("error", NEG_TTL_ERROR);
    return { kind: "missing", upstreamError: true };
  }

  const parsed = parseGetRecord(xml);
  if ("error" in parsed || parsed.record.id !== id) {
    remember("missing", NEG_TTL_MISSING);
    return { kind: "missing" };
  }
  await upsert(env, parsed.record);
  const paper = await getPaper(env, id);
  return paper ? { kind: "found", paper, fresh: true } : { kind: "missing" };
}
