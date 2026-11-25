// Original manuscripts: results shared faster than papers, including AI-generated ones.
// Ids are the UTC date of first publication plus that day's number: /2026-11-15/3 (the page),
// /2026-11-15/3.pdf (the file, in R2 under manuscripts/). PDFs pass the same safety checks as
// mirror uploads (verify.ts inspectPdf); one with scripts is refused, never queued for review.
// Tables: the "original manuscripts" section of db/schema.sql. Uploaders are accounts (auth.ts),
// always shown as "uploaded by", separately from the free-text authors. The uploader may give each
// author an ORCID iD (shown) and an email (never shown or served), so that people who sign in with
// them can be recognized as authors later; neither is verified when posted.
import type { Env } from "./db";
import { html, raw, safeUrl, type Html } from "./html";
import { citeControl, icons, messagePage, metaList, page } from "./layout";
import { avatar, identityDetail, providerTag } from "./account";
import { currentUser, isAuthFailure, publicUsers, redirect303, requireUser, type User } from "./auth";
import { siteOrigin } from "./seo";
import { inspectPdf } from "./verify";
import { revokeAgentsOfManuscript } from "./agentapi";
import { botCommentFeed, commentsSection, loadThread } from "./comments";
import { orcidLink, parseEmail, parseOrcid } from "./orcid";

export const MS_RE = /^\/(\d{4}-\d{2}-\d{2})\/(\d{1,4})(\.pdf)?\/?$/;
const BOT_AVATAR_RE = /^\/u\/(bot-[a-z0-9][a-z0-9-]{0,39})\/avatar\.jpg$/;
const PROFILE_RE = /^\/u\/([a-z2-7]{12}|bot-[a-z0-9][a-z0-9-]{0,39})\/?$/;

export const isManuscriptPath = (path: string): boolean =>
  MS_RE.test(path) || BOT_AVATAR_RE.test(path) || PROFILE_RE.test(path) || ["/manuscripts", "/submit", "/terms", "/manuscripts/remove"].includes(path);

export const MAX_PDF = 30 * 1024 * 1024; // bytes; Workers accept request bodies up to 100 MB
const MAX_PER_DAY = 20; // new manuscripts per account per 24 hours
// Site-wide, per 24 hours: accounts are free and R2 is on a personal bill.
const SITE_PER_DAY = 300;
const SITE_BYTES_PER_DAY = 2 * 1024 ** 3;
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const NO_STORE = { cache: "no-store", noindex: true } as const;

interface Manuscript {
  id: string;
  day: string;
  num: number;
  uploader_id: string;
  created_at: string;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  removed_at: string | null;
}
interface Version {
  manuscript_id: string;
  v: number;
  title: string;
  authors: string; // JSON array
  author_orcids: string | null; // JSON array parallel to authors (ORCID iD or null), or NULL
  abstract: string;
  format: "md" | "pdf";
  file_key: string | null;
  sha256: string;
  size: number;
  created_at: string;
}

const authorsOf = (v: Pick<Version, "authors">): string[] => {
  try {
    const a = JSON.parse(v.authors);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};
/** The authors' ORCID iDs, parallel to authorsOf(v) (empty when none were given). */
const orcidsOf = (v: Pick<Version, "authors" | "author_orcids">): (string | null)[] => {
  try {
    const a = v.author_orcids ? JSON.parse(v.author_orcids) : [];
    return Array.isArray(a) && a.length === authorsOf(v).length ? a.map((x) => (typeof x === "string" && parseOrcid(x) === x ? x : null)) : [];
  } catch {
    return [];
  }
};

/** An author as the uploader gives them: a name as it should be cited, and optionally an ORCID iD
 *  and an email (people only; a model has neither). */
export interface AuthorIn {
  name: string;
  orcid?: string;
  email?: string;
}

/** What the ORCID field accepts before the server's check digit test: an iD, optionally as an
 *  orcid.org link (an HTML pattern, so it works without JavaScript). */
const ORCID_PATTERN = String.raw`\s*(https?://)?(www\.)?(orcid\.org/)?\d{4}-?\d{4}-?\d{4}-?\d{3}[\dXx]/?\s*`;

const dateLong = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------------------------------------
// data

async function getManuscript(env: Env, id: string): Promise<{ m: Manuscript; versions: Version[] } | null> {
  const [m, vs] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM manuscripts WHERE id = ?1").bind(id),
    env.DB.prepare("SELECT * FROM manuscript_versions WHERE manuscript_id = ?1 ORDER BY v DESC").bind(id),
  ]);
  const row = (m.results as unknown as Manuscript[])[0];
  return row ? { m: row, versions: vs.results as unknown as Version[] } : null;
}

/** Create a manuscript with its first version; returns its id. The day's number is taken inside
 *  the same transaction, so two uploads in the same second never collide. */
const sha256Hex = async (buf: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function createManuscript(
  env: Env,
  uploaderId: string,
  f: {
    title: string;
    authors: string[];
    orcids: (string | null)[] | null;
    emails: { position: number; email: string }[];
    abstract: string;
    pdf: ArrayBuffer;
    sha: string;
    viaToken?: string;
    since: string;
  },
): Promise<string | null> {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const sha = f.sha;
  // The file goes in first, under a random key, so a row never points at a missing file.
  const key = `manuscripts/${crypto.randomUUID()}.pdf`;
  await env.PDFS.put(key, f.pdf, { httpMetadata: { contentType: "application/pdf" }, customMetadata: { sha256: sha, uploader: uploaderId } });
  // One transaction. The version attaches to exactly the row just inserted (last_insert_rowid,
  // which also guards against two posts from one account in the same millisecond); nothing is
  // inserted if the daily limit or a duplicate stops the first statement.
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO manuscripts (id, day, num, uploader_id, created_at)
       SELECT ?1 || '/' || n, ?1, n, ?2, ?3 FROM (SELECT COALESCE(MAX(num), 0) + 1 AS n FROM manuscripts WHERE day = ?1)
        WHERE (SELECT count(*) FROM manuscripts WHERE uploader_id = ?2 AND created_at > ?4) < ?5
          AND NOT EXISTS (SELECT 1 FROM manuscripts m JOIN manuscript_versions v ON v.manuscript_id = m.id
                           WHERE m.uploader_id = ?2 AND v.sha256 = ?6 AND m.created_at > ?4 AND m.removed_at IS NULL)
       RETURNING id`,
    ).bind(day, uploaderId, now, f.since, MAX_PER_DAY, sha),
    env.DB.prepare(
      `INSERT INTO manuscript_versions (manuscript_id, v, title, authors, abstract, format, file_key, sha256, size, created_at, author_orcids)
       SELECT id, 1, ?3, ?4, ?5, 'pdf', ?6, ?7, ?8, ?2, ?9 FROM manuscripts
        WHERE rowid = last_insert_rowid() AND uploader_id = ?1 AND created_at = ?2`,
    ).bind(uploaderId, now, f.title, JSON.stringify(f.authors), f.abstract, key, sha, f.pdf.byteLength, f.orcids ? JSON.stringify(f.orcids) : null),
    // Emails attach to the version just inserted (found by its file).
    ...f.emails.map((e) =>
      env.DB.prepare(
        `INSERT INTO manuscript_author_emails (manuscript_id, v, position, email)
         SELECT manuscript_id, v, ?2, ?3 FROM manuscript_versions WHERE file_key = ?1`,
      ).bind(key, e.position, e.email),
    ),
    ...(f.viaToken
      ? [env.DB.prepare(`INSERT INTO manuscript_tokens (manuscript_id, token_id) SELECT manuscript_id, ?2 FROM manuscript_versions WHERE file_key = ?1`).bind(key, f.viaToken)]
      : []),
  ]).catch(async (e) => {
    await env.PDFS.delete(key).catch(() => {});
    throw e;
  });
  const id = (ins.results as { id: string }[])[0]?.id ?? null;
  // Nothing inserted (the daily limit or a duplicate, from a parallel post): drop the file.
  if (!id) await env.PDFS.delete(key).catch(() => {});
  return id;
}

// ---------------------------------------------------------------------------------------------
// small pieces

const person = (u: Pick<User, "id" | "displayName" | "avatar">, cls = "ms-person") =>
  html`<a class="${cls}" href="/u/${u.id}">${avatar(u, "avatar-xs")}${u.displayName}</a>`;

/** BibTeX with one braced entry per author, so free-text names are never reparsed. */
function bibtex(m: Manuscript, v: Version, origin: string): string {
  const esc = (s: string) => s.replace(/[{}\\]/g, "");
  return `@misc{oc-${m.id.replace("/", "-")},
  author       = {${authorsOf(v).map((a) => `{${esc(a)}}`).join(" and ")}},
  title        = {${esc(v.title)}},
  year         = {${m.day.slice(0, 4)}},
  howpublished = {Open Cryptology ${m.id}},
  url          = {${origin}/${m.id}},
  note         = {Version ${v.v}}
}`;
}

/** A manuscript as JSON for the API (null if there's no such manuscript; `removed` if a maintainer
 *  removed it). The uploader is shown by name and profile link, as on the page. */
export async function manuscriptJson(env: Env, origin: string, id: string): Promise<Record<string, unknown> | null> {
  const got = await getManuscript(env, id);
  if (!got) return null;
  const { m, versions } = got;
  if (m.removed_at) return { id: m.id, removed: true };
  const v = versions[0];
  const up = (await publicUsers(env, [m.uploader_id])).get(m.uploader_id);
  return {
    id: m.id,
    url: `${origin}/${m.id}`,
    pdf_url: `${origin}/${m.id}.pdf`,
    title: v.title,
    authors: authorsOf(v),
    orcids: orcidsOf(v).some(Boolean) ? orcidsOf(v) : null,
    abstract: v.abstract,
    license: "CC-BY-4.0",
    uploaded_by: up && !up.deleted ? { name: up.displayName, profile_url: `${origin}/u/${up.id}` } : null,
    created_at: m.created_at,
    version: v.v,
    versions: versions.map((x) => ({ v: x.v, created_at: x.created_at })),
    withdrawn: m.withdrawn_at ? { at: m.withdrawn_at, reason: m.withdrawn_reason } : null,
    cite_as: `Open Cryptology ${m.id}`,
    bibtex: bibtex(m, v, origin),
  };
}

/** The newest manuscripts as JSON (for GET /api/manuscripts). */
export async function latestManuscriptsJson(env: Env, origin: string, limit: number): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare(`${LIST_SQL} ORDER BY m.created_at DESC LIMIT ?1`).bind(limit).all<Row>();
  const people = await publicUsers(env, [...new Set(r.results.map((x) => x.uploader_id))]);
  return r.results.map((x) => {
    const up = people.get(x.uploader_id);
    return {
      id: x.id,
      url: `${origin}/${x.id}`,
      pdf_url: `${origin}/${x.id}.pdf`,
      title: x.title,
      authors: authorsOf(x),
      uploaded_by: up && !up.deleted ? { name: up.displayName, profile_url: `${origin}/u/${up.id}` } : null,
      withdrawn: !!x.withdrawn_at,
    };
  });
}

function goneResponse(env: Env, m: Manuscript): Response {
  return messagePage(env, 410, `Original manuscript ${m.id}`, html`<p>This original manuscript was removed by the maintainers.</p>`, {
    cache: "public, max-age=300",
  });
}

const withdrawnNotice = (m: Manuscript) =>
  m.withdrawn_at &&
  html`<div class="alert alert-warning withdrawn-notice" role="note"><strong>Withdrawn</strong> by the uploader on ${dateLong(m.withdrawn_at)}${m.withdrawn_reason ? html`: ${m.withdrawn_reason}` : "."}
  Earlier versions stay readable.</div>`;

// ---------------------------------------------------------------------------------------------
// the manuscript page: title, authors, uploader, abstract, metadata, BibTeX (never the full text)

async function manuscriptPage(env: Env, url: URL, id: string): Promise<Response> {
  const got = await getManuscript(env, id);
  if (!got) return messagePage(env, 404, "No such original manuscript", html`<p>There's no original manuscript ${id}.</p>`);
  const { m, versions } = got;
  if (m.removed_at) return goneResponse(env, m);
  const v = versions[0];
  const up = (await publicUsers(env, [m.uploader_id])).get(m.uploader_id);
  const origin = siteOrigin(env, url);
  const authors = authorsOf(v);
  const orcids = orcidsOf(v);
  const fileHref = `/${m.id}.pdf`;
  const thread = await loadThread(env, m.id);
  const head = html`<meta name="citation_title" content="${v.title}">
${authors.map((a) => html`<meta name="citation_author" content="${a}">`)}
<meta name="citation_publication_date" content="${m.day.replace(/-/g, "/")}">
<meta name="citation_online_date" content="${v.created_at.slice(0, 10).replace(/-/g, "/")}">
<meta name="citation_publisher" content="Open Cryptology">
<meta name="citation_abstract_html_url" content="${origin}/${m.id}">
<meta name="citation_pdf_url" content="${origin}${fileHref}">`;
  const body = html`<div class="paper-row">
  <div class="paper-main">
    <h4>Original manuscript ${m.id}</h4>
    ${withdrawnNotice(m)}
    <h3 class="paper-title tex"><a href="${fileHref}">${v.title}</a></h3>
    <div class="ms-authors">${authors.map((a, i) => html`${i ? ", " : ""}${a}${orcids[i] && orcidLink(orcids[i]!)}`)}</div>
    ${up && !up.deleted ? html`<div class="ms-uploader">Uploaded by ${person(up)}</div>` : html`<div class="ms-uploader">Uploaded by a deleted account</div>`}
    <h5 class="mt-3">Abstract</h5>
    <p class="paper-abstract tex">${v.abstract}</p>
  </div>
  <div id="metadata" class="paper-meta">
    <div class="meta-top">
      <a class="btn btn-pdf" href="${fileHref}">${icons.pdf}PDF</a>
      ${citeControl(bibtex(m, v, origin))}
    </div>
    <dl class="meta-rows">
      <dt>License</dt><dd><a class="cc" href="${LICENSE_URL}" rel="license noopener">CC BY</a></dd>
      <dt>Versions</dt>
      <dd>${metaList(versions.map((x) => html`v${x.v} <small class="text-muted">${dateLong(x.created_at)}</small>`))}</dd>
    </dl>
  </div>
</div>
${commentsSection(thread, url)}`;
  return page(env, {
    title: `${m.id}: ${v.title}`,
    description: v.abstract.replace(/\s+/g, " ").slice(0, 200),
    body,
    head,
    katex: true,
    canonical: `${origin}/${m.id}`,
    ogType: "article",
    cache: url.searchParams.has("comment") ? "no-store" : "public, max-age=120",
    headers: { link: `<${LICENSE_URL}>; rel="license"` },
  });
}

// ---------------------------------------------------------------------------------------------
// /<id>.pdf: the latest version's file

async function manuscriptFile(env: Env, req: Request, id: string): Promise<Response> {
  const got = await getManuscript(env, id);
  if (!got) return messagePage(env, 404, "No such original manuscript", html`<p>There's no original manuscript ${id}.</p>`);
  const { m, versions } = got;
  if (m.removed_at) return goneResponse(env, m);
  const v = versions[0];
  const etag = `"${v.sha256}"`;
  const headers = new Headers({
    "content-type": "application/pdf",
    "content-disposition": `inline; filename="open-cryptology-${m.id.replace("/", "-")}-v${v.v}.pdf"`,
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    link: `<${LICENSE_URL}>; rel="license"`,
    etag,
  });
  if (m.withdrawn_at) headers.set("x-withdrawn", "1");
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
  const obj = v.file_key ? await (req.method === "HEAD" ? env.PDFS.head(v.file_key) : env.PDFS.get(v.file_key)) : null;
  if (!obj) return messagePage(env, 404, "File missing", html`<p>The file for original manuscript ${id} is missing. Please <a href="/contact?topic=manuscript">tell us</a>.</p>`);
  headers.set("content-length", String(obj.size));
  return new Response("body" in obj ? (obj as R2ObjectBody).body : null, { headers });
}

// ---------------------------------------------------------------------------------------------
// lists

interface Row {
  id: string;
  uploader_id: string;
  withdrawn_at: string | null;
  title: string;
  authors: string;
}

const LIST_SQL = `SELECT m.id, m.uploader_id, m.withdrawn_at, v.title, v.authors FROM manuscripts m
  JOIN manuscript_versions v ON v.manuscript_id = m.id AND v.v = (SELECT MAX(v) FROM manuscript_versions WHERE manuscript_id = m.id)
  WHERE m.removed_at IS NULL`;

async function rowsHtml(env: Env, rows: Row[]): Promise<Html> {
  const people = await publicUsers(env, [...new Set(rows.map((r) => r.uploader_id))]);
  return html`<ol class="ms-list">${rows.map((r) => {
    const up = people.get(r.uploader_id);
    return html`<li class="ms-row"><div class="ms-row-main">
    <a class="ms-row-title tex" href="/${r.id}">${r.title}</a>${r.withdrawn_at ? html` <span class="ms-flag">withdrawn</span>` : ""}
    <div class="ms-row-authors">${authorsOf(r).join(", ")}</div>
    ${up && !up.deleted && person(up, "ms-row-person")}
  </div></li>`;
  })}</ol>`;
}

async function listPage(env: Env): Promise<Response> {
  const r = await env.DB.prepare(`${LIST_SQL} ORDER BY m.created_at DESC LIMIT 200`).all<Row>();
  const byDay = new Map<string, Row[]>();
  for (const x of r.results) byDay.set(x.id.slice(0, 10), [...(byDay.get(x.id.slice(0, 10)) ?? []), x]);
  const groups: Html[] = [];
  for (const [d, rows] of byDay) groups.push(html`<h5 class="ms-day">${dateLong(d)}</h5>${await rowsHtml(env, rows)}`);
  return page(env, {
    title: "Original manuscripts",
    description: "Original manuscripts posted on Open Cryptology, newest first.",
    katex: true,
    cache: "public, max-age=120",
    body: html`<div class="ms-list-head">
  <h1 class="ms-title">Original manuscripts</h1>
  <a class="btn hm-primary" href="/submit">Submit a manuscript</a>
</div>
${groups.length ? groups : html`<p class="text-muted mt-3">None yet.</p>`}`,
  });
}

/** The newest manuscripts as list rows (homepage). */
export async function latestManuscripts(env: Env, limit: number): Promise<{ rows: Html | null; count: number }> {
  const r = await env.DB.prepare(`${LIST_SQL} ORDER BY m.created_at DESC LIMIT ?1`).bind(limit).all<Row>();
  return { rows: r.results.length ? await rowsHtml(env, r.results) : null, count: r.results.length };
}

/** Manuscripts whose title, authors or abstract contain every word of `q` (search page). There are
 *  few enough manuscripts that a scan is fine; ePrint papers use the full-text index instead. */
export async function searchManuscripts(env: Env, q: string, limit: number): Promise<{ rows: Html | null; count: number }> {
  const words = q
    .toLowerCase()
    .replace(/\b(author|title|abstract):/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 8);
  if (!words.length) return { rows: null, count: 0 };
  const where = words.map((_, i) => `AND lower(v.title || ' ' || v.authors || ' ' || v.abstract) LIKE ?${i + 1}`).join(" ");
  const r = await env.DB.prepare(`${LIST_SQL} ${where} ORDER BY m.created_at DESC LIMIT ${Math.floor(limit)}`)
    .bind(...words.map((w) => `%${w}%`))
    .all<Row>();
  return { rows: r.results.length ? await rowsHtml(env, r.results) : null, count: r.results.length };
}

/** A short plain-text bio may contain named HTTP(S) links. Escape all operator-supplied text. */
function botBio(bio: string) {
  let offset = 0;
  const parts: Html[] = [];
  const plain = bio.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/gi, (match, label: string, target: string, index: number) => {
    const href = safeUrl(target);
    if (!href) return match;
    parts.push(html`${bio.slice(offset, index)}<a href="${href}" rel="ugc noopener">${label}</a>`);
    offset = index + match.length;
    return label;
  });
  return { plain, linked: html`${parts}${bio.slice(offset)}` };
}

/** A person's public profile: their log-in methods and the manuscripts they uploaded. */
async function profilePage(env: Env, userId: string, url: URL): Promise<Response> {
  const u = (await publicUsers(env, [userId])).get(userId);
  if (!u || u.id !== userId) return messagePage(env, 404, "No such account", html`<p>There's no account here.</p>`);
  if (u.deleted) return messagePage(env, 410, "Deleted account", html`<p>This account was deleted.</p>`);
  if (u.botBio !== null) {
    const bio = botBio(u.botBio);
    return page(env, {
      title: u.displayName,
      description: bio.plain,
      cache: "public, max-age=30",
      body: html`<div class="ms-profile">
  <header class="ms-profile-head">
    ${avatar(u, "avatar-lg")}
    <div class="bot-profile-name"><h1 class="ms-title">${u.displayName}</h1><span class="cm-flair bot-badge">Bot</span></div>
  </header>
  ${u.botBio && html`<p class="bot-bio">${bio.linked}</p>`}
  <p>Want to run your own bot? <a href="/contact?topic=bot">Contact the maintainers</a>.</p>
  ${await botCommentFeed(env, userId, url)}
</div>`,
    });
  }
  const r = await env.DB.prepare(`${LIST_SQL} AND m.uploader_id = ?1 ORDER BY m.created_at DESC LIMIT 200`).bind(userId).all<Row>();
  return page(env, {
    title: u.displayName,
    katex: true,
    cache: "public, max-age=300",
    body: html`<div class="ms-profile">
  <header class="ms-profile-head">
    ${avatar(u, "avatar-lg")}
    <div>
      <h1 class="ms-title">${u.displayName}</h1>
      <ul class="ms-idents">${u.identities.map((i) => html`<li>${providerTag(i.provider)} ${identityDetail(i)}</li>`)}</ul>
    </div>
  </header>
  <h5 class="ms-day">Original manuscripts uploaded</h5>
  ${r.results.length ? await rowsHtml(env, r.results) : html`<p class="text-muted">None yet.</p>`}
</div>`,
  });
}

// ---------------------------------------------------------------------------------------------
// submit

interface Form {
  title: string;
  authors: AuthorIn[];
  abstract: string;
  err?: string;
}

function submitPage(env: Env, f: Form, status = 200): Response {
  const authorRows = (f.authors.length ? f.authors : [{ name: "" }, { name: "" }]).map(
    (a, i) => html`<div class="sb-author">
      <input class="form-control sb-name-input" name="author" value="${a.name}" aria-label="Author ${i + 1} name (required)" maxlength="200"${i === 0 ? raw(" required") : ""}>
      <input class="form-control sb-orcid" name="author_orcid" value="${a.orcid ?? ""}" aria-label="Author ${i + 1} ORCID iD (recommended)" maxlength="60" autocomplete="off" spellcheck="false" pattern="${ORCID_PATTERN}" title="An ORCID iD: 0000-0000-0000-0000">
      <input class="form-control sb-email" name="author_email" type="email" value="${a.email ?? ""}" aria-label="Author ${i + 1} email (recommended)" maxlength="254" autocomplete="off" spellcheck="false">
      <button type="button" class="sb-remove" aria-label="Remove this author" hidden>×</button></div>`,
  );
  return page(env, {
    title: "Submit an original manuscript",
    status,
    katex: true, // the abstract preview
    ...NO_STORE,
    body: html`<div class="sb">
  <h1 class="ms-title">Submit an original manuscript</h1>
  <p class="text-muted">Published right away, without review.</p>
  ${f.err && html`<p class="settings-notice settings-notice-err" role="alert">${f.err}</p>`}
  <form class="ms-form" method="post" action="/submit" enctype="multipart/form-data">
    <label class="form-label" for="sb-file">Manuscript</label>
    <label class="sb-drop" for="sb-file">
      <input type="file" id="sb-file" name="file" accept="application/pdf,.pdf" required>
      <strong class="sb-name">Drop a PDF here</strong>
      <span>or click to choose · up to 30 MB</span>
    </label>
    <label class="form-label" for="sb-title">Title</label>
    <input class="form-control" id="sb-title" name="title" value="${f.title}" maxlength="300" required>
    <label class="form-label">Authors <span class="sb-sub">as they should be cited</span></label>
    <div class="sb-author sb-author-head" aria-hidden="true"><span class="sb-name-input">Name <span class="sb-sub">required</span></span><span class="sb-orcid">ORCID iD <span class="sb-sub">recommended</span></span><span class="sb-email">Email <span class="sb-sub">recommended</span></span><span class="sb-remove"></span></div>
    <div class="sb-authors">${authorRows}</div>
    <div><button type="button" class="sb-add btn btn-sm btn-link" hidden>+ Add author</button></div>
    <p class="form-hint text-muted">People or models. You're shown separately as the uploader.</p>
    <div class="sb-field-head">
      <label class="form-label" for="sb-abstract">Abstract</label>
      <span class="sb-tabs" hidden><button type="button" class="sb-tab" data-tab="write" aria-pressed="true">Write</button><button type="button" class="sb-tab" data-tab="preview" aria-pressed="false">Preview</button></span>
    </div>
    <textarea class="form-control" id="sb-abstract" name="abstract" rows="6" maxlength="5000" required>${f.abstract}</textarea>
    <div class="sb-preview paper-abstract" id="sb-abstract-preview" hidden></div>
    <p class="form-hint text-muted">LaTeX math between $...$ is typeset.</p>
    <label class="acct-check ms-license"><input type="checkbox" name="agree" value="yes" required> I agree to the <a href="/terms">terms</a> and license this manuscript under <a href="${LICENSE_URL}">CC BY 4.0</a>.</label>
    <div><button type="submit" class="btn btn-outline-dark hm-primary">Publish</button></div>
  </form>
</div>`,
  });
}

/** What a new manuscript needs, from the web form or the agent API. */
export interface NewManuscript {
  title: string;
  /** In citation order: a name, or a name with an ORCID iD and/or an email. */
  authors: (string | AuthorIn)[];
  abstract: string;
  file: File | null;
  /** Whether the uploader accepted the terms and CC BY 4.0, and what to say if not. */
  license: { accepted: boolean; message: string };
  /** The agent token it came through (stored for moderation, never shown). */
  viaToken?: string;
}
export type PublishResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; status: number; code: string; message: string; existing?: string };

const cleanTitle = (s: string) => s.replace(/\s+/g, " ").trim();
/** Authors with tidied fields; rows with nothing in them are dropped. */
export const cleanAuthors = (xs: (string | AuthorIn)[]): AuthorIn[] =>
  xs
    .map((a) => (typeof a === "string" ? { name: a } : a))
    .map((a) => ({ name: String(a.name ?? "").replace(/\s+/g, " ").trim(), orcid: String(a.orcid ?? "").trim(), email: String(a.email ?? "").trim() }))
    .filter((a) => a.name || a.orcid || a.email);

/** Check and publish a new manuscript: the same rules for the form and the API. An identical PDF
 *  from the same account in the last 24 hours returns that manuscript instead of a copy, so an
 *  agent can safely retry. */
export async function publishManuscript(env: Env, uploaderId: string, n: NewManuscript): Promise<PublishResult> {
  const fail = (status: number, code: string, message: string): PublishResult => ({ ok: false, status, code, message });
  const title = cleanTitle(n.title);
  const rows = cleanAuthors(n.authors);
  const authors = rows.map((a) => a.name);
  const abstract = n.abstract.trim();
  if (!n.file || !n.file.size) return fail(400, "no_pdf", "Choose a PDF file.");
  if (n.file.size > MAX_PDF) return fail(413, "too_large", "That file is over 30 MB.");
  const pdf = await n.file.arrayBuffer();
  if (new TextDecoder("latin1").decode(new Uint8Array(pdf, 0, Math.min(5, pdf.byteLength))) !== "%PDF-") return fail(415, "not_pdf", "That file isn't a PDF.");
  if (!title) return fail(400, "no_title", "Add a title.");
  if (title.length > 300) return fail(400, "title_too_long", "The title is over 300 characters.");
  if (!authors.length) return fail(400, "no_authors", "Add at least one author.");
  if (authors.length > 100 || authors.some((a) => a.length > 200)) return fail(400, "authors_too_long", "That's too many authors, or a very long name.");
  const who = (i: number) => `author ${i + 1}${rows[i].name ? ` (${rows[i].name})` : ""}`;
  const unnamed = rows.findIndex((a) => !a.name);
  if (unnamed >= 0) return fail(400, "author_name", `Add a name for ${who(unnamed)}.`);
  const orcids = rows.map((a) => (a.orcid ? parseOrcid(a.orcid) : null));
  const badOrcid = rows.findIndex((a, i) => a.orcid && !orcids[i]);
  if (badOrcid >= 0)
    return fail(400, "bad_orcid", `The ORCID iD for ${who(badOrcid)} isn't valid.`);
  const emails = rows.map((a) => (a.email ? parseEmail(a.email) : null));
  const badEmail = rows.findIndex((a, i) => a.email && !emails[i]);
  if (badEmail >= 0) return fail(400, "bad_email", `The email for ${who(badEmail)} isn't valid.`);
  if (!abstract) return fail(400, "no_abstract", "Add an abstract.");
  if (abstract.length > 5000) return fail(400, "abstract_too_long", "The abstract is over 5,000 characters.");
  if (!n.license.accepted) return fail(400, "license_not_accepted", n.license.message);
  const sha = await sha256Hex(pdf);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const orcidList = orcids.some(Boolean) ? orcids : null;
  const same = () => sameFileAs(env, uploaderId, sha, since, { title, authors, orcids: orcidList, abstract });
  const dup = await same();
  if (dup) return dup;
  const [mine, site] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS n FROM manuscripts WHERE uploader_id = ?1 AND created_at > ?2").bind(uploaderId, since),
    env.DB.prepare("SELECT count(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM manuscript_versions WHERE created_at > ?1").bind(since),
  ]);
  if (((mine.results[0] as { n: number })?.n ?? 0) >= MAX_PER_DAY) return fail(429, "daily_limit", `You can post up to ${MAX_PER_DAY} manuscripts a day. Try again tomorrow.`);
  const s = site.results[0] as { n: number; bytes: number } | undefined;
  if ((s?.n ?? 0) >= SITE_PER_DAY || (s?.bytes ?? 0) + pdf.byteLength > SITE_BYTES_PER_DAY)
    return fail(429, "site_daily_limit", "The site has taken as many new manuscripts as it can for today. Please try again tomorrow.");
  // Last, as it's the slow part: the same safety checks as uploads to the ePrint mirror.
  const check = await inspectPdf(pdf);
  if (check.problem) return fail(422, "unreadable_pdf", `We couldn't read that PDF (${check.problem.slice(0, 120)}). Try exporting it again.`);
  if (check.active)
    return fail(422, "active_content", `That PDF contains ${check.active === "scripts" ? "JavaScript" : check.active}, which we don't host. Export it again without it (for example with "Print to PDF").`);
  // The insert re-checks the daily limit and duplicates itself, so parallel posts can't get past them.
  const id = await createManuscript(env, uploaderId, {
    title,
    authors,
    orcids: orcidList,
    emails: emails.flatMap((email, position) => (email ? [{ position, email }] : [])),
    abstract,
    pdf,
    sha,
    viaToken: n.viaToken,
    since,
  });
  if (!id) return (await same()) ?? fail(429, "daily_limit", `You can post up to ${MAX_PER_DAY} manuscripts a day. Try again tomorrow.`);
  return { ok: true, id, duplicate: false };
}

/** The same PDF from the same account in the last 24 hours: that manuscript if the metadata
 *  matches too (a retry), else a 409 (changing a manuscript needs a new version). */
async function sameFileAs(
  env: Env,
  uploaderId: string,
  sha: string,
  since: string,
  f: { title: string; authors: string[]; orcids: (string | null)[] | null; abstract: string },
): Promise<PublishResult | null> {
  const d = await env.DB.prepare(
    `SELECT m.id, v.title, v.authors, v.author_orcids, v.abstract FROM manuscripts m JOIN manuscript_versions v ON v.manuscript_id = m.id
      WHERE m.uploader_id = ?1 AND v.sha256 = ?2 AND m.created_at > ?3 AND m.removed_at IS NULL LIMIT 1`,
  )
    .bind(uploaderId, sha, since)
    .first<{ id: string; title: string; authors: string; author_orcids: string | null; abstract: string }>();
  if (!d) return null;
  if (d.title === f.title && d.authors === JSON.stringify(f.authors) && d.author_orcids === (f.orcids ? JSON.stringify(f.orcids) : null) && d.abstract === f.abstract)
    return { ok: true, id: d.id, duplicate: true };
  return {
    ok: false,
    status: 409,
    code: "duplicate_pdf",
    message: `You posted this PDF as ${d.id} with different details. Changing a manuscript needs a new version, which isn't available yet.`,
    existing: d.id,
  };
}

async function submitPost(env: Env, req: Request, uploaderId: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return submitPage(env, { title: "", authors: [], abstract: "", err: "That didn't arrive as a form. Please try again." }, 400);
  // One row per author: name, ORCID iD, email (the three inputs of a row are sent in order).
  const names = form.getAll("author").map(String);
  const orcids = form.getAll("author_orcid").map(String);
  const emails = form.getAll("author_email").map(String);
  const f: Form = {
    title: cleanTitle(String(form.get("title") ?? "")),
    authors: cleanAuthors(names.map((name, i) => ({ name, orcid: orcids[i] ?? "", email: emails[i] ?? "" }))),
    abstract: String(form.get("abstract") ?? "").trim(),
  };
  const file = form.get("file");
  const r = await publishManuscript(env, uploaderId, {
    ...f,
    file: file instanceof File ? file : null,
    license: { accepted: form.get("agree") === "yes", message: "Tick the box to agree to the terms and the CC BY 4.0 license." },
  });
  if (!r.ok) return submitPage(env, { ...f, err: r.message }, r.status === 429 ? 429 : 400);
  return redirect303(`/${r.id}`);
}


// ---------------------------------------------------------------------------------------------
// maintainer removal (form on /review)

async function removePost(env: Env, req: Request): Promise<Response> {
  const a = await requireUser(env, req, { role: "maintainer" });
  if (isAuthFailure(a)) return messagePage(env, 403, "Maintainers only", html`<p>Removing manuscripts is for maintainers.</p>`, NO_STORE);
  const form = await req.formData();
  const id = String(form.get("id") ?? "").trim().replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "").replace(/\.pdf$/, "");
  const files = await env.DB.prepare("SELECT file_key FROM manuscript_versions WHERE manuscript_id = ?1 AND file_key IS NOT NULL").bind(id).all<{ file_key: string }>();
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE manuscripts SET removed_at = ?2, removed_by = ?3 WHERE id = ?1 AND removed_at IS NULL").bind(id, new Date().toISOString(), a.user.id),
    env.DB.prepare("UPDATE manuscript_versions SET body = NULL, file_key = NULL, abstract = '', title = '(removed)' WHERE manuscript_id = ?1 AND EXISTS (SELECT 1 FROM manuscripts WHERE id = ?1 AND removed_by = ?2)").bind(id, a.user.id),
  ]);
  const ok = (r[0].meta.changes ?? 0) > 0;
  if (ok && files.results.length) await env.PDFS.delete(files.results.map((x) => x.file_key));
  const revoked = form.get("revoke") === "yes" && (await revokeAgentsOfManuscript(env, id));
  return messagePage(
    env,
    ok ? 200 : 404,
    ok ? "Removed" : "Not found",
    ok ? html`<p>Original manuscript ${id} was removed.${revoked ? " The uploader’s agents were disconnected." : ""}</p>` : html`<p>No original manuscript ${id} to remove.</p>`,
    NO_STORE,
  );
}

// ---------------------------------------------------------------------------------------------
// terms of use

function termsPage(env: Env): Response {
  return page(env, {
    title: "Terms of use",
    description: "The terms for using Open Cryptology and posting original manuscripts.",
    cache: "public, max-age=3600",
    body: html`<article class="tou">
  <h1 class="ms-title">Terms of use</h1>
  <p class="text-muted">Last updated 15 November 2026.</p>
  <p>Open Cryptology is a free, non-commercial site run by Sela Navot (“we”). By using it you agree to these terms.
  Original manuscripts are published as soon as they're posted, without review, so these terms are how we keep the site useful and safe.</p>

  <h2>Licenses for original manuscripts</h2>
  <ul>
    <li><strong>You keep your copyright.</strong> By posting, you license every version of your manuscript to everyone under
    <a href="${LICENSE_URL}">Creative Commons Attribution 4.0</a> (CC BY 4.0).</li>
    <li><strong>You also grant us our own license:</strong> a non-exclusive, perpetual, irrevocable, worldwide, royalty-free license to host,
    copy, convert, index, display and distribute each version, in any format and through any service, now and later. This doesn't transfer
    your copyright.</li>
    <li><strong>Titles, author lists and abstracts</strong> are dedicated to the public domain
    (<a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>), so anyone, including search engines and AI agents, may reuse
    them freely.</li>
    <li><strong>You confirm you have the right to grant these licenses</strong>, including for anything produced with AI tools (under those
    tools' terms), and that posting doesn't break an agreement with a publisher, employer or funder.</li>
  </ul>

  <h2>Acceptable use</h2>
  <p>Don't post, or use the site for:</p>
  <ul>
    <li>anything illegal, or anything that infringes someone else's copyright or other rights;</li>
    <li>other people's private information, credentials, keys or leaked data;</li>
    <li>malware, or working exploits against specific deployed systems whose owners haven't had a fair chance to fix them
    (attacks on algorithms, protocols and published constructions are what this site is for);</li>
    <li>harassment, threats, hate, or impersonating a person or organization;</li>
    <li>naming real people as authors without their consent;</li>
    <li>spam, advertising, or content that has nothing to do with cryptography;</li>
    <li>misleading claims about how a result was produced or checked;</li>
    <li>flooding the site, getting around its limits, or attacking it.</li>
  </ul>

  <h2>Removal and reporting</h2>
  <ul>
    <li><strong>We can remove anything.</strong> Maintainers may hide or delete any manuscript, version or account, revoke any agent's
    access, or suspend anyone, at any time and for any reason. We'll usually say why.</li>
    <li><strong>Posts stay public otherwise.</strong> You can add versions or withdraw a manuscript, which adds a notice, but earlier versions
    stay readable, as on ePrint and arXiv. Don't post anything you couldn't leave public.</li>
    <li><strong>Report problems</strong> through the <a href="/contact">contact form</a>. We may share information when the law requires it.</li>
  </ul>

  <h2>Accounts and agents</h2>
  <p>You're responsible for everything posted from your account, including by agents using your tokens. The authors line is yours to
  write; we don't check it.</p>

  <h2>Changes</h2>
  <p>We may change, add or remove features, change these terms, or stop running the site. Changes apply from when we post them here;
  licenses already granted stay as they were.</p>

  <h2>No warranty</h2>
  <p>The site and everything on it are provided as is. Manuscripts aren't reviewed; read them critically. To the extent the law allows,
  we aren't liable for losses from using the site.</p>

  <p class="text-muted small">See also the <a href="/privacy">privacy page</a>.</p>
</article>`,
  });
}

// ---------------------------------------------------------------------------------------------
// routes

export async function handleManuscripts(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const isGet = req.method === "GET" || req.method === "HEAD";
  if (path === "/submit") {
    const a = await currentUser(env, req);
    if (req.method === "POST") {
      const r = await requireUser(env, req);
      if (isAuthFailure(r)) return r.code === "signin" ? redirect303("/account?next=/submit") : messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren't accepted.</p>`, NO_STORE);
      return submitPost(env, req, r.user.id);
    }
    if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>Use the form.</p>`, NO_STORE);
    if (!a) return redirect303("/account?next=/submit");
    return submitPage(env, { title: "", authors: [], abstract: "" });
  }
  if (path === "/manuscripts/remove") {
    if (req.method !== "POST") return messagePage(env, 405, "Method not allowed", html`<p>Use the form on the review page.</p>`, NO_STORE);
    return removePost(env, req);
  }
  if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>This page is read-only.</p>`, NO_STORE);
  if (path === "/manuscripts") return listPage(env);
  if (path === "/terms") return termsPage(env);
  const picture = BOT_AVATAR_RE.exec(path);
  if (picture) {
    const bytes = await env.DB.prepare("SELECT bot_avatar FROM users WHERE id = ?1 AND bot_bio IS NOT NULL AND deleted_at IS NULL")
      .bind(picture[1]).first<ArrayBuffer>("bot_avatar");
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(req.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: { "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "public, max-age=300" },
    });
  }
  const pm = PROFILE_RE.exec(path);
  if (pm) return profilePage(env, pm[1], url);
  const mm = MS_RE.exec(path)!;
  const id = `${mm[1]}/${Number(mm[2])}`;
  const want = `/${id}${mm[3] ?? ""}`;
  if (path !== want) return new Response(null, { status: 301, headers: { location: want + url.search } });
  return mm[3] ? manuscriptFile(env, req, id) : manuscriptPage(env, url, id);
}
