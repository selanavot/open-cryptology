// Comments on ePrint paper pages and original manuscripts (table: the "comments" section of
// db/schema.sql). One table for both: a comment's target is a paper id ('2024/123') or a
// manuscript id ('2026-11-15/3').
//
// Bodies are plain text, like abstracts: paragraphs and line breaks are kept, URLs become links,
// and $TeX$ is typeset by KaTeX in the browser. Replies nest (shown up to MAX_DEPTH levels).
//
// Who may do what (checked here; the page only hides controls):
//   comment, reply      anyone logged in, or their agent (DAILY a day)
//   edit a comment      its author, or their agent (earlier text isn't kept)
//   delete a comment    its author (the text is erased); people only, not agents
//   hide a comment      maintainers (the text is kept, as a record)
//
// Pages are publicly cached, so they render the public view only; the forms and buttons are in
// the HTML but hidden, and app.js reveals them from the oc_login cookie and /api/me.
import type { Env } from "./db";
import { canonicalId } from "./db";
import { html, raw, safeUrl, type Html } from "./html";
import { avatar } from "./account";
import { isAuthFailure, publicUsers, requireUser, type User } from "./auth";
import { err, json, tokenActor } from "./agentapi";
import { siteOrigin } from "./seo";
import { day } from "./pages";

export const MAX_BODY = 10_000;
const DAILY = 200; // comments per account per 24 hours; lower it if there is abuse
const MS_TARGET = /^\d{4}-\d{2}-\d{2}\/\d+$/;

interface Row {
  id: number;
  target: string;
  user_id: string;
  reply_to: number | null;
  body: string;
  state: "visible" | "deleted" | "hidden";
  created_at: string;
  edited_at: string | null;
}
type Person = User & { deleted: boolean };

export interface Thread {
  target: string;
  /** The manuscript's uploader (their current account), shown as OP; null on ePrint papers. */
  uploader: string | null;
  rows: Row[];
  people: Map<string, Person>;
}

/** Everything on one page, with the people who wrote it. */
export async function loadThread(env: Env, target: string): Promise<Thread> {
  const r = await env.DB.prepare("SELECT * FROM comments WHERE target = ?1 ORDER BY created_at, id").bind(target).all<Row>();
  const t = await targetInfo(env, target);
  return { target, uploader: t?.uploader ?? null, rows: r.results, people: await publicUsers(env, r.results.map((x) => x.user_id)) };
}

/** Whether `target` is a page that takes comments, and who uploaded it (manuscripts). */
async function targetInfo(env: Env, target: string): Promise<{ uploader: string | null } | null> {
  if (!MS_TARGET.test(target)) return (await env.DB.prepare("SELECT 1 FROM papers WHERE id = ?1").bind(target).first()) ? { uploader: null } : null;
  const m = await env.DB.prepare(
    "SELECT COALESCE(u.merged_into, u.id) AS uploader FROM manuscripts m JOIN users u ON u.id = m.uploader_id WHERE m.id = ?1 AND m.removed_at IS NULL",
  )
    .bind(target)
    .first<{ uploader: string }>();
  return m ? { uploader: m.uploader } : null;
}

/** Comments with TeX in them (so a page knows to load KaTeX). */
export const threadHasTex = (t: Thread): boolean => t.rows.some((r) => r.state === "visible" && /\$|\\\(|\\\[/.test(r.body));

// ---------------------------------------------------------------------------------------------
// actions, shared by the page forms and the agent API

type Fail = { error: keyof typeof ERRORS };
const ERRORS = {
  empty: [400, "Write something first."],
  too_long: [400, `Comments are up to ${MAX_BODY.toLocaleString("en")} characters.`],
  rate: [429, `That's ${DAILY} comments in 24 hours, the most one account can post. Try again tomorrow.`],
  not_found: [404, "No such comment, or no such page."],
  bad_reply: [400, "reply_to must be a visible comment on the same page."],
  not_yours: [403, "Only its author can edit or delete a comment."],
  maintainers: [403, "Only maintainers can do that."],
  removed: [409, "That comment was deleted or hidden."],
} as const;

const cleanBody = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "");

function checkBody(s: string): string | Fail {
  const body = cleanBody(s);
  if (!body) return { error: "empty" };
  if (body.length > MAX_BODY) return { error: "too_long" };
  return body;
}

async function addComment(
  env: Env,
  user: User,
  target: string,
  f: { body: string; replyTo: number | null; tokenId?: string },
): Promise<{ id: number } | Fail> {
  const body = checkBody(f.body);
  if (typeof body !== "string") return body;
  if (!(await targetInfo(env, target))) return { error: "not_found" };
  if (f.replyTo) {
    const p = await env.DB.prepare("SELECT target, state FROM comments WHERE id = ?1").bind(f.replyTo).first<{ target: string; state: string }>();
    if (!p || p.target !== target || p.state !== "visible") return { error: "bad_reply" };
  }
  const now = new Date();
  // The daily limit is checked in the same statement as the insert.
  const r = await env.DB.prepare(
    `INSERT INTO comments (target, user_id, reply_to, body, token_id, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT count(*) FROM comments WHERE user_id = ?2 AND created_at > ?7) < ?8
     RETURNING id`,
  )
    .bind(target, user.id, f.replyTo, body, f.tokenId ?? null, now.toISOString(), new Date(now.getTime() - 86400_000).toISOString(), DAILY)
    .first<{ id: number }>();
  return r ? { id: r.id } : { error: "rate" };
}

/** A comment with its author's current account (after merges). */
async function getComment(env: Env, id: number): Promise<(Row & { owner: string }) | null> {
  return env.DB.prepare("SELECT c.*, COALESCE(u.merged_into, u.id) AS owner FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?1")
    .bind(id)
    .first<Row & { owner: string }>();
}

async function editComment(env: Env, user: User, c: Row & { owner: string }, text: string): Promise<null | Fail> {
  if (c.owner !== user.id) return { error: "not_yours" };
  if (c.state !== "visible") return { error: "removed" };
  const body = checkBody(text);
  if (typeof body !== "string") return body;
  if (body !== c.body) await env.DB.prepare("UPDATE comments SET body = ?2, edited_at = ?3 WHERE id = ?1").bind(c.id, body, new Date().toISOString()).run();
  return null;
}

/** Delete your own (the text is erased) or, for maintainers, hide (the text is kept). */
async function removeComment(env: Env, user: User, c: Row & { owner: string }, how: "delete" | "hide"): Promise<null | Fail> {
  if (how === "delete" && c.owner !== user.id) return { error: "not_yours" };
  if (how === "hide" && user.role !== "maintainer") return { error: "maintainers" };
  if (c.state !== "visible") return null;
  await env.DB.prepare(`UPDATE comments SET state = ?2, moderated_by = ?3${how === "delete" ? ", body = ''" : ""} WHERE id = ?1`)
    .bind(c.id, how === "delete" ? "deleted" : "hidden", user.id)
    .run();
  return null;
}

// ---------------------------------------------------------------------------------------------
// the section on paper and manuscript pages: a composer, then the thread (Reddit-like)

/** The log-in pop-up's heading (app.js, data-login) when a signed-out reader starts to comment. */
const LOGIN_HEADING = "Log in or create an account to comment";

/** Replies indent up to this depth; deeper ones line up under it. */
const MAX_DEPTH = 6;

/** Plain text with links: the browser typesets $TeX$ (class "tex"); white-space keeps the lines.
 *  Link text is the URL itself, so the element's textContent is the stored body (app.js edits it). */
function bodyHtml(s: string): Html {
  const out: Html[] = [];
  let last = 0;
  for (const m of s.matchAll(/\bhttps?:\/\/[^\s<>"]+/g)) {
    const u = m[0].replace(/[.,;:!?'")\]]+$/, "");
    const href = safeUrl(u);
    if (!href) continue;
    out.push(html`${s.slice(last, m.index)}<a href="${href}" rel="nofollow ugc noopener">${u}</a>`);
    last = m.index + u.length;
  }
  out.push(html`${s.slice(last)}`);
  return html`${out}`;
}

const svg = (d: string) =>
  raw(`<svg class="cm-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
const ICON = {
  reply: svg("M3.5 4.5h13v9h-7l-4 3v-3h-2z"),
  share: svg("M10 3v10M6 7l4-4 4 4M4 11v5h12v-5"),
  more: raw(`<svg class="cm-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="4.5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15.5" cy="10" r="1.6" fill="currentColor"/></svg>`),
  plus: svg("M10 5v10M5 10h10"),
};

/** The comment box: top of the section, and (cloned by app.js) for replies and edits. */
function composer(action: string, o: { submit: string; replyTo?: number; value?: string; id: string }): Html {
  return html`<form class="cm-composer" method="post" action="${action}">
  ${o.replyTo !== undefined ? html`<input type="hidden" name="reply_to" value="${o.replyTo || ""}">` : ""}
  <textarea id="${o.id}" name="body" rows="3" maxlength="${MAX_BODY}" required placeholder="Add a comment" aria-label="${o.submit === "Save" ? "Edit comment" : "Add a comment"}">${o.value ?? ""}</textarea>
  <div class="cm-preview comment-body tex" hidden></div>
  <div class="cm-bar">
    <button type="button" class="cm-tool" data-preview aria-pressed="false">Preview</button>
    <span class="cm-spacer"></span>
    <button type="button" class="cm-cancel">Cancel</button>
    <button type="submit" class="cm-submit">${o.submit}</button>
  </div>
</form>`;
}

function flairs(t: Thread, p: Person): Html {
  // The maintainer role works (remove) but isn't shown: no public mods for now.
  return html`${p.id === t.uploader ? html`<span class="cm-flair cm-flair-op" title="Uploaded this manuscript">OP</span>` : ""}`;
}

function commentHtml(t: Thread, c: Row, kids: Map<number, Row[]>, keep: Set<number>, depth: number): Html[] {
  const children = (kids.get(c.id) ?? []).filter((x) => keep.has(x.id));
  const nested = depth < MAX_DEPTH;
  const childHtml = children.flatMap((x) => commentHtml(t, x, kids, keep, nested ? depth + 1 : depth));
  const line = children.length && nested ? html`<button type="button" class="cm-line" aria-label="Collapse thread"></button>` : "";
  const tail: Html[] = nested ? [] : childHtml;
  const inner = nested && childHtml.length ? html`<div class="cm-children">${childHtml}</div>` : "";
  const time = html`<a class="cm-time" href="#comment-${c.id}"><time datetime="${c.created_at}">${day(c.created_at)}</time></a>`;

  if (c.state === "hidden") {
    return [
      html`<article class="cm cm-gone" id="comment-${c.id}">
  <div class="cm-gutter"><span class="avatar avatar-xs cm-avatar-gone" aria-hidden="true"></span>${line}</div>
  <div class="cm-content">
    <div class="cm-head">${time}</div>
    <div class="cm-body cm-body-gone">Comment removed</div>
    ${inner}
  </div>
</article>`,
      ...tail,
    ];
  }
  const p = t.people.get(c.user_id);
  const live = p && !p.deleted ? p : null;
  const owner = live?.id ?? c.user_id;
  const login = `/account?next=${encodeURIComponent(`/${t.target}#comment-${c.id}`)}`;
  const deleted = c.state === "deleted";
  return [
    html`<article class="cm${deleted ? " cm-deleted" : ""}" id="comment-${c.id}"${deleted ? "" : html` data-owner="${owner}"`}>
  <div class="cm-gutter">
    ${live ? html`<a class="cm-avatar" href="/u/${live.id}" tabindex="-1">${avatar(live, "avatar-xs")}</a>` : html`<span class="avatar avatar-xs cm-avatar-gone" aria-hidden="true"></span>`}
    <button type="button" class="cm-expand" aria-label="Expand thread" hidden>${ICON.plus}</button>
    ${line}
  </div>
  <div class="cm-content">
    <div class="cm-head">${live ? html`<a class="cm-name" href="/u/${live.id}">${live.displayName}</a>${flairs(t, live)}` : html`<span class="cm-name cm-name-gone">deleted user</span>`}<span class="cm-dot">·</span>${time}${c.edited_at && !deleted ? html`<span class="cm-dot">·</span><span class="cm-edited" title="${day(c.edited_at)}">edited</span>` : ""}</div>
    ${deleted ? html`<div class="cm-body cm-body-gone">Comment deleted</div>` : html`<div class="cm-body tex">${bodyHtml(c.body)}</div>
    <div class="cm-actions">
      <a class="cm-act" href="${login}" rel="nofollow" data-reply="${c.id}" data-login="${LOGIN_HEADING}">${ICON.reply}<span>Reply</span></a>
      <button type="button" class="cm-act" data-share>${ICON.share}<span>Share</span></button>
      <details class="cm-menu" hidden>
        <summary class="cm-act" aria-label="More options">${ICON.more}</summary>
        <div class="cm-menu-list">
          <button type="button" class="cm-menu-item" data-edit data-can="own" hidden>Edit</button>
          <form method="post" action="/comments/${c.id}/delete" data-can="own" hidden><button class="cm-menu-item" type="submit">Delete</button></form>
          <form method="post" action="/comments/${c.id}/hide" data-can="moderate" hidden><button class="cm-menu-item" type="submit">Remove</button></form>
        </div>
      </details>
    </div>`}
    ${inner}
  </div>
</article>`,
    ...tail,
  ];
}

/** After a redirect, errors only; success just shows the comment. */
const PAGE_ERRORS: Record<string, string> = {
  origin: "Couldn’t post that. Try again.",
  empty: "Comment can’t be empty.",
  too_long: `Comments are limited to ${MAX_BODY.toLocaleString("en")} characters.`,
  rate: "You’ve reached today’s comment limit.",
  not_found: "That comment no longer exists.",
  bad_reply: "That comment no longer exists.",
  removed: "That comment was deleted.",
  not_yours: "You can’t do that.",
  maintainers: "You can’t do that.",
};

/** The comments section of a paper or manuscript page. */
export function commentsSection(t: Thread, url: URL): Html {
  const error = PAGE_ERRORS[url.searchParams.get("comment") ?? ""];
  const shown = (c: Row) => c.state === "visible";
  const byId = new Map(t.rows.map((c) => [c.id, c]));
  const kids = new Map<number, Row[]>();
  for (const c of t.rows) if (c.reply_to != null) kids.set(c.reply_to, [...(kids.get(c.reply_to) ?? []), c]);
  // Visible and deleted comments (shown with their author), and removed ones that still hold replies.
  const keep = new Set<number>();
  for (const c of t.rows.filter((x) => x.state !== "hidden")) {
    for (let x: Row | undefined = c; x && !keep.has(x.id); x = x.reply_to != null ? byId.get(x.reply_to) : undefined) keep.add(x.id);
  }
  const top = t.rows.filter((c) => c.reply_to == null && keep.has(c.id));
  const count = t.rows.filter(shown).length;
  return html`<section id="comments" class="cm-section" data-login-heading="${LOGIN_HEADING}">
  <h2 class="cm-title">Comments${count ? html` <span class="cm-count">${count}</span>` : ""}</h2>
  ${error && html`<div class="cm-error" role="alert">${error}</div>`}
  ${composer(`/${t.target}/comments`, { submit: "Comment", id: "comment-new" })}
  <template id="cm-reply-template">${composer(`/${t.target}/comments`, { submit: "Reply", replyTo: 0, id: "" })}</template>
  <div class="cm-thread">${top.flatMap((c) => commentHtml(t, c, kids, keep, 1))}</div>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// routes: page forms (POST, then back to the page) and the agent API (JSON)

const PAGE_TARGET = String.raw`(\d{4})\/(\d{1,6})|(\d{4}-\d{2}-\d{2})\/(\d{1,4})`;
const FORM_NEW_RE = new RegExp(`^\\/(?:${PAGE_TARGET})\\/comments$`);
const FORM_ACT_RE = /^\/comments\/(\d+)\/(edit|delete|hide)$/;
const API_LIST_RE = new RegExp(`^\\/api\\/(?:papers\\/(\\d{4})\\/(\\d{1,6})|manuscripts\\/(\\d{4}-\\d{2}-\\d{2})\\/(\\d{1,4}))\\/comments\\/?$`);
const API_ONE_RE = /^\/api\/comments\/(\d+)\/?$/;

const targetFrom = (m: RegExpExecArray): string => (m[1] ? canonicalId(Number(m[1]), Number(m[2])) : `${m[3]}/${Number(m[4])}`);

export const isCommentsPath = (path: string): boolean =>
  FORM_NEW_RE.test(path) || FORM_ACT_RE.test(path) || API_LIST_RE.test(path) || API_ONE_RE.test(path);

export async function handleComments(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const isApi = path.startsWith("/api/");
  try {
    return isApi ? await api(req, env, url) : await form(req, env, path);
  } catch (e) {
    if (!isApi) throw e;
    console.error("comments API", path, e);
    return err(500, "server_error", "Something went wrong on our side. Try again in a minute; if it keeps happening, tell the person.");
  }
}

const back = (target: string, code: string, hash = "comments") =>
  new Response(null, { status: 303, headers: { location: `/${target}?comment=${code}#${hash}`, "cache-control": "no-store" } });

async function form(req: Request, env: Env, path: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Use the form on the page.\n", { status: 405, headers: { allow: "POST" } });
  const f = await req.formData().catch(() => new FormData());
  const field = (k: string) => String(f.get(k) ?? "");
  const nm = FORM_NEW_RE.exec(path);
  const am = FORM_ACT_RE.exec(path);
  const c = am ? await getComment(env, Number(am[1])) : null;
  const target = nm ? targetFrom(nm) : c?.target;
  if (!target) return new Response("No such comment.\n", { status: 404 });
  const a = await requireUser(env, req);
  if (isAuthFailure(a))
    return a.code === "signin"
      ? new Response(null, { status: 303, headers: { location: `/account?next=${encodeURIComponent(`/${target}#comments`)}`, "cache-control": "no-store" } })
      : back(target, a.code);
  if (nm) {
    const r = await addComment(env, a.user, target, { body: field("body"), replyTo: Number(field("reply_to")) || null });
    return "error" in r ? back(target, r.error) : back(target, "posted", `comment-${r.id}`);
  }
  const action = am![2];
  const r = action === "edit" ? await editComment(env, a.user, c!, field("body")) : await removeComment(env, a.user, c!, action as "delete" | "hide");
  const done = { edit: "edited", delete: "deleted", hide: "hidden" }[action]!;
  return r ? back(target, r.error, `comment-${c!.id}`) : back(target, done, `comment-${c!.id}`);
}

const fail = (f: Fail) => err(ERRORS[f.error][0], f.error, ERRORS[f.error][1]);

function personJson(origin: string, p: Person | undefined) {
  return p && !p.deleted ? { name: p.displayName, profile_url: `${origin}/u/${p.id}` } : { name: "deleted user" };
}

function commentJson(origin: string, t: Thread, c: Row) {
  const base = { id: c.id, url: `${origin}/${c.target}#comment-${c.id}`, reply_to: c.reply_to };
  if (c.state === "hidden") return { ...base, removed: true };
  const p = t.people.get(c.user_id);
  if (c.state === "deleted") return { ...base, author: { ...personJson(origin, p), uploader: !!p && p.id === t.uploader }, deleted: true, created_at: c.created_at };
  return {
    ...base,
    author: { ...personJson(origin, p), uploader: !!p && p.id === t.uploader },
    body: c.body,
    created_at: c.created_at,
    edited_at: c.edited_at,
  };
}

/** The page's comments as JSON: visible and deleted ones (deleted: true, no body), plus {removed: true}
 *  for ones a maintainer removed that still hold replies. */
function threadJson(origin: string, t: Thread) {
  const byId = new Map(t.rows.map((c) => [c.id, c]));
  const keep = new Set<number>();
  for (const c of t.rows.filter((x) => x.state !== "hidden")) {
    for (let x: Row | undefined = c; x && !keep.has(x.id); x = x.reply_to != null ? byId.get(x.reply_to) : undefined) keep.add(x.id);
  }
  return {
    target: t.target,
    url: `${origin}/${t.target}#comments`,
    comments: t.rows.filter((c) => keep.has(c.id)).map((c) => commentJson(origin, t, c)),
  };
}

/** A JSON body as an object ({} if it isn't one). Form-encoded bodies work too. */
async function readFields(req: Request): Promise<Record<string, unknown>> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("form")) return Object.fromEntries((await req.formData()).entries());
    const o = JSON.parse(await req.text());
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = siteOrigin(env, url);
  const isGet = req.method === "GET" || req.method === "HEAD";
  const pub = { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" };
  const lm = API_LIST_RE.exec(url.pathname);
  if (lm) {
    const target = targetFrom(lm);
    if (isGet) {
      if (!(await targetInfo(env, target))) return fail({ error: "not_found" });
      return json(threadJson(origin, await loadThread(env, target)), 200, pub);
    }
    if (req.method !== "POST") return err(405, "method_not_allowed", "GET lists the comments; POST adds one.");
    const who = await tokenActor(env, req, origin, "comments");
    if (who instanceof Response) return who;
    const f = await readFields(req);
    const r = await addComment(env, who.user, target, {
      body: typeof f.body === "string" ? f.body : "",
      replyTo: Number(f.reply_to) || null,
      tokenId: who.token.id,
    });
    if ("error" in r) return fail(r);
    const t = await loadThread(env, target);
    return json(commentJson(origin, t, t.rows.find((x) => x.id === r.id)!), 201, { location: `${origin}/${target}#comment-${r.id}` });
  }
  const id = Number(API_ONE_RE.exec(url.pathname)![1]);
  const c = await getComment(env, id);
  if (!c) return fail({ error: "not_found" });
  if (isGet) {
    const t = await loadThread(env, c.target);
    return json(commentJson(origin, t, t.rows.find((x) => x.id === id)!), 200, pub);
  }
  if (req.method !== "PATCH") return err(405, "method_not_allowed", "GET reads a comment; PATCH edits it.");
  const who = await tokenActor(env, req, origin, "comments");
  if (who instanceof Response) return who;
  const f = await readFields(req);
  if (f.body === undefined) return err(400, "nothing_to_do", 'Send {"body": "..."} with the new text.');
  const r = await editComment(env, who.user, c, typeof f.body === "string" ? f.body : "");
  if (r) return fail(r);
  const t = await loadThread(env, c.target);
  return json(commentJson(origin, t, t.rows.find((x) => x.id === id)!));
}
