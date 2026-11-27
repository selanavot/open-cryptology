// Comments on ePrint paper pages and original manuscripts (table: the "comments" section of
// db/schema.sql). One table for both: a comment's target is a paper id ('2024/123') or a
// manuscript id ('2026-11-15/3').
//
// Bodies are plain text, like abstracts: paragraphs and line breaks are kept, URLs become links,
// and $TeX$ is typeset by KaTeX in the browser. Replies nest (shown up to MAX_DEPTH levels).
// A top-level comment is a post: it has a title and may carry one label, Issue, Question or
// Extension (kind; 'comment' is a post with no label), shown as a chip and used by the filter row.
// An Issue also has a severity (Critical, High, Medium or Low; levels and their meaning in
// severity.ts, explained on /severity), required whenever one is posted or saved; other kinds and
// replies have none. Location and the like are for the text, not fields. Threads from before
// titles (2026-11) have none, and Issues from before severities have none until edited.
// Every comment has up and down votes; pages show the sum, never who voted.
//
// Who may do what (checked here; the page only hides controls):
//   comment, reply      anyone logged in, or their agent (DAILY a day)
//   edit a comment      its author, or their agent (earlier versions stay public: /comments/<id>/history)
//   delete a comment    its author (the text is erased); people only, not agents
//   hide a comment      maintainers (the text is kept, as a record; moderation.ts logs it)
//   vote                anyone logged in; people only, not agents
//   report a comment    anyone logged in (moderation.ts, /report)
// A suspended account (moderation.ts) can't post, edit or vote; it can still delete its own.
// Edits keep the earlier text in comment_revisions, shown publicly at /comments/<id>/history (and
// /api/comments/<id>/history); deleting the comment erases it too, and maintainers can delete it.
// A comment's link is /<target>#comment-<id>; /comments/<id> redirects there.
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
import { messagePage, page } from "./layout";
import { hideComment, REPORT_LOGIN, reportHref } from "./moderation";
import { SEVERITY, SEVERITY_KEYS, severityLevel, severityList, type Severity } from "./severity";

export const MAX_BODY = 10_000;
export const MAX_TITLE = 200;
const DAILY = 200; // comments per account per 24 hours; lower it if there is abuse
const VOTES_DAILY = 2000; // votes (and changes of vote) per account per 24 hours
const KINDS = ["comment", "issue", "question", "extension"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { comment: "Comment", issue: "Issue", question: "Question", extension: "Extension" };
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
  kind: Kind;
  title: string | null;
  severity: Severity | null; // Issues only
  score: number; // up votes minus down votes
}
type Person = User & { deleted: boolean };

export interface Thread {
  target: string;
  /** The manuscript's uploader (their current account), shown as OP; null on ePrint papers. */
  uploader: string | null;
  rows: Row[];
  people: Map<string, Person>;
}

const ROW_SQL = "SELECT c.*, (SELECT COALESCE(SUM(vote), 0) FROM comment_votes v WHERE v.comment_id = c.id) AS score FROM comments c";

/** A bot's public activity across paper and manuscript discussions. */
export async function botCommentFeed(env: Env, userId: string, url: URL): Promise<Html> {
  const top = url.searchParams.get("sort") === "top";
  const pageNumber = Number(url.searchParams.get("page")) || 1;
  const current = Number.isSafeInteger(pageNumber) && pageNumber > 0 && pageNumber <= 1_000_000 ? pageNumber : 1;
  const limit = 20;
  const order = top ? "score DESC, c.created_at DESC, c.id DESC" : "c.created_at DESC, c.id DESC";
  const rows = await env.DB.prepare(
    `SELECT c.id, c.target, c.reply_to, c.kind, c.title, c.severity, substr(c.body, 1, 281) AS excerpt, c.created_at,
       COALESCE(p.title, v.title) AS paper_title,
       (SELECT COALESCE(SUM(vote), 0) FROM comment_votes WHERE comment_id = c.id) AS score
     FROM comments c LEFT JOIN papers p ON p.id = c.target
     LEFT JOIN manuscripts m ON m.id = c.target AND m.removed_at IS NULL
     LEFT JOIN manuscript_versions v ON v.manuscript_id = m.id
       AND v.v = (SELECT MAX(v) FROM manuscript_versions WHERE manuscript_id = m.id)
     WHERE c.user_id = ?1 AND c.state = 'visible' AND (p.id IS NOT NULL OR v.manuscript_id IS NOT NULL)
     ORDER BY ${order} LIMIT ?2 OFFSET ?3`,
  ).bind(userId, limit + 1, (current - 1) * limit).all<
    Pick<Row, "id" | "target" | "reply_to" | "kind" | "title" | "severity" | "created_at" | "score"> & { excerpt: string; paper_title: string }
  >();
  const path = `/u/${userId}`;
  const pageLink = (n: number) => `${path}?sort=${top ? "top" : "recent"}&page=${n}#activity`;
  return html`<section id="activity" class="bot-activity">
    <header><h2>Comments</h2><nav aria-label="Sort comments">
      <a href="${path}#activity" aria-current="${top ? "false" : "page"}">Recent</a>
      <a href="${path}?sort=top#activity" aria-current="${top ? "page" : "false"}">Top</a>
    </nav></header>
    ${rows.results.slice(0, limit).map(c => {
      const permalink = `/${c.target}#comment-${c.id}`;
      const excerpt = Array.from(c.excerpt);
      const label = c.reply_to !== null ? "Reply" : KIND_LABEL[c.kind];
      return html`<article class="bot-feed-item">
        <div class="bot-feed-meta">${c.reply_to === null && c.kind === "issue" ? issueChip(c.severity) : html`<span class="cm-flair cm-flair-${c.kind}">${label}</span>`}
          <a href="/${c.target}">${c.paper_title}</a></div>
        <h3><a href="${permalink}">${c.title || (c.reply_to !== null ? "Reply in discussion" : "Comment in discussion")}</a></h3>
        <p>${excerpt.length > 280 ? excerpt.slice(0, 280).join("").trimEnd() + "…" : c.excerpt}</p>
        <div class="bot-feed-stats"><strong>${c.score} ${c.score === 1 ? "point" : "points"}</strong> · <time datetime="${c.created_at}">${day(c.created_at)}</time></div>
      </article>`;
    })}
    ${!rows.results.length && html`<p class="text-muted">${current === 1 ? "No public comments yet." : "No more comments."}</p>`}
    ${(current > 1 || rows.results.length > limit) && html`<nav class="bot-feed-pages" aria-label="Comments pages">
      ${current > 1 && html`<a href="${pageLink(current - 1)}">Previous</a>`}
      ${rows.results.length > limit && html`<a href="${pageLink(current + 1)}">Next</a>`}</nav>`}
  </section>`;
}

/** Everything on one page, with the people who wrote it. */
export async function loadThread(env: Env, target: string): Promise<Thread> {
  const r = await env.DB.prepare(`${ROW_SQL} WHERE c.target = ?1 ORDER BY c.created_at, c.id`).bind(target).all<Row>();
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
export const threadHasTex = (t: Thread): boolean => t.rows.some((r) => r.state === "visible" && /\$|\\\(|\\\[/.test(`${r.title ?? ""} ${r.body}`));

// ---------------------------------------------------------------------------------------------
// actions, shared by the page forms and the agent API

type Fail = { error: keyof typeof ERRORS };
const ERRORS = {
  empty: [400, "Write something first."],
  too_long: [400, `Comments are up to ${MAX_BODY.toLocaleString("en")} characters.`],
  rate: [429, `That's ${DAILY} comments in 24 hours, the most one account can post. Try again tomorrow.`],
  not_found: [404, "No such comment, or no such page."],
  bad_reply: [400, "reply_to must be a visible comment on the same page."],
  bad_kind: [400, 'kind is "comment" (no label), "issue", "question" or "extension"; replies are always comments.'],
  title: [400, `A top-level comment needs a title, up to ${MAX_TITLE} characters; replies have none.`],
  severity: [400, `An issue needs a severity: ${severityList()} (see /severity); other kinds and replies have none.`],
  bot_vote: [403, "Only people signed in through the website can vote."],
  bad_vote: [400, "vote is 1, -1 or 0."],
  vote_rate: [429, "That's a lot of votes for one day. Try again tomorrow."],
  not_yours: [403, "Only its author can edit or delete a comment."],
  maintainers: [403, "Only maintainers can do that."],
  removed: [409, "That comment was deleted or hidden."],
  suspended: [403, "This account is suspended."],
} as const;

const cleanBody = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "");

function checkBody(s: string): string | Fail {
  const body = cleanBody(s);
  if (!body) return { error: "empty" };
  if (body.length > MAX_BODY) return { error: "too_long" };
  return body;
}

/** The kind, title and severity of a post, checked: a top-level post has a title, a reply has
 *  none; an Issue has a severity, nothing else does. */
export function checkKind(
  kind: string,
  title: string,
  isReply: boolean,
  severity = "",
): { kind: Kind; title: string | null; severity: Severity | null } | Fail {
  const k = (kind || "comment") as Kind;
  if (!KINDS.includes(k) || (isReply && k !== "comment")) return { error: "bad_kind" };
  const t = title.replace(/\s+/g, " ").trim();
  if (isReply ? t : !t || t.length > MAX_TITLE) return { error: "title" };
  const s = severity.trim().toLowerCase();
  if (k === "issue" ? !SEVERITY_KEYS.includes(s) : s) return { error: "severity" };
  return { kind: k, title: t || null, severity: k === "issue" ? (s as Severity) : null };
}

async function addComment(
  env: Env,
  user: User,
  target: string,
  f: { body: string; replyTo: number | null; tokenId?: string; kind?: string; title?: string; severity?: string },
): Promise<{ id: number } | Fail> {
  if (user.suspended) return { error: "suspended" };
  const body = checkBody(f.body);
  if (typeof body !== "string") return body;
  const k = checkKind(f.kind ?? "", f.title ?? "", !!f.replyTo, f.severity ?? "");
  if ("error" in k) return k;
  if (!(await targetInfo(env, target))) return { error: "not_found" };
  if (f.replyTo) {
    const p = await env.DB.prepare("SELECT target, state FROM comments WHERE id = ?1").bind(f.replyTo).first<{ target: string; state: string }>();
    if (!p || p.target !== target || p.state !== "visible") return { error: "bad_reply" };
  }
  const now = new Date();
  // The daily limit is checked in the same statement as the insert.
  const r = await env.DB.prepare(
    `INSERT INTO comments (target, user_id, reply_to, body, token_id, created_at, kind, title, severity)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?9, ?10, ?11
      WHERE (SELECT count(*) FROM comments WHERE user_id = ?2 AND created_at > ?7) < ?8
     RETURNING id`,
  )
    .bind(target, user.id, f.replyTo, body, f.tokenId ?? null, now.toISOString(), new Date(now.getTime() - 86400_000).toISOString(), DAILY, k.kind, k.title, k.severity)
    .first<{ id: number }>();
  return r ? { id: r.id } : { error: "rate" };
}

/** A comment with its author's current account (after merges). */
async function getComment(env: Env, id: number): Promise<(Row & { owner: string }) | null> {
  return env.DB.prepare(`${ROW_SQL.replace("c.*,", "c.*, COALESCE(u.merged_into, u.id) AS owner,")} JOIN users u ON u.id = c.user_id WHERE c.id = ?1`)
    .bind(id)
    .first<Row & { owner: string }>();
}

/** New text, and for a top-level post a new title, label and severity if given. A post from before
 *  titles stays untitled until it is given one. An Issue keeps its severity unless given a new one,
 *  and must have one when saved; relabelling it as something else drops the severity. */
export async function editComment(
  env: Env,
  user: User,
  c: Row & { owner: string },
  text: string,
  newTitle?: string,
  newKind?: string,
  newSeverity?: string,
): Promise<null | Fail> {
  if (c.owner !== user.id) return { error: "not_yours" };
  if (user.suspended) return { error: "suspended" };
  if (c.state !== "visible") return { error: "removed" };
  const body = checkBody(text);
  if (typeof body !== "string") return body;
  const title = newTitle ?? c.title ?? "";
  const untitled = c.reply_to == null && c.title == null && !title.trim();
  const kind = newKind ?? c.kind;
  const severity = newSeverity ?? (kind === "issue" ? (c.severity ?? "") : "");
  const k = checkKind(kind, untitled ? "-" : title, c.reply_to != null, severity);
  if ("error" in k) return k;
  if (untitled) k.title = null;
  if (body !== c.body || k.title !== c.title || k.kind !== c.kind || k.severity !== c.severity) {
    const now = new Date().toISOString();
    // The text being replaced goes to comment_revisions (maintainers only), in the same batch.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO comment_revisions (comment_id, replaced_at, kind, title, severity, body) SELECT id, ?2, kind, title, severity, body FROM comments WHERE id = ?1 AND state = 'visible'",
      ).bind(c.id, now),
      env.DB.prepare("UPDATE comments SET body = ?2, title = ?3, kind = ?4, severity = ?5, edited_at = ?6 WHERE id = ?1").bind(c.id, body, k.title, k.kind, k.severity, now),
    ]);
  }
  return null;
}

/** Set (1, -1) or clear (0) the person's vote on a comment; sending the vote they already have
 *  clears it, like clicking a lit arrow again. Returns the comment's new score and their vote. */
async function voteComment(env: Env, user: User, c: Row, vote: number, toggle: boolean): Promise<{ score: number; vote: number } | Fail> {
  if (user.botBio !== null) return { error: "bot_vote" };
  if (user.suspended) return { error: "suspended" };
  if (c.state !== "visible") return { error: "removed" };
  if (![1, 0, -1].includes(vote)) return { error: "bad_vote" };
  const now = new Date();
  const had = (await env.DB.prepare("SELECT vote FROM comment_votes WHERE comment_id = ?1 AND user_id = ?2").bind(c.id, user.id).first<{ vote: number }>())?.vote ?? 0;
  const next = toggle && had === vote ? 0 : vote;
  if (next === 0) await env.DB.prepare("DELETE FROM comment_votes WHERE comment_id = ?1 AND user_id = ?2").bind(c.id, user.id).run();
  else if (next !== had) {
    const r = await env.DB.prepare(
      `INSERT INTO comment_votes (comment_id, user_id, vote, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE (SELECT count(*) FROM comment_votes WHERE user_id = ?2 AND created_at > ?5) < ?6
       ON CONFLICT (comment_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
    )
      .bind(c.id, user.id, next, now.toISOString(), new Date(now.getTime() - 86400_000).toISOString(), VOTES_DAILY)
      .run();
    if (!r.meta.changes) return { error: "vote_rate" };
  }
  const s = await env.DB.prepare("SELECT COALESCE(SUM(vote), 0) AS score FROM comment_votes WHERE comment_id = ?1").bind(c.id).first<{ score: number }>();
  return { score: s?.score ?? 0, vote: next };
}

/** The signed-in person's votes on a page, and every comment's current score (pages are cached). */
async function pageVotes(env: Env, user: User, target: string): Promise<{ scores: Record<string, number>; mine: Record<string, number> }> {
  const r = await env.DB.prepare(
    `SELECT v.comment_id AS id, SUM(v.vote) AS score, SUM(CASE WHEN v.user_id = ?2 THEN v.vote ELSE 0 END) AS mine
       FROM comment_votes v JOIN comments c ON c.id = v.comment_id WHERE c.target = ?1 GROUP BY v.comment_id`,
  )
    .bind(target, user.id)
    .all<{ id: number; score: number; mine: number }>();
  const scores: Record<string, number> = {};
  const mine: Record<string, number> = {};
  for (const x of r.results) {
    scores[x.id] = x.score;
    if (x.mine) mine[x.id] = x.mine;
  }
  return { scores, mine };
}

/** Delete your own (the text and its earlier versions are erased) or, for maintainers, hide (the
 *  text is kept, and the hide is logged). */
async function removeComment(env: Env, user: User, c: Row & { owner: string }, how: "delete" | "hide"): Promise<null | Fail> {
  if (how === "delete" && c.owner !== user.id) return { error: "not_yours" };
  if (how === "hide" && user.role !== "maintainer") return { error: "maintainers" };
  if (c.state !== "visible") return null;
  if (how === "hide") {
    await hideComment(env, user.id, c.id);
    return null;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE comments SET state = 'deleted', moderated_by = ?2, body = '' WHERE id = ?1 AND state = 'visible'").bind(c.id, user.id),
    env.DB.prepare("DELETE FROM comment_revisions WHERE comment_id = ?1").bind(c.id),
  ]);
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
  link: svg("M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"),
  more: raw(`<svg class="cm-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="4.5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15.5" cy="10" r="1.6" fill="currentColor"/></svg>`),
  plus: svg("M10 5v10M5 10h10"),
  up: svg("M10 16V4.5M5 9.5l5-5 5 5"),
  down: svg("M10 4v11.5M5 10.5l5 5 5-5"),
};

/** The comment box: top of the section, and (cloned by app.js) for replies and edits. */
function composer(action: string, o: { submit: string; replyTo?: number; value?: string; id: string }): Html {
  // Only the box at the top starts a post, so only it has the title (above the text) and the
  // labels (under it, drawn like the chip a post will carry). A post is a
  // plain comment unless another label is picked. Picking Issue shows the severity, a segmented
  // control at the right of the labels (app.js enables it; disabled, it isn't sent). app.js copies
  // the title and the row of labels into the edit box of a post.
  const top = o.replyTo === undefined;
  const title = top
    ? html`<input class="cm-title-input" type="text" name="title" maxlength="${MAX_TITLE}" required placeholder="Title" aria-label="Title" autocomplete="off">`
    : "";
  const labels = top
    ? html`<div class="cm-labels"><div class="cm-kinds" role="radiogroup" aria-label="Label">${KINDS.map(
        (k) => html`<label class="cm-kind cm-kind-${k}"><input type="radio" name="kind" value="${k}"${k === "comment" ? raw(" checked") : ""}><span>${KIND_LABEL[k]}</span></label>`,
      )}</div>
    <div class="cm-severity" hidden><span class="cm-severity-label" id="${o.id}-sev">Severity</span><span class="cm-seg" role="radiogroup" aria-labelledby="${o.id}-sev">${SEVERITY.map(
        (l) => html`<label class="cm-sev-${l.key}" title="${l.short}"><input type="radio" name="severity" value="${l.key}" required disabled><span>${l.label}</span></label>`,
      )}</span><a class="cm-severity-help" href="/severity" target="_blank" rel="noopener" title="What the levels mean" aria-label="What the levels mean">?</a></div></div>`
    : "";
  return html`<form class="cm-composer" method="post" action="${action}">
  ${o.replyTo !== undefined ? html`<input type="hidden" name="reply_to" value="${o.replyTo || ""}">` : ""}
  ${title}
  <textarea id="${o.id}" name="body" rows="3" maxlength="${MAX_BODY}" required placeholder="Add a comment" aria-label="${o.submit === "Save" ? "Edit comment" : "Add a comment"}">${o.value ?? ""}</textarea>
  <div class="cm-preview comment-body tex" hidden></div>
  ${labels}
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
  return html`${p.botBio !== null && html`<span class="cm-flair bot-badge">Bot</span>`}${p.id === t.uploader ? html`<span class="cm-flair cm-flair-op" title="Uploaded this manuscript">OP</span>` : ""}`;
}

/** An Issue's chip: with its severity, linked to what the level means. */
function issueChip(severity: string | null): Html {
  const l = severityLevel(severity);
  return l
    ? html`<a class="cm-flair cm-flair-issue cm-sev cm-sev-${l.key}" href="/severity#${l.key}" title="${l.label}: ${l.short} (What the levels mean)">Issue · ${l.label}</a>`
    : html`<span class="cm-flair cm-flair-issue">${KIND_LABEL.issue}</span>`;
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
  const post = c.reply_to == null && !deleted;
  return [
    html`<article class="cm${deleted ? " cm-deleted" : ""}" id="comment-${c.id}"${c.reply_to == null ? html` data-kind="${c.kind}"` : ""}${c.reply_to == null && c.severity ? html` data-severity="${c.severity}"` : ""}${deleted ? "" : html` data-owner="${owner}"`}>
  <div class="cm-gutter">
    ${live ? html`<a class="cm-avatar" href="/u/${live.id}" tabindex="-1">${avatar(live, "avatar-xs")}</a>` : html`<span class="avatar avatar-xs cm-avatar-gone" aria-hidden="true"></span>`}
    <button type="button" class="cm-expand" aria-label="Expand thread" hidden>${ICON.plus}</button>
    ${line}
  </div>
  <div class="cm-content">
    <div class="cm-head">${post && c.kind === "issue" ? issueChip(c.severity) : post && c.kind !== "comment" ? html`<span class="cm-flair cm-flair-${c.kind}">${KIND_LABEL[c.kind]}</span>` : ""}${live ? html`<a class="cm-name" href="/u/${live.id}">${live.displayName}</a>${flairs(t, live)}` : html`<span class="cm-name cm-name-gone">deleted user</span>`}<span class="cm-dot">·</span>${time}${c.edited_at && !deleted ? html`<span class="cm-dot">·</span><a class="cm-edited" href="/comments/${c.id}/history" rel="nofollow" title="${day(c.edited_at)}: see earlier versions">edited</a>` : ""}</div>
    ${deleted ? html`<div class="cm-body cm-body-gone">Comment deleted</div>` : html`${post && c.title ? html`<h3 class="cm-post-title tex">${c.title}</h3>` : ""}<div class="cm-body tex">${bodyHtml(c.body)}</div>
    <div class="cm-actions">
      <form class="cm-vote" method="post" action="/comments/${c.id}/vote">
        <button class="cm-act cm-up" name="vote" value="1" aria-label="Upvote" aria-pressed="false">${ICON.up}</button>
        <span class="cm-score" aria-label="Score">${c.score}</span>
        <button class="cm-act cm-down" name="vote" value="-1" aria-label="Downvote" aria-pressed="false">${ICON.down}</button>
      </form>
      <a class="cm-act" href="${login}" rel="nofollow" data-reply="${c.id}" data-login="${LOGIN_HEADING}">${ICON.reply}<span>Reply</span></a>
      <button type="button" class="cm-act" data-share>${ICON.link}<span>Copy link</span></button>
      <details class="cm-menu">
        <summary class="cm-act" aria-label="More options">${ICON.more}</summary>
        <div class="cm-menu-list">
          <button type="button" class="cm-menu-item" data-edit data-can="own" hidden>Edit</button>
          <form method="post" action="/comments/${c.id}/delete" data-can="own" hidden><button class="cm-menu-item" type="submit">Delete</button></form>
          <form method="post" action="/comments/${c.id}/hide" data-can="moderate" hidden><button class="cm-menu-item" type="submit">Remove</button></form>
          <a class="cm-menu-item" href="${reportHref("comment", String(c.id))}" rel="nofollow" data-can="other" data-login="${REPORT_LOGIN}">Report</a>
          <a class="cm-menu-item" href="/review/comments/${c.id}" rel="nofollow" data-can="moderate" hidden>Moderate</a>
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
  bad_kind: "Couldn’t post that. Try again.",
  title: `Give your comment a title, up to ${MAX_TITLE} characters.`,
  severity: "Choose a severity for the issue.",
  bot_vote: ERRORS.bot_vote[1],
  bad_vote: "Couldn’t count that vote. Try again.",
  vote_rate: "You’ve reached today’s voting limit.",
  removed: "That comment was deleted.",
  not_yours: "You can’t do that.",
  maintainers: "You can’t do that.",
  suspended: "Your account is suspended.",
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
  // The filter row (app.js shows it): only when the page has a labelled post to pick out.
  const n = (k: Kind) => top.filter((c) => c.kind === k && c.state === "visible").length;
  const filters =
    n("issue") + n("question") + n("extension") > 0
      ? html`<div class="cm-filters" role="group" aria-label="Show" hidden>
    <button type="button" class="cm-filter" data-filter="" aria-pressed="true">All</button>
    ${([["issue", "Issues"], ["question", "Questions"], ["extension", "Extensions"]] as const).map(([k, label]) =>
      n(k) ? html`<button type="button" class="cm-filter" data-filter="${k}" aria-pressed="false"${k === "issue" ? html` title="Most severe first"` : ""}>${label} <span class="cm-count">${n(k)}</span></button>` : "",
    )}
  </div>`
      : "";
  return html`<section id="comments" class="cm-section" data-target="${t.target}" data-login-heading="${LOGIN_HEADING}">
  <h2 class="cm-title">Comments${count ? html` <span class="cm-count">${count}</span>` : ""}</h2>
  ${error && html`<div class="cm-error" role="alert">${error}</div>`}
  ${composer(`/${t.target}/comments`, { submit: "Post", id: "comment-new" })}
  <template id="cm-reply-template">${composer(`/${t.target}/comments`, { submit: "Reply", replyTo: 0, id: "" })}</template>
  ${filters}
  <div class="cm-thread">${top.flatMap((c) => commentHtml(t, c, kids, keep, 1))}</div>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// routes: page forms (POST, then back to the page) and the agent API (JSON)

const PAGE_TARGET = String.raw`(\d{4})\/(\d{1,6})|(\d{4}-\d{2}-\d{2})\/(\d{1,4})`;
const FORM_NEW_RE = new RegExp(`^\\/(?:${PAGE_TARGET})\\/comments$`);
const FORM_ACT_RE = /^\/comments\/(\d+)\/(edit|delete|hide|vote)$/;
/** GET: the signed-in person's votes on the page, and current scores (app.js; never cached). */
const VOTES_RE = new RegExp(`^\\/(?:${PAGE_TARGET})\\/comments\\/votes$`);
const API_LIST_RE = new RegExp(`^\\/api\\/(?:papers\\/(\\d{4})\\/(\\d{1,6})|manuscripts\\/(\\d{4}-\\d{2}-\\d{2})\\/(\\d{1,4}))\\/comments\\/?$`);
const API_ONE_RE = /^\/api\/comments\/(\d+)\/?$/;
/** GET: a comment's versions, newest first (page and JSON). */
const HISTORY_RE = /^\/comments\/(\d+)\/history$/;
const LINK_RE = /^\/comments\/(\d+)\/?$/;
const API_HISTORY_RE = /^\/api\/comments\/(\d+)\/history\/?$/;

const targetFrom = (m: RegExpExecArray): string => (m[1] ? canonicalId(Number(m[1]), Number(m[2])) : `${m[3]}/${Number(m[4])}`);

export const isCommentsPath = (path: string): boolean =>
  FORM_NEW_RE.test(path) ||
  FORM_ACT_RE.test(path) ||
  VOTES_RE.test(path) ||
  API_LIST_RE.test(path) ||
  API_ONE_RE.test(path) ||
  HISTORY_RE.test(path) ||
  LINK_RE.test(path) ||
  API_HISTORY_RE.test(path);

export async function handleComments(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const isApi = path.startsWith("/api/");
  const hm = HISTORY_RE.exec(path) ?? API_HISTORY_RE.exec(path);
  if (hm) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });
    return isApi ? historyJson(env, url, Number(hm[1])) : historyPage(env, Number(hm[1]));
  }
  const lm = LINK_RE.exec(path);
  if (lm) {
    // A comment's short link: its place on the paper's page.
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });
    const c = await getComment(env, Number(lm[1]));
    if (!c) return messagePage(env, 404, "No such comment", html`<p>That comment was deleted or removed.</p>`);
    return new Response(null, { status: 301, headers: { location: `/${c.target}#comment-${c.id}` } });
  }
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
  const noStore = { "cache-control": "no-store" };
  const vm = VOTES_RE.exec(path);
  if (vm) {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    const who = await requireUser(env, req);
    return isAuthFailure(who) ? json({ scores: {}, mine: {} }, 200, noStore) : json(await pageVotes(env, who.user, targetFrom(vm)), 200, noStore);
  }
  if (req.method !== "POST") return new Response("Use the form on the page.\n", { status: 405, headers: { allow: "POST" } });
  const am = FORM_ACT_RE.exec(path);
  if (am?.[2] === "vote" && req.headers.has("authorization")) return fail({ error: "bot_vote" });
  const f = await req.formData().catch(() => new FormData());
  const field = (k: string) => String(f.get(k) ?? "");
  const nm = FORM_NEW_RE.exec(path);
  const c = am ? await getComment(env, Number(am[1])) : null;
  const target = nm ? targetFrom(nm) : c?.target;
  if (!target) return new Response("No such comment.\n", { status: 404 });
  const a = await requireUser(env, req);
  // The arrows post with fetch (app.js) and get JSON back; without JavaScript they are plain forms.
  if (am?.[2] === "vote" && (req.headers.get("accept") ?? "").includes("application/json")) {
    if (isAuthFailure(a)) return json({ error: a.code }, a.status, noStore);
    const v = await voteComment(env, a.user, c!, Number(field("vote")), true);
    return "error" in v ? json({ error: v.error, message: PAGE_ERRORS[v.error] }, ERRORS[v.error][0], noStore) : json(v, 200, noStore);
  }
  if (isAuthFailure(a))
    return a.code === "signin"
      ? new Response(null, { status: 303, headers: { location: `/account?next=${encodeURIComponent(`/${target}#comments`)}`, "cache-control": "no-store" } })
      : back(target, a.code);
  if (nm) {
    const replyTo = Number(field("reply_to")) || null;
    const kind = replyTo ? "comment" : field("kind") || "comment";
    const severity = kind === "issue" ? field("severity") : "";
    const r = await addComment(env, a.user, target, { body: field("body"), replyTo, kind, title: replyTo ? "" : field("title"), severity });
    return "error" in r ? back(target, r.error) : back(target, "posted", `comment-${r.id}`);
  }
  const action = am![2];
  if (action === "vote") {
    const v = await voteComment(env, a.user, c!, Number(field("vote")), true);
    return back(target, "error" in v ? v.error : "voted", `comment-${c!.id}`);
  }
  const r =
    action === "edit"
      ? await editComment(
          env,
          a.user,
          c!,
          field("body"),
          f.has("title") ? field("title") : undefined,
          f.has("kind") ? field("kind") : undefined,
          f.has("severity") ? field("severity") : undefined,
        )
      : await removeComment(env, a.user, c!, action as "delete" | "hide");
  const done = { edit: "edited", delete: "deleted", hide: "hidden" }[action]!;
  return r ? back(target, r.error, `comment-${c!.id}`) : back(target, done, `comment-${c!.id}`);
}

const fail = (f: Fail) => err(ERRORS[f.error][0], f.error, ERRORS[f.error][1]);

// ---------------------------------------------------------------------------------------------
// edit history: every version of a visible comment, newest first

interface Version {
  kind: Kind;
  title: string | null;
  severity: Severity | null;
  body: string;
  since: string; // when this text was posted or saved
  until: string | null; // when an edit replaced it; null for the current text
}

/** A visible comment and its versions (null if it is gone). Edits from before versions were kept
 *  (2026-11) left nothing behind: then the current text runs from its last edit, and `lost` is set. */
async function loadHistory(env: Env, id: number): Promise<{ c: Row & { owner: string }; versions: Version[]; lost: boolean } | null> {
  const c = await getComment(env, id);
  if (!c || c.state !== "visible") return null;
  const revs = await env.DB.prepare("SELECT kind, title, severity, body, replaced_at FROM comment_revisions WHERE comment_id = ?1 ORDER BY replaced_at, rowid")
    .bind(id)
    .all<{ kind: Kind; title: string | null; severity: Severity | null; body: string; replaced_at: string }>();
  const lost = !!c.edited_at && !revs.results.length;
  const versions: Version[] = [];
  let since = c.created_at;
  for (const r of revs.results) {
    versions.push({ kind: r.kind, title: r.title, severity: r.severity, body: r.body, since, until: r.replaced_at });
    since = r.replaced_at;
  }
  versions.push({ kind: c.kind, title: c.title, severity: c.severity, body: c.body, since: lost ? c.edited_at! : since, until: null });
  return { c, versions: versions.reverse(), lost };
}

async function historyPage(env: Env, id: number): Promise<Response> {
  const h = await loadHistory(env, id);
  if (!h) return messagePage(env, 404, "No such comment", html`<p>That comment was deleted or removed.</p>`);
  const { c, versions } = h;
  const p = (await publicUsers(env, [c.user_id])).get(c.user_id);
  const top = c.reply_to == null;
  const label = (v: Version) =>
    top && v.kind === "issue" ? issueChip(v.severity) : top && v.kind !== "comment" ? html`<span class="cm-flair cm-flair-${v.kind}">${KIND_LABEL[v.kind]}</span>` : "";
  const n = versions.length;
  return page(env, {
    title: `Edit history of a comment on ${c.target}`,
    katex: true,
    noindex: true,
    cache: "public, max-age=60",
    body: html`<section class="cm-history">
  <h1 class="ms-title">Edit history</h1>
  <p class="text-muted"><a class="tex" href="/${c.target}#comment-${c.id}">${top && c.title ? c.title : "A comment"}</a>${p && !p.deleted ? ` by ${p.displayName}` : ""}</p>
  ${versions.map(
    (v, i) => html`<article class="cm-version">
    <div class="cm-head">${label(v)}<span class="cm-version-when">${i === 0 ? "Current" : i === n - 1 && !h.lost ? "Original" : "Earlier"} · <time datetime="${v.since}">${day(v.since)}</time></span></div>
    ${top && v.title ? html`<h3 class="cm-post-title tex">${v.title}</h3>` : ""}<div class="cm-body tex">${bodyHtml(v.body)}</div>
  </article>`,
  )}
  ${h.lost && html`<p class="text-muted small">Earlier versions weren’t kept.</p>`}
  <a class="report-link" href="${reportHref("comment", String(c.id))}" rel="nofollow" data-login="${REPORT_LOGIN}">Report</a>
</section>`,
  });
}

async function historyJson(env: Env, url: URL, id: number): Promise<Response> {
  const h = await loadHistory(env, id);
  if (!h) return fail({ error: "not_found" });
  const origin = siteOrigin(env, url);
  return json(
    {
      id,
      url: `${origin}/${h.c.target}#comment-${id}`,
      versions: h.versions.map((v) => ({ title: v.title, kind: v.kind, severity: v.severity, body: v.body, since: v.since, until: v.until })),
      earlier_versions_lost: h.lost,
    },
    200,
    { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" },
  );
}

function personJson(origin: string, p: Person | undefined) {
  return p && !p.deleted ? { name: p.displayName, profile_url: `${origin}/u/${p.id}` } : { name: "deleted user" };
}

function commentJson(origin: string, t: Thread, c: Row) {
  const base = { id: c.id, url: `${origin}/${c.target}#comment-${c.id}`, reply_to: c.reply_to, kind: c.kind, severity: c.severity ?? null };
  if (c.state === "hidden") return { ...base, removed: true };
  const p = t.people.get(c.user_id);
  if (c.state === "deleted") return { ...base, author: { ...personJson(origin, p), uploader: !!p && p.id === t.uploader }, deleted: true, created_at: c.created_at };
  return {
    ...base,
    author: { ...personJson(origin, p), uploader: !!p && p.id === t.uploader },
    title: c.title,
    body: c.body,
    score: c.score,
    created_at: c.created_at,
    edited_at: c.edited_at,
    ...(c.edited_at ? { history_url: `${origin}/api/comments/${c.id}/history` } : {}),
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
      kind: typeof f.kind === "string" ? f.kind : "",
      title: typeof f.title === "string" ? f.title : "",
      severity: typeof f.severity === "string" ? f.severity : "",
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
  if (f.body === undefined && f.title === undefined && f.kind === undefined && f.severity === undefined)
    return err(400, "nothing_to_do", 'Send {"body": "..."} with the new text ("title", "kind" and "severity" retitle, relabel and rerate a top-level comment).');
  const r = await editComment(
    env,
    who.user,
    c,
    typeof f.body === "string" ? f.body : c.body,
    typeof f.title === "string" ? f.title : undefined,
    typeof f.kind === "string" ? f.kind : undefined,
    typeof f.severity === "string" ? f.severity : undefined,
  );
  if (r) return fail(r);
  const t = await loadThread(env, c.target);
  return json(commentJson(origin, t, t.rows.find((x) => x.id === id)!));
}
