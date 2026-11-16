// Original manuscripts: results shared faster than papers, including AI-generated ones.
// Ids are the UTC date of first publication plus that day's number: /2026-11-15/3 (the page),
// /2026-11-15/3.md (the reading page in a browser, the raw Markdown for agents and curl).
// Tables: the "original manuscripts" section of db/schema.sql. Uploaders are accounts (auth.ts),
// always shown as "uploaded by", separately from the free-text authors.
import type { Env } from "./db";
import { html, raw, type Html } from "./html";
import { icons, messagePage, page } from "./layout";
import { avatar, identityDetail, providerTag } from "./account";
import { currentUser, isAuthFailure, publicUsers, redirect303, requireUser, type User } from "./auth";
import { extractMeta, renderInline, renderManuscript } from "./markdown";
import { formatGuidePage, templateMd } from "./manuscript-guide";
import { siteOrigin } from "./seo";

export const MS_RE = /^\/(\d{4}-\d{2}-\d{2})\/(\d{1,4})(\.md)?\/?$/;
const PROFILE_RE = /^\/u\/([a-z2-7]{12})\/?$/;

export const isManuscriptPath = (path: string): boolean =>
  MS_RE.test(path) || PROFILE_RE.test(path) || ["/manuscripts", "/submit", "/terms", "/manuscripts/remove", "/manuscripts/format", "/manuscripts/template.md"].includes(path);

const MAX_MD = 200_000; // bytes
const MAX_PER_DAY = 20; // new manuscripts per account per 24 hours
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
  abstract: string;
  format: "md" | "pdf";
  body: string | null;
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
async function createManuscript(env: Env, uploaderId: string, f: { title: string; authors: string[]; abstract: string; body: string }): Promise<string> {
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const bytes = new TextEncoder().encode(f.body);
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO manuscripts (id, day, num, uploader_id, created_at)
       SELECT ?1 || '/' || (COALESCE(MAX(num), 0) + 1), ?1, COALESCE(MAX(num), 0) + 1, ?2, ?3 FROM manuscripts WHERE day = ?1
       RETURNING id`,
    ).bind(day, uploaderId, now),
    env.DB.prepare(
      `INSERT INTO manuscript_versions (manuscript_id, v, title, authors, abstract, format, body, sha256, size, created_at)
       SELECT id, 1, ?3, ?4, ?5, 'md', ?6, ?7, ?8, ?2 FROM manuscripts WHERE uploader_id = ?1 AND created_at = ?2`,
    ).bind(uploaderId, now, f.title, JSON.stringify(f.authors), f.abstract, f.body, sha, bytes.length),
  ]);
  return (ins.results as { id: string }[])[0].id;
}

// ---------------------------------------------------------------------------------------------
// small pieces

const person = (u: Pick<User, "id" | "displayName" | "avatar">, cls = "ms-person") =>
  html`<a class="${cls}" href="/u/${u.id}">${avatar(u, "avatar-xs")}${u.displayName}</a>`;

const docIcon = html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 1.5h9v13h-9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 5h5M5.5 7.5h5M5.5 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

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
  const fileHref = `/${m.id}.md`;
  const head = html`<meta name="citation_title" content="${v.title}">
${authors.map((a) => html`<meta name="citation_author" content="${a}">`)}
<meta name="citation_publication_date" content="${m.day.replace(/-/g, "/")}">
<meta name="citation_online_date" content="${v.created_at.slice(0, 10).replace(/-/g, "/")}">
<meta name="citation_publisher" content="Open Cryptology">
<meta name="citation_abstract_html_url" content="${origin}/${m.id}">
<meta name="citation_fulltext_html_url" content="${origin}${fileHref}">`;
  const body = html`<div class="paper-row">
  <div class="paper-main">
    <h4>Original manuscript ${m.id}</h4>
    ${withdrawnNotice(m)}
    <h3 class="paper-title tex"><a href="${fileHref}">${raw(renderInline(v.title))}</a></h3>
    <div class="ms-authors">${authors.join(", ")}</div>
    ${up && !up.deleted ? html`<div class="ms-uploader">Uploaded by ${person(up)}</div>` : html`<div class="ms-uploader">Uploaded by a deleted account</div>`}
    <h5 class="mt-3">Abstract</h5>
    <p class="paper-abstract tex">${raw(renderInline(v.abstract))}</p>
  </div>
  <div class="paper-meta">
    <h5>Metadata</h5>
    <dl>
      <dt>Available format</dt>
      <dd><a class="btn btn-sm btn-outline-dark" href="${fileHref}">${docIcon}Markdown</a></dd>
      <dt>License</dt>
      <dd><a class="cc" href="${LICENSE_URL}" rel="license noopener">CC BY</a></dd>
      <dt>Cite as</dt>
      <dd>Open Cryptology ${m.id}</dd>
      <dt>Versions</dt>
      ${versions.map((x, i) => html`<dd>v${x.v}: ${dateLong(x.created_at)}${i === 0 ? " (latest)" : ""}</dd>`)}
    </dl>
  </div>
</div>

<p class="mt-4 mb-2"><strong>BibTeX</strong>
  <button type="button" class="ms-2 btn btn-sm btn-outline-dark" data-copy="bibtex" aria-label="Copy BibTeX to clipboard">${icons.copy}<span>Copy to clipboard</span></button></p>
<pre id="bibtex">${bibtex(m, v, origin)}</pre>`;
  return page(env, {
    title: `${m.id}: ${v.title}`,
    description: v.abstract.replace(/\s+/g, " ").slice(0, 200),
    body,
    head,
    katex: true,
    canonical: `${origin}/${m.id}`,
    ogType: "article",
    cache: "public, max-age=120",
    headers: { link: `<${LICENSE_URL}>; rel="license"` },
  });
}

// ---------------------------------------------------------------------------------------------
// /<id>.md: the reading page in a browser, the raw Markdown otherwise

async function manuscriptFile(env: Env, req: Request, url: URL, id: string): Promise<Response> {
  const got = await getManuscript(env, id);
  if (!got) return messagePage(env, 404, "No such original manuscript", html`<p>There's no original manuscript ${id}.</p>`);
  const { m, versions } = got;
  if (m.removed_at) return goneResponse(env, m);
  const v = versions[0];
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html") && url.searchParams.get("raw") === null;
  if (!wantsHtml || url.searchParams.has("download")) {
    const headers: Record<string, string> = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=120",
      "x-content-type-options": "nosniff",
      vary: "accept",
      link: `<${LICENSE_URL}>; rel="license"`,
    };
    if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="open-cryptology-${m.id.replace("/", "-")}-v${v.v}.md"`;
    return new Response(v.body ?? "", { headers });
  }
  const up = (await publicUsers(env, [m.uploader_id])).get(m.uploader_id);
  const r = renderManuscript(v.body ?? "");
  const back = `/${m.id}`;
  const toc = r.toc.length ? html`<ol>${r.toc.map((t) => html`<li><a href="#${t.id}">${t.text}</a></li>`)}</ol>` : "";
  const res = page(env, {
    title: `${m.id}: ${v.title}`,
    description: v.abstract.replace(/\s+/g, " ").slice(0, 200),
    katex: true,
    canonical: `${siteOrigin(env, url)}${back}`,
    cache: "public, max-age=120",
    body: html`<div class="rd">
  <header class="rd-bar">
    <a class="rd-home" href="/"><img src="/static/logo.svg" alt="" width="22" height="22">Open Cryptology</a>
    <a class="rd-back" href="${back}">Original manuscript ${m.id} · v${v.v}</a>
    <span class="rd-actions"><a href="${back}">Abstract &amp; cite</a><a class="btn btn-sm btn-outline-dark" href="${back}.md?download">${docIcon}Download .md</a></span>
  </header>
  <div class="rd-grid">
    <nav class="rd-toc" aria-label="Contents">${toc && html`<p>Contents</p>${toc}`}</nav>
    <article class="rd-doc tex">
      ${withdrawnNotice(m)}
      <header class="rd-titleblock">
        <h1>${raw(renderInline(v.title))}</h1>
        <p class="rd-authors">${authorsOf(v).join(", ")}</p>
        <p class="rd-meta">Open Cryptology ${m.id} · Version ${v.v} · ${dateLong(v.created_at)} · CC BY 4.0</p>
        ${up && !up.deleted && html`<p class="rd-meta">Uploaded by ${person(up, "rd-person")}</p>`}
      </header>
      <section class="rd-abstract"><h2>Abstract</h2><p>${raw(renderInline(v.abstract))}</p></section>
      ${toc && html`<details class="rd-toc-inline"><summary>Contents</summary>${toc}</details>`}
      ${raw(r.html)}
      <footer class="rd-end"><a href="${back}">← Abstract, versions and how to cite</a></footer>
    </article>
  </div>
</div>`,
  });
  res.headers.set("vary", "accept");
  return res;
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
    <a class="ms-row-title tex" href="/${r.id}">${raw(renderInline(r.title))}</a>${r.withdrawn_at ? html` <span class="ms-flag">withdrawn</span>` : ""}
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
    description: "Results, notes and open questions in cryptography, shared fast. Citable and versioned.",
    katex: true,
    cache: "public, max-age=120",
    body: html`<div class="ms-list-head">
  <div><h1 class="ms-title">Original manuscripts</h1>
  <p class="text-muted">Results, notes and open questions in cryptography, shared fast. The authors line says who wrote each one, people or models.</p></div>
  <a class="btn btn-outline-dark" href="/submit">Submit an original manuscript</a>
</div>
${groups.length ? groups : html`<p class="text-muted mt-3">None yet.</p>`}`,
  });
}

/** A person's public profile: their log-in methods and the manuscripts they uploaded. */
async function profilePage(env: Env, userId: string): Promise<Response> {
  const u = (await publicUsers(env, [userId])).get(userId);
  if (!u || u.id !== userId) return messagePage(env, 404, "No such account", html`<p>There's no account here.</p>`);
  if (u.deleted) return messagePage(env, 410, "Deleted account", html`<p>This account was deleted.</p>`);
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
  authors: string[];
  abstract: string;
  err?: string;
}

function submitPage(env: Env, f: Form, status = 200): Response {
  const authorRows = (f.authors.length ? f.authors : ["", ""]).map(
    (a, i) => html`<div class="sb-author"><input class="form-control" name="author" value="${a}" aria-label="Author ${i + 1}" maxlength="200"${i === 0 ? raw(" required") : ""}>
      <button type="button" class="sb-remove" aria-label="Remove this author" hidden>×</button></div>`,
  );
  return page(env, {
    title: "Submit an original manuscript",
    status,
    ...NO_STORE,
    body: html`<div class="sb">
  <h1 class="ms-title">Submit an original manuscript</h1>
  <p class="text-muted">Published right away at a permanent, citable link.</p>
  ${f.err && html`<p class="settings-notice settings-notice-err" role="alert">${f.err}</p>`}
  <form class="ms-form" method="post" action="/submit" enctype="multipart/form-data">
    <label class="form-label" for="sb-file">Manuscript</label>
    <label class="sb-drop" for="sb-file">
      <input type="file" id="sb-file" name="file" accept=".md,text/markdown" required>
      <strong class="sb-name">Drop a Markdown file here</strong>
      <span>or click to choose · .md, up to 200 KB</span>
    </label>
    <p class="form-hint text-muted">It gets a typeset reading page, and its title and abstract fill in below. <a href="/manuscripts/format" target="_blank">How to format it</a></p>
    <label class="form-label" for="sb-title">Title</label>
    <input class="form-control" id="sb-title" name="title" value="${f.title}" maxlength="300" required>
    <label class="form-label">Authors <span class="sb-sub">as they should be cited</span></label>
    <div class="sb-authors">${authorRows}</div>
    <div><button type="button" class="sb-add btn btn-sm btn-link" hidden>+ Add author</button></div>
    <p class="form-hint text-muted">People or models, e.g. Ada Lovelace or Claude Fable 5.2. You're shown separately as the uploader.</p>
    <label class="form-label" for="sb-abstract">Abstract</label>
    <textarea class="form-control" id="sb-abstract" name="abstract" rows="4" maxlength="5000" required>${f.abstract}</textarea>
    <label class="acct-check ms-license"><input type="checkbox" name="agree" value="yes" required> I agree to the <a href="/terms">terms</a> and license this manuscript under <a href="${LICENSE_URL}">CC BY 4.0</a>.</label>
    <div><button type="submit" class="btn btn-outline-dark hm-primary">Publish</button></div>
  </form>
</div>`,
  });
}

async function submitPost(env: Env, req: Request, uploaderId: string): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return submitPage(env, { title: "", authors: [], abstract: "", err: "That didn't arrive as a form. Please try again." }, 400);
  const authors = form.getAll("author").map((a) => String(a).replace(/\s+/g, " ").trim()).filter(Boolean);
  const f: Form = { title: String(form.get("title") ?? "").replace(/\s+/g, " ").trim(), authors, abstract: String(form.get("abstract") ?? "").trim() };
  const bad = (err: string) => submitPage(env, { ...f, err }, 400);
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return bad("Choose a Markdown (.md) file.");
  if (!/\.(md|markdown)$/i.test(file.name)) return bad("For now, original manuscripts are Markdown (.md) files. PDF uploads are coming.");
  if (file.size > MAX_MD) return bad("That file is over 200 KB.");
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await file.arrayBuffer());
  } catch {
    return bad("That file isn't UTF-8 text.");
  }
  const meta = extractMeta(body);
  f.title ||= meta.title.replace(/\s+/g, " ").trim();
  f.abstract ||= meta.abstract;
  if (!f.title) return bad("Add a title (or start the file with a # Title line).");
  if (f.title.length > 300) return bad("The title is over 300 characters.");
  if (!f.authors.length) return bad("Add at least one author.");
  if (f.authors.length > 100 || f.authors.some((a) => a.length > 200)) return bad("That's too many authors, or a very long name.");
  if (!f.abstract) return bad("Add an abstract (or an ## Abstract section in the file).");
  if (f.abstract.length > 5000) return bad("The abstract is over 5,000 characters.");
  if (form.get("agree") !== "yes") return bad("Tick the box to agree to the terms and the CC BY 4.0 license.");
  const recent = await env.DB.prepare("SELECT count(*) AS n FROM manuscripts WHERE uploader_id = ?1 AND created_at > ?2")
    .bind(uploaderId, new Date(Date.now() - 86_400_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_PER_DAY) return submitPage(env, { ...f, err: `You can post up to ${MAX_PER_DAY} manuscripts a day. Try again tomorrow.` }, 429);
  const id = await createManuscript(env, uploaderId, { title: f.title, authors: f.authors, abstract: f.abstract, body });
  return redirect303(`/${id}`);
}

// ---------------------------------------------------------------------------------------------
// maintainer removal (form on /review)

async function removePost(env: Env, req: Request): Promise<Response> {
  const a = await requireUser(env, req, { role: "maintainer" });
  if (isAuthFailure(a)) return messagePage(env, 403, "Maintainers only", html`<p>Removing manuscripts is for maintainers.</p>`, NO_STORE);
  const form = await req.formData();
  const id = String(form.get("id") ?? "").trim().replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "");
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE manuscripts SET removed_at = ?2, removed_by = ?3 WHERE id = ?1 AND removed_at IS NULL").bind(id, new Date().toISOString(), a.user.id),
    env.DB.prepare("UPDATE manuscript_versions SET body = NULL, abstract = '', title = '(removed)' WHERE manuscript_id = ?1 AND EXISTS (SELECT 1 FROM manuscripts WHERE id = ?1 AND removed_by = ?2)").bind(id, a.user.id),
  ]);
  const ok = (r[0].meta.changes ?? 0) > 0;
  return messagePage(env, ok ? 200 : 404, ok ? "Removed" : "Not found", ok ? html`<p>Original manuscript ${id} was removed.</p>` : html`<p>No original manuscript ${id} to remove.</p>`, NO_STORE);
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
    <li><strong>Report problems</strong> through the <a href="/#contact">contact form</a>. We may share information when the law requires it.</li>
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
  if (path === "/manuscripts/format") return formatGuidePage(env);
  if (path === "/manuscripts/template.md") return templateMd();
  const pm = PROFILE_RE.exec(path);
  if (pm) return profilePage(env, pm[1]);
  const mm = MS_RE.exec(path)!;
  const id = `${mm[1]}/${Number(mm[2])}`;
  const want = `/${id}${mm[3] ?? ""}`;
  if (path !== want) return new Response(null, { status: 301, headers: { location: want + url.search } });
  return mm[3] ? manuscriptFile(env, req, url, id) : manuscriptPage(env, url, id);
}
