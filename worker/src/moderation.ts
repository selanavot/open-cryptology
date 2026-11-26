// Moderation (tables: the "moderation" section of db/schema.sql): reports from readers, suspended
// accounts, and a log of every maintainer action.
//
//   /report?comment=<id> | manuscript=<id> | user=<id>   signed-in people report something (GET the
//                                     form, POST it); one open report per person per thing
//   /review/reports                   maintainers: open reports, grouped by what was reported
//   /review/users/<id>                maintainers: an account, what it posted, its log; suspend it
//   /review/comments/<id>             maintainers: a comment, its earlier versions, its reports
//   /review/act (POST)                every maintainer action; each one goes to mod_log
//
// New reports send the maintainer a summary email, at most one every 15 minutes (like uploads).
// A suspended account can still sign in, read, delete its own comments and delete itself; it can't
// post, edit, vote, rename, merge or use agents (checked where those happen). Suspending revokes
// its agents' tokens. Its content stays up unless a maintainer hides it.
import type { Env } from "./db";
import { html, type Html } from "./html";
import { messagePage } from "./layout";
import { isAuthFailure, publicUsers, redirect303, requireUser, setCustomName, type Actor } from "./auth";
import { revokeAgentsOfManuscript } from "./agentapi";

type Kind = "comment" | "manuscript" | "user";
const KINDS: Kind[] = ["comment", "manuscript", "user"];
const REASONS = { spam: "Spam", abuse: "Harassment, hate or threats", other: "Something else" } as const;
type Reason = keyof typeof REASONS;
const MAX_NOTE = 1000;
const REPORTS_DAILY = 30; // reports per account per 24 hours
const EMAIL_EVERY = 15 * 60_000;
const LAST_EMAIL_KEY = "reports_email_sent_at";
const NO_STORE = { cache: "no-store", noindex: true } as const;
const MS_ID = /^\d{4}-\d{2}-\d{2}\/\d{1,4}$/;
const USER_ID = /^[a-z0-9-]{4,40}$/;

const nowIso = () => new Date().toISOString();
const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");
const excerpt = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** The accounts whose content counts as this account's: itself and accounts merged into it. */
const ACCOUNT_IDS = "(SELECT id FROM users WHERE id = ?1 OR merged_into = ?1)";

// ---------------------------------------------------------------------------------------------
// actions (each logged in mod_log; acting on something closes its open reports)

function log(env: Env, by: string, action: string, kind: Kind, target: string, subject: string | null, note = "") {
  return env.DB.prepare("INSERT INTO mod_log (at, by, action, kind, target, subject, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(
    nowIso(),
    by,
    action,
    kind,
    target,
    subject,
    note || null,
  );
}

function closeReports(env: Env, by: string, kind: Kind, target: string, outcome: "actioned" | "dismissed") {
  return env.DB.prepare("UPDATE reports SET closed_at = ?4, closed_by = ?3, outcome = ?5 WHERE kind = ?1 AND target = ?2 AND closed_at IS NULL").bind(
    kind,
    target,
    by,
    nowIso(),
    outcome,
  );
}

/** A comment's author (their current account, after merges) and state, or null. */
async function commentOwner(env: Env, id: number): Promise<{ owner: string; state: string } | null> {
  return env.DB.prepare("SELECT COALESCE(u.merged_into, u.id) AS owner, c.state FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?1")
    .bind(id)
    .first<{ owner: string; state: string }>();
}

/** Hide a comment (its text is kept). Returns false if it wasn't visible. */
export async function hideComment(env: Env, by: string, id: number, note = ""): Promise<boolean> {
  const c = await commentOwner(env, id);
  if (!c || c.state !== "visible") return false;
  await env.DB.batch([
    env.DB.prepare("UPDATE comments SET state = 'hidden', moderated_by = ?2 WHERE id = ?1 AND state = 'visible'").bind(id, by),
    log(env, by, "hide", "comment", String(id), c.owner, note),
    closeReports(env, by, "comment", String(id), "actioned"),
  ]);
  return true;
}

async function unhideComment(env: Env, by: string, id: number, note = ""): Promise<boolean> {
  const c = await commentOwner(env, id);
  if (!c || c.state !== "hidden") return false;
  await env.DB.batch([
    env.DB.prepare("UPDATE comments SET state = 'visible', moderated_by = NULL WHERE id = ?1 AND state = 'hidden'").bind(id),
    log(env, by, "unhide", "comment", String(id), c.owner, note),
  ]);
  return true;
}

/** Remove an original manuscript: its files and text are deleted and can't be restored; the id
 *  stays taken. Optionally disconnects the uploader's agents if an agent posted it. */
export async function removeManuscript(env: Env, by: string, id: string, revoke: boolean, note = ""): Promise<{ ok: boolean; revoked: boolean }> {
  const m = await env.DB.prepare("SELECT COALESCE(u.merged_into, u.id) AS owner FROM manuscripts m JOIN users u ON u.id = m.uploader_id WHERE m.id = ?1 AND m.removed_at IS NULL")
    .bind(id)
    .first<{ owner: string }>();
  if (!m) return { ok: false, revoked: false };
  const files = await env.DB.prepare("SELECT file_key FROM manuscript_versions WHERE manuscript_id = ?1 AND file_key IS NOT NULL").bind(id).all<{ file_key: string }>();
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE manuscripts SET removed_at = ?2, removed_by = ?3 WHERE id = ?1 AND removed_at IS NULL").bind(id, nowIso(), by),
    env.DB.prepare(
      "UPDATE manuscript_versions SET body = NULL, file_key = NULL, abstract = '', title = '(removed)' WHERE manuscript_id = ?1 AND EXISTS (SELECT 1 FROM manuscripts WHERE id = ?1 AND removed_by = ?2)",
    ).bind(id, by),
    log(env, by, "remove", "manuscript", id, m.owner, note),
    closeReports(env, by, "manuscript", id, "actioned"),
  ]);
  const ok = (r[0].meta.changes ?? 0) > 0;
  if (ok && files.results.length) await env.PDFS.delete(files.results.map((x) => x.file_key));
  const revoked = ok && revoke && (await revokeAgentsOfManuscript(env, id));
  return { ok, revoked };
}

async function suspend(env: Env, by: string, userId: string, note: string): Promise<boolean> {
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE users SET suspended_at = ?2 WHERE id = ?1 AND suspended_at IS NULL AND deleted_at IS NULL").bind(userId, nowIso()),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL").bind(userId, nowIso()),
    env.DB.prepare("UPDATE agent_connect SET status = 'denied' WHERE status = 'approved' AND user_id = ?1").bind(userId),
    log(env, by, "suspend", "user", userId, userId, note),
    closeReports(env, by, "user", userId, "actioned"),
  ]);
  return (r[0].meta.changes ?? 0) > 0;
}

async function unsuspend(env: Env, by: string, userId: string, note: string): Promise<boolean> {
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?1 AND suspended_at IS NOT NULL").bind(userId),
    log(env, by, "unsuspend", "user", userId, userId, note),
  ]);
  return (r[0].meta.changes ?? 0) > 0;
}

/** Back to the name from the account's sign-ins. Bots' names are set on /account/bots instead. */
async function resetName(env: Env, by: string, userId: string, note: string): Promise<boolean> {
  const u = await env.DB.prepare("SELECT custom_name, bot_bio FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(userId).first<{ custom_name: string | null; bot_bio: string | null }>();
  if (!u || u.custom_name === null || u.bot_bio !== null) return false;
  await setCustomName(env, userId, null);
  await env.DB.batch([log(env, by, "reset_name", "user", userId, userId, note || `was "${u.custom_name}"`), closeReports(env, by, "user", userId, "actioned")]);
  return true;
}

/** Hide every visible comment the account posted (each can be restored on its own). */
async function hideAllComments(env: Env, by: string, userId: string, note: string): Promise<number> {
  const ids = await env.DB.prepare(`SELECT id FROM comments WHERE user_id IN ${ACCOUNT_IDS} AND state = 'visible'`).bind(userId).all<{ id: number }>();
  if (!ids.results.length) return 0;
  const list = JSON.stringify(ids.results.map((x) => x.id));
  const listText = JSON.stringify(ids.results.map((x) => String(x.id)));
  await env.DB.batch([
    env.DB.prepare("UPDATE comments SET state = 'hidden', moderated_by = ?2 WHERE id IN (SELECT value FROM json_each(?1)) AND state = 'visible'").bind(list, by),
    env.DB.prepare(
      "UPDATE reports SET closed_at = ?3, closed_by = ?2, outcome = 'actioned' WHERE kind = 'comment' AND closed_at IS NULL AND target IN (SELECT value FROM json_each(?1))",
    ).bind(listText, by, nowIso()),
    log(env, by, "hide", "user", userId, userId, note || `all ${ids.results.length} visible comments`),
  ]);
  return ids.results.length;
}

async function dismiss(env: Env, by: string, kind: Kind, target: string, note: string): Promise<boolean> {
  const r = await env.DB.batch([closeReports(env, by, kind, target, "dismissed"), log(env, by, "dismiss", kind, target, await subjectOf(env, kind, target), note)]);
  return (r[0].meta.changes ?? 0) > 0;
}

/** The account a reported thing belongs to. */
async function subjectOf(env: Env, kind: Kind, target: string): Promise<string | null> {
  if (kind === "user") return target;
  if (kind === "comment") return (await commentOwner(env, Number(target)))?.owner ?? null;
  const m = await env.DB.prepare("SELECT COALESCE(u.merged_into, u.id) AS owner FROM manuscripts m JOIN users u ON u.id = m.uploader_id WHERE m.id = ?1")
    .bind(target)
    .first<{ owner: string }>();
  return m?.owner ?? null;
}

// ---------------------------------------------------------------------------------------------
// reporting (/report)

interface Reported {
  kind: Kind;
  target: string;
  label: string; // "comment", "original manuscript", "account"
  back: string; // where the reported thing is shown
  preview: Html;
  snapshot: string; // JSON, kept with the report
}

/** The thing being reported, if it can be: a visible comment, a manuscript that wasn't removed, a
 *  live account. */
async function findReported(env: Env, kind: string, target: string): Promise<Reported | null> {
  if (kind === "comment" && /^\d{1,12}$/.test(target)) {
    const c = await env.DB.prepare("SELECT id, target, user_id, title, body FROM comments WHERE id = ?1 AND state = 'visible'")
      .bind(Number(target))
      .first<{ id: number; target: string; user_id: string; title: string | null; body: string }>();
    if (!c) return null;
    const who = (await publicUsers(env, [c.user_id])).get(c.user_id);
    return {
      kind,
      target: String(c.id),
      label: "comment",
      back: `/${c.target}#comment-${c.id}`,
      preview: html`<blockquote class="report-quote">${c.title && html`<strong>${c.title}</strong><br>`}<span class="report-text">${excerpt(c.body)}</span><footer class="small text-muted">${who?.displayName ?? ""}</footer></blockquote>`,
      snapshot: JSON.stringify({ title: c.title, body: c.body }),
    };
  }
  if (kind === "manuscript" && MS_ID.test(target)) {
    const m = await env.DB.prepare(
      "SELECT m.id, v.title FROM manuscripts m JOIN manuscript_versions v ON v.manuscript_id = m.id WHERE m.id = ?1 AND m.removed_at IS NULL ORDER BY v.v DESC LIMIT 1",
    )
      .bind(target)
      .first<{ id: string; title: string }>();
    if (!m) return null;
    return {
      kind,
      target: m.id,
      label: "original manuscript",
      back: `/${m.id}`,
      preview: html`<blockquote class="report-quote"><strong>${m.id}</strong>: ${m.title}</blockquote>`,
      snapshot: JSON.stringify({ title: m.title }),
    };
  }
  if (kind === "user" && USER_ID.test(target)) {
    const u = (await publicUsers(env, [target])).get(target);
    if (!u || u.deleted || u.id !== target) return null;
    return {
      kind,
      target: u.id,
      label: "account",
      back: `/u/${u.id}`,
      preview: html`<blockquote class="report-quote"><strong>${u.displayName}</strong></blockquote>`,
      snapshot: JSON.stringify({ name: u.displayName }),
    };
  }
  return null;
}

function reportForm(env: Env, r: Reported): Response {
  return messagePage(
    env,
    200,
    `Report ${r.label === "comment" ? "a" : "an"} ${r.label}`,
    html`${r.preview}
<form class="contact-form report-form" method="post" action="/report">
  <input type="hidden" name="kind" value="${r.kind}">
  <input type="hidden" name="target" value="${r.target}">
  <fieldset><legend class="form-label">Why?</legend>
    ${Object.entries(REASONS).map(
      ([k, label], i) => html`<label class="acct-check"><input type="radio" name="reason" value="${k}" required${i === 0 ? html` checked` : ""}> ${label}</label>`,
    )}
  </fieldset>
  <div><label class="form-label" for="r-note">Details <span class="text-muted small">(optional)</span></label>
    <textarea class="form-control" id="r-note" name="note" maxlength="${MAX_NOTE}" rows="3"></textarea></div>
  <div><button class="btn btn-outline-dark" type="submit">Send report</button> <a class="btn btn-link" href="${r.back}">Cancel</a></div>
</form>`,
    NO_STORE,
  );
}

async function reportRoute(env: Env, req: Request, url: URL): Promise<Response> {
  const isPost = req.method === "POST";
  const form = isPost ? await req.formData().catch(() => new FormData()) : null;
  const field = (k: string) => String(form?.get(k) ?? "").trim();
  const [kind, target] = isPost ? [field("kind"), field("target")] : (KINDS.map((k) => [k, url.searchParams.get(k)]).find(([, v]) => v) ?? ["", ""]);
  const a = await requireUser(env, req);
  if (isAuthFailure(a)) {
    if (a.code === "signin") return redirect303(`/account?next=${encodeURIComponent(isPost ? "/" : url.pathname + url.search)}`);
    return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, NO_STORE);
  }
  if (a.user.suspended) return messagePage(env, 403, "Account suspended", html`<p>Your account is suspended.</p>`, NO_STORE);
  const r = await findReported(env, kind ?? "", target ?? "");
  if (!r) return messagePage(env, 404, "Nothing to report", html`<p>That’s gone already, or the link is wrong.</p>`, NO_STORE);
  if (!isPost) return reportForm(env, r);

  const reason = field("reason") as Reason;
  if (!(reason in REASONS)) return reportForm(env, r);
  const note = field("note").replace(/\r\n?/g, "\n").slice(0, MAX_NOTE);
  const now = new Date();
  // One open report per person per thing; the daily limit is checked in the same statement.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (kind, target, reporter_id, reason, note, snapshot, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE (SELECT count(*) FROM reports WHERE reporter_id = ?3 AND created_at > ?8) < ?9`,
  )
    .bind(r.kind, r.target, a.user.id, reason, note || null, r.snapshot, now.toISOString(), new Date(now.getTime() - 86400_000).toISOString(), REPORTS_DAILY)
    .run();
  if (!ins.meta.changes) {
    const open = await env.DB.prepare("SELECT 1 FROM reports WHERE kind = ?1 AND target = ?2 AND reporter_id = ?3 AND closed_at IS NULL")
      .bind(r.kind, r.target, a.user.id)
      .first();
    if (!open) return messagePage(env, 429, "That’s a lot of reports", html`<p>You’ve reached today’s report limit. Try again tomorrow.</p>`, NO_STORE);
  } else await notifyReports(env, url.origin);
  return messagePage(env, 200, "Thanks", html`<p>A maintainer will look at it. <a href="${r.back}">Back</a></p>`, NO_STORE);
}

/** Email the maintainer the open reports, unless one was sent in the last 15 minutes or nothing
 *  was reported since. Never throws. */
export async function notifyReports(env: Env, origin: string): Promise<void> {
  if (!env.MAILER || !env.CONTACT_TO || !env.CONTACT_FROM) return;
  try {
    const now = new Date();
    const last = await env.DB.prepare("SELECT value FROM meta WHERE key = ?1").bind(LAST_EMAIL_KEY).first<{ value: string }>();
    const lastAt = last?.value ?? "";
    if (lastAt && now.getTime() - Date.parse(lastAt) < EMAIL_EVERY) return;
    const open = await env.DB.prepare(
      "SELECT kind, target, count(*) AS n, MAX(created_at) AS latest, group_concat(DISTINCT reason) AS reasons FROM reports WHERE closed_at IS NULL GROUP BY kind, target ORDER BY latest DESC",
    ).all<{ kind: Kind; target: string; n: number; latest: string; reasons: string }>();
    const rows = open.results ?? [];
    if (!rows.length || rows[0].latest <= lastAt) return;
    // Claim the slot atomically, so reports filed together send one email between them.
    const claim = await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS ?3`,
    )
      .bind(LAST_EMAIL_KEY, now.toISOString(), last ? lastAt : null)
      .run();
    if (!claim.meta.changes) return;
    const shown = rows.slice(0, 20);
    await env.MAILER.send({
      from: { name: `${env.SITE_NAME} reports`, email: env.CONTACT_FROM },
      to: env.CONTACT_TO,
      subject: `[${env.SITE_NAME}] ${rows.length} reported item${rows.length === 1 ? "" : "s"} to review`,
      text: [
        `Open reports on ${rows.length} item${rows.length === 1 ? "" : "s"}:`,
        "",
        ...shown.map((r) => `- ${r.kind} ${r.target}: ${r.reasons.split(",").map((x) => REASONS[x as Reason] ?? x).join(", ")} (${r.n})`),
        ...(rows.length > shown.length ? [`- ... and ${rows.length - shown.length} more`] : []),
        "",
        `Review them: ${origin}/review/reports`,
        "",
        `You'll get at most one of these emails every ${EMAIL_EVERY / 60000} minutes.`,
      ].join("\n"),
    });
  } catch (e) {
    console.error("reports email failed", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------------------------
// maintainer pages

interface ReportRow {
  id: number;
  kind: Kind;
  target: string;
  reporter_id: string;
  reason: Reason;
  note: string | null;
  snapshot: string | null;
  created_at: string;
  closed_at: string | null;
  outcome: string | null;
}
interface CommentRow {
  id: number;
  target: string;
  owner: string;
  state: string;
  kind: string;
  title: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}
const COMMENT_SQL =
  "SELECT c.id, c.target, COALESCE(u.merged_into, u.id) AS owner, c.state, c.kind, c.title, c.body, c.created_at, c.edited_at FROM comments c JOIN users u ON u.id = c.user_id";

const reviewNav = (openReports?: number) =>
  html`<p class="small"><a href="/review/reports">Reports${openReports !== undefined ? ` (${openReports} open)` : ""}</a> · <a href="/review">Uploads</a></p>`;

/** One action button: a POST to /review/act. `confirm` adds a required tick box. */
function act(kind: Kind, target: string, action: string, label: string, back: string, o: { confirm?: string; note?: boolean; extra?: Html } = {}): Html {
  return html`<form method="post" action="/review/act" class="mod-act">
  <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="target" value="${target}">
  <input type="hidden" name="action" value="${action}"><input type="hidden" name="back" value="${back}">
  ${o.note && html`<input class="form-control form-control-sm mod-note" name="note" placeholder="Note (optional)" maxlength="500" aria-label="Note">`}
  ${o.confirm && html`<label class="small"><input type="checkbox" name="confirm" value="yes" required> ${o.confirm}</label>`}
  ${o.extra}
  <button class="btn btn-sm btn-outline-dark">${label}</button>
</form>`;
}

function commentActions(c: CommentRow, back: string): Html {
  return c.state === "visible"
    ? act("comment", String(c.id), "hide", "Hide", back)
    : c.state === "hidden"
      ? act("comment", String(c.id), "unhide", "Restore", back)
      : html``;
}

const stateTag = (s: string) => (s === "visible" ? "" : html` <strong>[${s}]</strong>`);

async function reportsPage(env: Env, url: URL): Promise<Response> {
  const open = (
    await env.DB.prepare("SELECT * FROM reports WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT 1000").all<ReportRow>()
  ).results;
  const groups = new Map<string, ReportRow[]>();
  for (const r of open) groups.set(`${r.kind} ${r.target}`, [...(groups.get(`${r.kind} ${r.target}`) ?? []), r]);
  const commentIds = open.filter((r) => r.kind === "comment").map((r) => Number(r.target));
  const msIds = open.filter((r) => r.kind === "manuscript").map((r) => r.target);
  const [cs, ms] = await Promise.all([
    commentIds.length
      ? env.DB.prepare(`${COMMENT_SQL} WHERE c.id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(commentIds)).all<CommentRow>()
      : { results: [] as CommentRow[] },
    msIds.length
      ? env.DB.prepare(
          `SELECT m.id, COALESCE(u.merged_into, u.id) AS owner, m.removed_at, (SELECT title FROM manuscript_versions WHERE manuscript_id = m.id ORDER BY v DESC LIMIT 1) AS title
             FROM manuscripts m JOIN users u ON u.id = m.uploader_id WHERE m.id IN (SELECT value FROM json_each(?1))`,
        ).bind(JSON.stringify(msIds)).all<{ id: string; owner: string; removed_at: string | null; title: string }>()
      : { results: [] as { id: string; owner: string; removed_at: string | null; title: string }[] },
  ]);
  const comments = new Map(cs.results.map((c) => [String(c.id), c]));
  const manuscripts = new Map(ms.results.map((m) => [m.id, m]));
  const people = await publicUsers(env, [
    ...open.map((r) => r.reporter_id),
    ...cs.results.map((c) => c.owner),
    ...ms.results.map((m) => m.owner),
    ...open.filter((r) => r.kind === "user").map((r) => r.target),
  ]);
  const name = (id: string) => html`<a href="/review/users/${id}">${people.get(id)?.displayName ?? id}</a>`;
  const back = "/review/reports";
  const done = url.searchParams.get("done");

  const item = (rows: ReportRow[]): Html => {
    const { kind, target } = rows[0];
    let head: Html;
    let actions: Html;
    if (kind === "comment") {
      const c = comments.get(target);
      const snap = rows[0].snapshot ? (JSON.parse(rows[0].snapshot) as { title: string | null; body: string }) : null;
      head = c
        ? html`Comment on <a href="/${c.target}#comment-${c.id}">${c.target}</a> by ${name(c.owner)}${stateTag(c.state)} · <a href="/review/comments/${c.id}">details</a>
          <blockquote class="report-quote">${c.title && html`<strong>${c.title}</strong><br>`}<span class="report-text">${excerpt(c.state === "deleted" && snap ? snap.body : c.body)}</span>
          ${c.edited_at && c.edited_at >= rows[rows.length - 1].created_at && html`<footer class="small"><strong>Edited since it was reported.</strong></footer>`}</blockquote>`
        : html`Comment ${target} (gone)`;
      actions = html`${c?.state === "visible" && act("comment", target, "hide", "Hide", back)}`;
    } else if (kind === "manuscript") {
      const m = manuscripts.get(target);
      head = m
        ? html`Original manuscript <a href="/${m.id}">${m.id}</a> by ${name(m.owner)}${m.removed_at ? html` <strong>[removed]</strong>` : ""}<blockquote class="report-quote">${m.title}</blockquote>`
        : html`Original manuscript ${target} (gone)`;
      actions = html`${m && !m.removed_at && act("manuscript", target, "remove", "Remove", back, { confirm: "Delete its files for good" })}`;
    } else {
      const u = people.get(target);
      head = html`Account ${name(target)}${u?.deleted ? html` <strong>[deleted]</strong>` : ""} · <a href="/u/${target}">profile</a>`;
      actions = html`${u && !u.deleted && html`${u.customName && u.botBio === null && act("user", target, "reset_name", "Reset name", back)}${act("user", target, "suspend", "Suspend", back)}`}`;
    }
    return html`<li class="mod-item">
  <div>${head}</div>
  <ul class="small mod-reports">${rows.map(
    (r) => html`<li><strong>${REASONS[r.reason] ?? r.reason}</strong> · ${name(r.reporter_id)} · ${when(r.created_at)}${r.note && html`<br>${r.note}`}</li>`,
  )}</ul>
  <div class="mod-actions">${actions}${act(kind, target, "dismiss", "Dismiss", back)}</div>
</li>`;
  };

  return messagePage(
    env,
    200,
    "Reports",
    html`${reviewNav()}
    ${done && html`<p class="upload-notice upload-notice-ok" role="status">Done: ${done}.</p>`}
    <p>${groups.size ? `${groups.size} reported item${groups.size === 1 ? "" : "s"}, latest first.` : "No open reports."}</p>
    <ol class="mod-list">${[...groups.values()].map(item)}</ol>
    <form method="get" action="/review/users" class="d-flex gap-2 mt-4">
      <input class="form-control" name="u" placeholder="Profile link or account id" required aria-label="Look up an account">
      <button class="btn btn-outline-dark">Look up</button>
    </form>`,
    NO_STORE,
  );
}

async function userPage(env: Env, id: string, url: URL): Promise<Response> {
  const u = await env.DB.prepare("SELECT id, custom_name, bot_bio, created_at, deleted_at, merged_into, suspended_at FROM users WHERE id = ?1")
    .bind(id)
    .first<{ id: string; custom_name: string | null; bot_bio: string | null; created_at: string; deleted_at: string | null; merged_into: string | null; suspended_at: string | null }>();
  if (!u) return messagePage(env, 404, "No such account", html`${reviewNav()}<p>There’s no account ${id}.</p>`, NO_STORE);
  if (u.merged_into) return redirect303(`/review/users/${u.merged_into}`);
  const back = `/review/users/${id}`;
  const [ids, cs, ms, against, filed, logs] = await env.DB.batch([
    env.DB.prepare("SELECT provider, handle, url FROM identities WHERE user_id = ?1 ORDER BY created_at").bind(id),
    env.DB.prepare(`${COMMENT_SQL} WHERE c.user_id IN ${ACCOUNT_IDS} ORDER BY c.created_at DESC LIMIT 100`).bind(id),
    env.DB.prepare(
      `SELECT m.id, m.created_at, m.removed_at, m.withdrawn_at, (SELECT title FROM manuscript_versions WHERE manuscript_id = m.id ORDER BY v DESC LIMIT 1) AS title
         FROM manuscripts m WHERE m.uploader_id IN ${ACCOUNT_IDS} ORDER BY m.created_at DESC LIMIT 100`,
    ).bind(id),
    env.DB.prepare(
      `SELECT r.* FROM reports r WHERE (r.kind = 'user' AND r.target = ?1)
          OR (r.kind = 'comment' AND r.target IN (SELECT CAST(id AS TEXT) FROM comments WHERE user_id IN ${ACCOUNT_IDS}))
          OR (r.kind = 'manuscript' AND r.target IN (SELECT id FROM manuscripts WHERE uploader_id IN ${ACCOUNT_IDS}))
        ORDER BY r.created_at DESC LIMIT 100`,
    ).bind(id),
    env.DB.prepare(`SELECT count(*) AS n, SUM(outcome = 'dismissed') AS dismissed FROM reports WHERE reporter_id IN ${ACCOUNT_IDS}`).bind(id),
    env.DB.prepare("SELECT * FROM mod_log WHERE subject = ?1 ORDER BY at DESC LIMIT 100").bind(id),
  ]);
  const comments = cs.results as unknown as CommentRow[];
  const manuscripts = ms.results as unknown as { id: string; created_at: string; removed_at: string | null; withdrawn_at: string | null; title: string }[];
  const reports = against.results as unknown as ReportRow[];
  const log = logs.results as unknown as { at: string; by: string; action: string; kind: Kind; target: string; note: string | null }[];
  const f = (filed.results[0] ?? { n: 0, dismissed: 0 }) as { n: number; dismissed: number | null };
  const people = await publicUsers(env, [id, ...reports.map((r) => r.reporter_id), ...log.map((l) => l.by)]);
  const display = people.get(id)?.displayName ?? id;
  const live = !u.deleted_at;
  const done = url.searchParams.get("done");
  return messagePage(
    env,
    200,
    display,
    html`${reviewNav()}
    ${done && html`<p class="upload-notice upload-notice-ok" role="status">Done: ${done}.</p>`}
    <p class="small">${live ? html`<a href="/u/${id}">Public profile</a> · ` : html`<strong>Deleted ${when(u.deleted_at)}</strong> · `}created ${when(u.created_at)}${u.bot_bio !== null ? " · bot" : ""}
    ${u.suspended_at && html`<br><strong>Suspended since ${when(u.suspended_at)}</strong>`}<br>
    Sign-ins: ${(ids.results as { provider: string; handle: string; url: string }[]).map(
      (i, n) => html`${n ? ", " : ""}${i.url ? html`<a href="${i.url}" rel="noopener">${i.provider} ${i.handle}</a>` : `${i.provider} ${i.handle}`}`,
    )}<br>
    Reports filed: ${f.n}${f.dismissed ? ` (${f.dismissed} dismissed)` : ""}</p>
    ${live && html`<div class="mod-actions">
      ${u.suspended_at ? act("user", id, "unsuspend", "Unsuspend", back, { note: true }) : act("user", id, "suspend", "Suspend", back, { note: true })}
      ${u.custom_name && u.bot_bio === null && act("user", id, "reset_name", "Reset name", back)}
      ${comments.some((c) => c.state === "visible") && act("user", id, "hide_all", "Hide all comments", back, { confirm: "Every visible comment" })}
    </div>`}

    <h5 class="mt-4">Comments${comments.length === 100 ? " (latest 100)" : ""}</h5>
    ${comments.length
      ? html`<ul class="mod-list small">${comments.map(
          (c) => html`<li class="mod-item">${when(c.created_at)} on <a href="/${c.target}#comment-${c.id}">${c.target}</a>${stateTag(c.state)}${c.edited_at ? " · edited" : ""} · <a href="/review/comments/${c.id}">details</a>
          <div>${c.title && html`<strong>${c.title}</strong> `}${excerpt(c.body, 200)}</div>${commentActions(c, back)}</li>`,
        )}</ul>`
      : html`<p class="small text-muted">None.</p>`}

    <h5 class="mt-4">Original manuscripts</h5>
    ${manuscripts.length
      ? html`<ul class="mod-list small">${manuscripts.map(
          (m) => html`<li class="mod-item"><a href="/${m.id}">${m.id}</a> ${m.title}${m.removed_at ? html` <strong>[removed]</strong>` : m.withdrawn_at ? " [withdrawn]" : ""}
          ${!m.removed_at && act("manuscript", m.id, "remove", "Remove", back, { confirm: "Delete its files for good" })}</li>`,
        )}</ul>`
      : html`<p class="small text-muted">None.</p>`}

    <h5 class="mt-4">Reports about this account’s content</h5>
    ${reports.length
      ? html`<ul class="small">${reports.map(
          (r) => html`<li>${when(r.created_at)} · ${r.kind} ${r.kind === "comment" ? html`<a href="/review/comments/${r.target}">${r.target}</a>` : r.target} · <strong>${REASONS[r.reason] ?? r.reason}</strong>
          by <a href="/review/users/${r.reporter_id}">${people.get(r.reporter_id)?.displayName ?? r.reporter_id}</a> · ${r.closed_at ? r.outcome : "open"}${r.note && html`<br>${r.note}`}</li>`,
        )}</ul>`
      : html`<p class="small text-muted">None.</p>`}

    <h5 class="mt-4">Moderation log</h5>
    ${log.length
      ? html`<ul class="small">${log.map(
          (l) => html`<li>${when(l.at)} · ${people.get(l.by)?.displayName ?? l.by}: ${l.action} ${l.kind} ${l.target}${l.note && html` (${l.note})`}</li>`,
        )}</ul>`
      : html`<p class="small text-muted">Nothing yet.</p>`}`,
    NO_STORE,
  );
}

async function commentPage(env: Env, id: number, url: URL): Promise<Response> {
  const c = await env.DB.prepare(`${COMMENT_SQL} WHERE c.id = ?1`).bind(id).first<CommentRow>();
  if (!c) return messagePage(env, 404, "No such comment", html`${reviewNav()}<p>There’s no comment ${id}.</p>`, NO_STORE);
  const [revs, reps, logs] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM comment_revisions WHERE comment_id = ?1 ORDER BY replaced_at DESC").bind(id),
    env.DB.prepare("SELECT * FROM reports WHERE kind = 'comment' AND target = ?1 ORDER BY created_at DESC").bind(String(id)),
    env.DB.prepare("SELECT * FROM mod_log WHERE kind = 'comment' AND target = ?1 ORDER BY at DESC").bind(String(id)),
  ]);
  const revisions = revs.results as unknown as { replaced_at: string; kind: string; title: string | null; body: string }[];
  const reports = reps.results as unknown as ReportRow[];
  const log = logs.results as unknown as { at: string; by: string; action: string; note: string | null }[];
  const people = await publicUsers(env, [c.owner, ...reports.map((r) => r.reporter_id), ...log.map((l) => l.by)]);
  const name = (uid: string) => html`<a href="/review/users/${uid}">${people.get(uid)?.displayName ?? uid}</a>`;
  const back = `/review/comments/${id}`;
  const done = url.searchParams.get("done");
  const text = (title: string | null, body: string) => html`<blockquote class="report-quote mod-full">${title && html`<strong>${title}</strong><br>`}<span class="report-text">${body}</span></blockquote>`;
  const deletedSnap = c.state === "deleted" ? reports.find((r) => r.snapshot)?.snapshot : null;
  return messagePage(
    env,
    200,
    `Comment ${id}`,
    html`${reviewNav()}
    ${done && html`<p class="upload-notice upload-notice-ok" role="status">Done: ${done}.</p>`}
    <p class="small">On <a href="/${c.target}#comment-${c.id}">${c.target}</a> by ${name(c.owner)} · ${when(c.created_at)}${stateTag(c.state)}${c.edited_at ? ` · last edited ${when(c.edited_at)}` : ""}</p>
    ${c.state === "deleted"
      ? deletedSnap
        ? html`<p class="small">Deleted by its author. As reported:</p>${(() => {
            const s = JSON.parse(deletedSnap) as { title: string | null; body: string };
            return text(s.title, s.body);
          })()}`
        : html`<p class="small">Deleted by its author.</p>`
      : text(c.title, c.body)}
    <div class="mod-actions">${commentActions(c, back)}</div>

    ${revisions.length > 0 && html`<h5 class="mt-4">Earlier versions</h5>${revisions.map((r) => html`<p class="small">Until ${when(r.replaced_at)}:</p>${text(r.title, r.body)}`)}`}

    <h5 class="mt-4">Reports</h5>
    ${reports.length
      ? html`<ul class="small">${reports.map(
          (r) => html`<li>${when(r.created_at)} · <strong>${REASONS[r.reason] ?? r.reason}</strong> by ${name(r.reporter_id)} · ${r.closed_at ? r.outcome : "open"}${r.note && html`<br>${r.note}`}</li>`,
        )}</ul>`
      : html`<p class="small text-muted">None.</p>`}
    ${log.length > 0 && html`<h5 class="mt-4">Moderation log</h5><ul class="small">${log.map(
      (l) => html`<li>${when(l.at)} · ${people.get(l.by)?.displayName ?? l.by}: ${l.action}${l.note && html` (${l.note})`}</li>`,
    )}</ul>`}`,
    NO_STORE,
  );
}

/** POST /review/act: one maintainer action, then back to the page it came from. */
async function actRoute(env: Env, req: Request, a: Actor): Promise<Response> {
  const form = await req.formData().catch(() => new FormData());
  const field = (k: string) => String(form.get(k) ?? "").trim();
  const kind = field("kind") as Kind;
  const target = field("target");
  const action = field("action");
  const note = field("note").slice(0, 500);
  const backRaw = field("back");
  const back = /^\/review(\/[\w/-]*)?$/.test(backRaw) ? backRaw : "/review/reports";
  const by = a.user.id;
  const confirmed = form.get("confirm") === "yes";
  let result: string | null = null;
  if (kind === "comment" && /^\d{1,12}$/.test(target)) {
    if (action === "hide") result = (await hideComment(env, by, Number(target), note)) ? "comment hidden" : null;
    if (action === "unhide") result = (await unhideComment(env, by, Number(target), note)) ? "comment restored" : null;
  } else if (kind === "manuscript" && MS_ID.test(target)) {
    if (action === "remove" && confirmed) result = (await removeManuscript(env, by, target, form.get("revoke") === "yes", note)).ok ? "manuscript removed" : null;
  } else if (kind === "user" && USER_ID.test(target)) {
    if (action === "suspend") result = (await suspend(env, by, target, note)) ? "account suspended" : null;
    if (action === "unsuspend") result = (await unsuspend(env, by, target, note)) ? "account unsuspended" : null;
    if (action === "reset_name") result = (await resetName(env, by, target, note)) ? "name reset" : null;
    if (action === "hide_all" && confirmed) {
      const n = await hideAllComments(env, by, target, note);
      result = n ? `${n} comment${n === 1 ? "" : "s"} hidden` : null;
    }
  }
  if (action === "dismiss" && KINDS.includes(kind) && target) result = (await dismiss(env, by, kind, target, note)) ? "reports dismissed" : null;
  return redirect303(`${back}?done=${encodeURIComponent(result ?? "nothing changed")}`);
}

// ---------------------------------------------------------------------------------------------
// routes

const USER_RE = /^\/review\/users\/([a-z0-9-]{4,40})$/;
const COMMENT_RE = /^\/review\/comments\/(\d{1,12})$/;

export const isModerationPath = (path: string): boolean =>
  path === "/report" || path === "/review/reports" || path === "/review/act" || path === "/review/users" || USER_RE.test(path) || COMMENT_RE.test(path);

/** Open reports, for the uploads review page's link. */
export async function openReportCount(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT count(DISTINCT kind || ' ' || target) AS n FROM reports WHERE closed_at IS NULL").first<{ n: number }>())?.n ?? 0;
}

export async function handleModeration(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const isPost = req.method === "POST";
  if (!isPost && req.method !== "GET" && req.method !== "HEAD") return messagePage(env, 405, "Method not allowed", html`<p>Use the forms.</p>`, NO_STORE);
  if (path === "/report") return reportRoute(env, req, url);

  const a = await requireUser(env, req, { role: "maintainer" });
  if (isAuthFailure(a)) {
    if (a.code === "signin" && !isPost) return redirect303(`/account?next=${encodeURIComponent(path)}`);
    return messagePage(env, 403, "Maintainers only", html`<p>This page is for maintainers.</p>`, NO_STORE);
  }
  if (path === "/review/act") return isPost ? actRoute(env, req, a) : redirect303("/review/reports");
  if (isPost) return messagePage(env, 405, "Method not allowed", html`<p>Use the buttons on the page.</p>`, NO_STORE);
  if (path === "/review/reports") return reportsPage(env, url);
  if (path === "/review/users") {
    // A profile link, a review link or a bare id: the last path segment, before any ?query or #hash.
    const q = (url.searchParams.get("u") ?? "").slice(0, 300).split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
    return USER_RE.test(`/review/users/${q}`) ? redirect303(`/review/users/${q}`) : messagePage(env, 404, "No such account", html`${reviewNav()}<p>That isn’t an account link.</p>`, NO_STORE);
  }
  const um = USER_RE.exec(path);
  if (um) return userPage(env, um[1], url);
  return commentPage(env, Number(COMMENT_RE.exec(path)![1]), url);
}
