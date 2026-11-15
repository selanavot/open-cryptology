// Account pages: /account (your settings; no-store) and /u/<id> (public profile; cached like
// paper pages). Data access lives in auth.ts.
import type { Env } from "./db";
import { html, type Html, type Val } from "./html";
import { card, messagePage, page } from "./layout";
import { day } from "./pages";
import {
  type Actor,
  type Identity,
  type PublicProfile,
  loginCookie,
  LOGIN_COOKIE,
  MAX_LINKS,
  NAME_MAX,
  nameProblem,
  publicProfiles,
  redirect303,
  safeNext,
  setDisplayName,
  setUserLinks,
  userLinks,
  currentUser,
  type UserLink,
  createToken,
  listTokens,
  revokeToken,
  SCOPES,
  type TokenInfo,
  atLeast,
  bannedUsers,
  clearCookies,
  createBot,
  deleteAccounts,
  listBots,
  resolveUser,
  sameOrigin,
  setBanned,
  removeIdentity,
  signOutOthers,
  devLogin,
  PERSONAL_DOMAINS,
  PROVIDER_LABEL,
  type Provider,
} from "./auth";

const PROFILE_RE = /^\/u\/([a-z2-7]{12})\/?$/;
export const isAccountPath = (path: string): boolean => path === "/account" || PROFILE_RE.test(path);

const NO_STORE = { cache: "no-store", noindex: true } as const;
const PROVIDERS: Provider[] = ["github", "google", "orcid"];

/** One verified identity: a link for GitHub and ORCID; for Google, the email's domain when it is
 *  an institution's ("verified @mit.edu"), since Google accounts have no public page. */
export function identityLink(i: Identity): Html {
  const kind = html`<span class="ident-kind">${PROVIDER_LABEL[i.provider]}</span>`;
  if (i.provider === "google")
    return html`<span class="ident">${kind} ${PERSONAL_DOMAINS.has(i.handle) ? "account" : html`verified @${i.handle}`}</span>`;
  return html`<span class="ident">${kind} <a href="${i.url}" rel="noopener">${i.handle}</a></span>`;
}

/** Where a sign-in button points: the real provider when configured, else (local test server
 *  only) a made-up account. Null when neither is available. */
function providerHref(env: Env, p: Provider, next: string, link: boolean): string | null {
  const n = encodeURIComponent(next);
  const l = link ? "link=1&" : "";
  const real = { github: env.GITHUB_CLIENT_ID, google: env.GOOGLE_CLIENT_ID, orcid: env.ORCID_CLIENT_ID }[p];
  if (real) return `/auth/${p}?${l}next=${n}`;
  if (!devLogin(env)) return null;
  if (p === "github") return `/auth/dev-login?${l}login=dev-user&ghid=1&next=${n}`;
  if (p === "google") return `/auth/dev-google?${l}sub=1&email=dev%40example.edu&name=Dev%20User&next=${n}`;
  return `/auth/dev-orcid?${l}orcid=0000-0002-1825-0097&name=Dev%20User&next=${n}`;
}

function signInPage(env: Env, url: URL): Response {
  const next = safeNext(url.searchParams.get("next") ?? "/account");
  const buttons = PROVIDERS.map((p) => [p, providerHref(env, p, next, false)] as const).filter(([, h]) => h);
  return page(env, {
    title: "Sign in",
    ...NO_STORE,
    body: card(
      "Sign in",
      html`<p>Sign in to comment and to share results, under your own name or through an agent you run.
You can add your other accounts afterwards and sign in with any of them.</p>
${buttons.length
  ? html`<p class="acct-signin">${buttons.map(([p, h]) => html`<a class="btn btn-outline-dark" href="${h}">Sign in with ${PROVIDER_LABEL[p]}</a>`)}</p>
${devLogin(env) && html`<p class="text-muted">Local test server: buttons without a configured app sign in as made-up accounts.</p>`}`
  : html`<p class="text-muted">Sign-in isn’t switched on yet.</p>`}
<p class="form-hint text-muted">We keep the account’s id and public name (GitHub username, ORCID iD, or your Google
address’s domain), and nothing else: no email address, no password, no access to your repositories or records.
<a href="/privacy">Privacy</a></p>`,
      "account",
    ),
  });
}

function identitiesBody(env: Env, u: Actor["user"]): Html {
  const have = new Set(u.identities.map((i) => i.provider));
  const add = PROVIDERS.filter((p) => !have.has(p)).map((p) => [p, providerHref(env, p, "/account", true)] as const).filter(([, h]) => h);
  return html`<p class="text-muted">You can sign in with any of these. They’re shown next to your name.</p>
<ul class="acct-list acct-tokens">${u.identities.map(
    (i) => html`<li><form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="identity">
  <input type="hidden" name="provider" value="${i.provider}"><input type="hidden" name="pid" value="${i.providerUserId}">
  ${identityLink(i)}
  ${u.identities.length > 1 && html`<button class="btn btn-sm btn-outline-dark" name="change" value="remove">Remove</button>`}
</form></li>`,
  )}</ul>
${add.length > 0 &&
  html`<p class="mt-2 acct-signin">${add.map(([p, h]) => html`<a class="btn btn-sm btn-outline-dark" href="${h}">Add ${PROVIDER_LABEL[p]}</a>`)}</p>`}`;
}

const roleBadge = (p: { role: string; kind: string }): Val =>
  [
    p.kind === "bot" && html`<small class="badge acct-badge">bot</small>`,
    p.role === "maintainer" && html`<small class="badge acct-badge">maintainer</small>`,
  ];

// ---------------------------------------------------------------------------------------------
// /u/<id>

async function profilePage(env: Env, id: string): Promise<Response> {
  const p = (await publicProfiles(env, [id])).get(id);
  if (!p) return messagePage(env, 404, "No such account", html`<p>There’s no account with this address.</p>`);
  if (p.deleted) return messagePage(env, 410, "Deleted account", html`<p>This account was deleted. What it posted stays, credited to “deleted user”.</p>`);
  return page(env, {
    title: p.displayName,
    noindex: true,
    cache: "public, max-age=600",
    body: card(p.displayName, profileBody(p), "profile"),
  });
}

function profileBody(p: PublicProfile): Html {
  return html`<p class="profile-meta">${roleBadge(p)} Joined <time datetime="${p.createdAt}">${day(p.createdAt)}</time></p>
${p.banned && html`<p class="alert alert-warning">This account is suspended.</p>`}
${p.owner && html`<p>An automated account, operated by <a href="/u/${p.owner.id}">${p.owner.displayName}</a>. What it posts is labelled agent-made.</p>`}
${p.identities.length
  ? html`<h4 class="acct-h">Verified</h4>
<ul class="acct-list">${p.identities.map((i) => html`<li>${identityLink(i)}</li>`)}</ul>`
  : ""}
${p.links.length
  ? html`<h4 class="acct-h">Links <span class="unverified">(self-reported, unverified)</span></h4>
<ul class="acct-list">${p.links.map((l) => html`<li><a href="${l.url}" rel="nofollow ugc noopener">${l.label}</a></li>`)}</ul>`
  : ""}`;
}

// ---------------------------------------------------------------------------------------------
// /account

const SAVED: Record<string, string> = {
  name: "Your name was saved.",
  links: "Your links were saved.",
  revoked: "The token was revoked. Agents using it are signed out.",
  bot: "Bot created. Give it a token below.",
  "bot-deleted": "The bot was deleted; what it posted stays, credited to “deleted user”.",
  banned: "The account is suspended.",
  unbanned: "The suspension was lifted.",
  linked: "The account was added. You can sign in with it too.",
  identity: "The sign-in was removed, and your other browsers were signed out.",
  sessions: "Your other browsers were signed out.",
};

const SCOPE_LABEL: Record<string, string> = { comment: "comment", upload: "upload results" };


interface Notice {
  ok?: string;
  err?: string;
  token?: { secret: string; name: string };
}

const when = (iso: string | null) => (iso ? html`<time datetime="${iso}">${day(iso)}</time>` : "never");

function tokensCard(tokens: TokenInfo[], names: Map<string, string>, created?: Notice["token"]): Html {
  return card(
    "Agent tokens",
    html`<p>Let an AI agent post for you. What it posts is labelled agent-made, credited to you, and never presented as
your own writing. Agents send <code>Authorization: Bearer &lt;token&gt;</code>; see <a href="/llms.txt">llms.txt</a>.</p>
${created &&
html`<div class="upload-notice upload-notice-ok" role="status">
  <p class="mb-1">New token “${created.name}”. Copy it now: it won’t be shown again.</p>
  <p class="mb-0"><code id="new-token" class="token-secret">${created.secret}</code>
  <button type="button" class="btn btn-sm btn-outline-dark" data-copy="new-token"><span>Copy</span></button></p>
</div>`}
${tokens.length
  ? html`<ul class="acct-list acct-tokens">${tokens.map(
      (t) => html`<li><form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="token-revoke"><input type="hidden" name="id" value="${t.id}">
  <strong>${t.name}</strong>${names.size > 1 ? html` <span class="text-muted">as ${names.get(t.user_id)}</span>` : ""}
  <span class="text-muted">· may ${t.scopes.split(" ").map((s) => SCOPE_LABEL[s] ?? s).join(", ")} · created ${when(t.created_at)} · last used ${when(t.last_used)}</span>
  <button class="btn btn-sm btn-outline-dark" type="submit">Revoke</button>
</form></li>`,
    )}</ul>`
  : html`<p class="text-muted">No tokens yet.</p>`}
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="token-create">
  ${names.size > 1 &&
  html`<label class="form-label mb-1" for="token-for">Acts as</label>
  <select class="form-select form-select-sm mb-1" id="token-for" name="for">${[...names].map(([id, n]) => html`<option value="${id}">${n}</option>`)}</select>`}
  <label class="form-label mb-1" for="token-name">New token</label>
  <div class="input-group">
    <input class="form-control form-control-sm" id="token-name" name="name" placeholder="e.g. my Claude agent" maxlength="60" required>
    <button class="btn btn-sm btn-outline-dark" type="submit">Create token</button>
  </div>
  <p class="form-hint">May: ${SCOPES.map((s) => html`<label class="acct-check"><input type="checkbox" name="scope" value="${s}" checked> ${SCOPE_LABEL[s]}</label> `)}</p>
</form>`,
    "account",
  );
}


/** The accounts this user manages tokens for: themself and the bots they run. */
async function managed(env: Env, a: Actor): Promise<Map<string, string>> {
  const bots = await listBots(env, a.user.id);
  return new Map([[a.user.id, a.user.displayName], ...bots.map((b) => [b.id, `${b.display_name} (bot)`] as [string, string])]);
}

/** Maintainers: bot accounts and bans. */
async function moderationCard(env: Env, a: Actor): Promise<Html> {
  const [bots, banned] = await Promise.all([listBots(env, a.user.id), bannedUsers(env)]);
  return card(
    "Moderation",
    html`<h4 class="acct-h">Bots you run</h4>
<p class="text-muted">Automated accounts, such as an AI reviewer. A bot can’t sign in; give it a token in “Agent tokens” above.
Its profile says it is operated by you.</p>
${bots.length
  ? html`<ul class="acct-list">${bots.map(
      (b) => html`<li><form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="bot-delete"><input type="hidden" name="id" value="${b.id}">
  <a href="/u/${b.id}">${b.display_name}</a>
  <button class="btn btn-sm btn-outline-dark" type="submit">Delete bot</button>
</form></li>`,
    )}</ul>`
  : ""}
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="bot-create">
  <div class="input-group">
    <input class="form-control form-control-sm" name="name" placeholder="Bot name, e.g. Open Cryptology reviewer" maxlength="${NAME_MAX * 2}" required aria-label="Bot name">
    <button class="btn btn-sm btn-outline-dark" type="submit">Create bot</button>
  </div>
</form>
<h4 class="acct-h">Suspend an account</h4>
<p class="text-muted">A suspended account can’t post or change its profile, and its tokens stop working.</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="ban">
  <div class="input-group">
    <input class="form-control form-control-sm" name="user" placeholder="Profile link or GitHub username" required aria-label="Account to suspend">
    <button class="btn btn-sm btn-outline-dark" type="submit">Suspend</button>
  </div>
</form>
${banned.length
  ? html`<ul class="acct-list mt-2">${banned.map(
      (b) => html`<li><form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="unban"><input type="hidden" name="id" value="${b.id}">
  ${b.deleted
    ? html`<span>deleted account <code>${b.id}</code></span> <span class="text-muted">suspended, then deleted: its sign-ins stay blocked</span>`
    : html`<a href="/u/${b.id}">${b.display_name}</a> <span class="text-muted">suspended</span>`}
  <button class="btn btn-sm btn-outline-dark" type="submit">Lift suspension</button>
</form></li>`,
    )}</ul>`
  : ""}`,
    "account",
  );
}

function deleteCard(): Html {
  return card(
    "Delete your account",
    html`<p>This signs you out everywhere, removes your sign-ins, links, tokens and any bots you run, and frees your name.
What you posted stays, credited to “deleted user”. It can’t be undone.</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="delete">
  <label class="acct-check"><input type="checkbox" name="confirm" value="yes" required> I understand, delete my account</label>
  <button class="btn btn-sm btn-outline-dark" type="submit">Delete account</button>
</form>`,
    "account",
  );
}

async function accountPage(env: Env, a: Actor, notice: Notice, status = 200): Promise<Response> {
  const u = a.user;
  const names = await managed(env, a);
  const [links, tokens] = await Promise.all([userLinks(env, u.id), listTokens(env, [...names.keys()])]);
  const rows: UserLink[] = [...links, ...Array(Math.max(0, MAX_LINKS - links.length)).fill({ label: "", url: "" })].slice(0, MAX_LINKS);
  const body = html`${notice.ok && html`<p class="upload-notice upload-notice-ok" role="status">${notice.ok}</p>`}
${notice.err && html`<p class="upload-notice upload-notice-err" role="alert">${notice.err}</p>`}
${card(
  "Your account",
  html`<p>Signed in as <a href="/u/${u.id}"><strong>${u.displayName}</strong></a> ${roleBadge(u)}
<span class="text-muted">(your public profile)</span></p>
${u.banned && html`<p class="alert alert-warning">This account is suspended: it can’t post or change its profile.</p>`}
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="name">
  <label class="form-label mb-1" for="name">Display name</label>
  <div class="input-group">
    <input class="form-control form-control-sm" id="name" name="name" value="${u.displayName}" maxlength="${NAME_MAX * 2}" required autocomplete="nickname">
    <button class="btn btn-sm btn-outline-dark" type="submit">Save</button>
  </div>
  <p class="form-hint text-muted">Shown next to everything you post, together with your verified sign-ins.</p>
</form>`,
  "account",
)}
${card("Verified sign-ins", identitiesBody(env, u), "account")}
${card(
  "Links",
  html`<p class="text-muted">Your homepage, DBLP or Google Scholar. Shown on your profile marked “unverified”.</p>
<form method="post" action="/account" class="acct-form">
  <input type="hidden" name="action" value="links">
  ${rows.map(
    (l, i) => html`<div class="acct-link-row">
    <input class="form-control form-control-sm acct-link-label" name="label${i}" value="${l.label}" placeholder="Label" maxlength="40" aria-label="Link ${i + 1} label">
    <input class="form-control form-control-sm" name="url${i}" value="${l.url}" placeholder="https://" maxlength="300" aria-label="Link ${i + 1} address">
  </div>`,
  )}
  <button class="btn btn-sm btn-outline-dark" type="submit">Save links</button>
</form>`,
  "account",
)}
${tokensCard(tokens, names, notice.token)}
${atLeast(u, "maintainer") && (await moderationCard(env, a))}
${deleteCard()}
<div class="acct-signout">
<form method="post" action="/auth/logout" class="acct-inline">
  <input type="hidden" name="next" value="/">
  <button class="btn btn-sm btn-outline-dark" type="submit">Sign out</button>
</form>
<form method="post" action="/account" class="acct-inline">
  <input type="hidden" name="action" value="sessions">
  <button class="btn btn-sm btn-outline-dark" type="submit">Sign out other browsers</button>
</form>
</div>`;
  return page(env, { title: "Your account", status, ...NO_STORE, body });
}

async function accountPost(env: Env, req: Request): Promise<Response> {
  if (!sameOrigin(req, env)) return messagePage(env, 403, "Rejected", html`<p>Cross-site requests aren’t accepted.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  if (!a) return redirect303("/account");
  if (a.via !== "session") return messagePage(env, 403, "Browser only", html`<p>Account settings can only be changed in a browser, not with a token.</p>`, NO_STORE);
  const form = await req.formData();
  const action = form.get("action")?.toString();
  if (action === "delete") {
    if (form.get("confirm") !== "yes") return accountPage(env, a, { err: "Tick the box to confirm." }, 400);
    await deleteAccounts(env, [a.user.id]);
    return redirect303("/?account=deleted", clearCookies());
  }
  // A suspended account can still delete itself, and nothing else.
  if (a.user.banned) return accountPage(env, a, { err: "This account is suspended." }, 403);
  if (action === "identity") {
    if (form.get("change") !== "remove") return accountPage(env, a, { err: "Unknown change." }, 400);
    const problem = await removeIdentity(env, a.user, form.get("provider")?.toString() ?? "", form.get("pid")?.toString() ?? "", a.sessionId);
    return problem ? accountPage(env, a, { err: problem }, 400) : redirect303(`/account?saved=identity`);
  }
  if (action === "sessions") {
    await signOutOthers(env, a.user.id, a.sessionId);
    return redirect303("/account?saved=sessions");
  }
  const maint = atLeast(a.user, "maintainer");
  if (action === "bot-create" || action === "bot-delete" || action === "ban" || action === "unban") {
    if (!maint) return accountPage(env, a, { err: "Only maintainers can do that." }, 403);
    if (action === "bot-create") {
      const r = await createBot(env, a.user.id, form.get("name")?.toString() ?? "");
      return "problem" in r ? accountPage(env, a, { err: r.problem }, 400) : redirect303("/account?saved=bot");
    }
    if (action === "bot-delete") {
      const id = form.get("id")?.toString() ?? "";
      if (!(await listBots(env, a.user.id)).some((b) => b.id === id)) return accountPage(env, a, { err: "No such bot." }, 404);
      await deleteAccounts(env, [id]);
      return redirect303("/account?saved=bot-deleted");
    }
    if (action === "ban") {
      const t = await resolveUser(env, form.get("user")?.toString() ?? "");
      if (t === "ambiguous") return accountPage(env, a, { err: "Several accounts have had that GitHub username. Paste the profile link instead." }, 409);
      if (!t) return accountPage(env, a, { err: "No such account." }, 404);
      if (t.role === "maintainer") return accountPage(env, a, { err: "Maintainers can’t be suspended here." }, 400);
      await setBanned(env, t.id, true);
      return redirect303("/account?saved=banned");
    }
    await setBanned(env, form.get("id")?.toString() ?? "", false);
    return redirect303("/account?saved=unbanned");
  }
  if (action === "token-create") {
    const names = await managed(env, a);
    const forId = form.get("for")?.toString() ?? a.user.id;
    if (!names.has(forId)) return accountPage(env, a, { err: "You can’t create tokens for that account." }, 403);
    const name = form.get("name")?.toString() ?? "";
    const r = await createToken(env, forId, name, form.getAll("scope").map(String));
    if ("problem" in r) return accountPage(env, a, { err: r.problem }, 400);
    return accountPage(env, a, { token: { secret: r.token, name: name.trim() } });
  }
  if (action === "token-revoke") {
    const ok = await revokeToken(env, form.get("id")?.toString() ?? "", [...(await managed(env, a)).keys()]);
    return ok ? redirect303("/account?saved=revoked") : accountPage(env, a, { err: "No such token." }, 404);
  }
  if (action === "name") {
    const name = form.get("name")?.toString() ?? "";
    const problem = await nameProblem(env, a.user.id, name);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    const stored = await setDisplayName(env, a.user.id, name);
    return redirect303("/account?saved=name", [loginCookie(stored)]);
  }
  if (action === "links") {
    const links: UserLink[] = [];
    for (let i = 0; i < MAX_LINKS; i++) links.push({ label: form.get(`label${i}`)?.toString() ?? "", url: form.get(`url${i}`)?.toString() ?? "" });
    const problem = await setUserLinks(env, a.user.id, links);
    if (problem) return accountPage(env, a, { err: problem }, 400);
    return redirect303("/account?saved=links");
  }
  return accountPage(env, a, { err: "Unknown action." }, 400);
}

export async function handleAccount(req: Request, env: Env, url: URL): Promise<Response> {
  const pm = PROFILE_RE.exec(url.pathname);
  const isGet = req.method === "GET" || req.method === "HEAD";
  if (pm) {
    if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>Profiles are read-only.</p>`);
    return profilePage(env, pm[1]);
  }
  if (req.method === "POST") return accountPost(env, req);
  if (!isGet) return messagePage(env, 405, "Method not allowed", html`<p>Use the forms on this page.</p>`, NO_STORE);
  const a = await currentUser(env, req);
  // Settings are for browsers: a token (an agent) gets the sign-in page, not the account page.
  if (!a || a.via !== "session") {
    const res = signInPage(env, url);
    // The session expired (or was revoked) but the navbar's display cookie remains: clear it.
    if (req.headers.get("cookie")?.includes(`${LOGIN_COOKIE}=`)) res.headers.append("set-cookie", `${LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
    return res;
  }
  return accountPage(env, a, { ok: SAVED[url.searchParams.get("saved") ?? ""] });
}
