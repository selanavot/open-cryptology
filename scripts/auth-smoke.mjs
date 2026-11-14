#!/usr/bin/env node
// End-to-end checks for accounts (worker/src/auth.ts) against a local `wrangler dev` with
// AUTH_DEV_LOGIN=1 in worker/.dev.vars. It writes users to the local D1, so run the server on a
// private copy of the local state:
//   DEV_STATE=copy npm --prefix worker run dev -- --port 8788
//   node scripts/auth-smoke.mjs http://localhost:8788
// Each run uses fresh made-up GitHub ids, so it can be repeated.
const BASE = (process.argv[2] ?? "http://localhost:8788").replace(/\/$/, "");
const RUN = Date.now() % 1e9;
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failed++;
}

/** A tiny browser: keeps cookies, sends Origin on POSTs like a real one. */
class Client {
  jar = new Map();
  async req(path, { method = "GET", form, headers = {}, origin = BASE, raw } = {}) {
    const h = new Headers(headers);
    if (this.jar.size) h.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body;
    if (form) {
      body = new URLSearchParams(form);
      h.set("content-type", "application/x-www-form-urlencoded");
    }
    if (raw !== undefined) body = raw;
    if (method !== "GET" && origin) h.set("origin", origin);
    const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || v === "") this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async json(path, opts) {
    const r = await this.req(path, opts);
    return { status: r.status, body: await r.json().catch(() => null), res: r };
  }
  login(login, ghid, next = "/") {
    return this.req(`/auth/dev-login?login=${login}&ghid=${ghid}&next=${encodeURIComponent(next)}`);
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------------------------------- step 1
test("signed out: /api/me is 401", async () => {
  const c = new Client();
  const r = await c.json("/api/me");
  check("401", r.status === 401, r.status);
  check("error code signin", r.body?.error === "signin");
  check("no-store", r.res.headers.get("cache-control") === "no-store");
});

test("dev login creates a user and a session", async () => {
  const c = new Client();
  const login = `alice${RUN}`;
  const r = await c.login(login, 900000 + (RUN % 1e5), "/2024/1");
  check("303 to next", r.status === 303 && r.headers.get("location") === "/2024/1", `${r.status} ${r.headers.get("location")}`);
  const sc = r.headers.getSetCookie().join("\n");
  check("session cookie is HttpOnly, Secure, SameSite=Lax", /__Host-oc_session=[^;]+;[^\n]*HttpOnly[^\n]*Secure[^\n]*SameSite=Lax/.test(sc), sc);
  check("oc_login cookie carries the display name", c.jar.get("oc_login") === encodeURIComponent(login));
  const me = await c.json("/api/me");
  check("/api/me 200", me.status === 200, me.status);
  check("display name = login", me.body?.user?.displayName === login);
  check("via session", me.body?.via === "session");
  const gh = me.body?.user?.identities?.[0];
  check("github identity with url and created_at", gh?.provider === "github" && gh.url === `https://github.com/${login}` && !!gh.providerCreatedAt, JSON.stringify(gh));
  check("role member", me.body?.user?.role === "member");
});

test("signing in again finds the same user (by numeric id, not login)", async () => {
  const ghid = 910000 + (RUN % 1e5);
  const a = new Client();
  await a.login(`bob${RUN}`, ghid);
  const id1 = (await a.json("/api/me")).body?.user?.id;
  const b = new Client();
  await b.login(`bobrenamed${RUN}`, ghid);
  const me = (await b.json("/api/me")).body?.user;
  check("same user id", me?.id === id1, `${me?.id} vs ${id1}`);
  check("handle refreshed", me?.identities?.[0]?.handle === `bobrenamed${RUN}`);
});

test("next= only accepts same-origin paths", async () => {
  const c = new Client();
  for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    const r = await c.login(`n${RUN}`, 920000 + (RUN % 1e5), bad);
    check(`next=${bad} -> /`, r.headers.get("location") === "/", r.headers.get("location"));
  }
});

test("logout: needs POST from our origin, then the session is gone", async () => {
  const c = new Client();
  await c.login(`carol${RUN}`, 930000 + (RUN % 1e5));
  const session = c.jar.get("__Host-oc_session");
  const cross = await c.req("/auth/logout", { method: "POST", form: { next: "/" }, origin: "https://evil.example" });
  check("cross-site logout refused", cross.status === 403, cross.status);
  check("still signed in", (await c.json("/api/me")).status === 200);
  const r = await c.req("/auth/logout", { method: "POST", form: { next: "/2024/1" } });
  check("303 to next", r.status === 303 && r.headers.get("location") === "/2024/1");
  check("cookies cleared", !c.jar.has("__Host-oc_session") && !c.jar.has("oc_login"));
  const replay = new Client();
  replay.jar.set("__Host-oc_session", session);
  check("old session token no longer works", (await replay.json("/api/me")).status === 401);
});

test("a forged session cookie is rejected", async () => {
  const c = new Client();
  c.jar.set("__Host-oc_session", "not-a-real-token");
  check("401", (await c.json("/api/me")).status === 401);
});

test("GitHub sign-in without a configured app explains itself", async () => {
  const r = await new Client().req("/auth/github?next=/");
  // 303 to github.com when GITHUB_CLIENT_ID is set locally, else a 503 page.
  const loc = r.headers.get("location") ?? "";
  const ok = r.status === 503 || (r.status === 303 && loc.startsWith("https://github.com/login/oauth/authorize?") && /code_challenge_method=S256/.test(loc));
  check("503 page or PKCE redirect to GitHub", ok, `${r.status} ${loc}`);
});

test("callback without our state cookie is refused", async () => {
  const r = await new Client().req("/auth/github/callback?code=x&state=y");
  check("400", r.status === 400, r.status);
});

// ------------------------------------------------------------------------------------------- step 2
const form = (c, fields) => c.req("/account", { method: "POST", form: fields });

test("/account: sign-in page when signed out, settings when signed in", async () => {
  const out = await new Client().req("/account?next=/2024/1");
  const t = await out.text();
  check("signed-out page says Sign in", out.status === 200 && /Sign in/.test(t));
  check("no-store", out.headers.get("cache-control") === "no-store");
  const c = new Client();
  await c.login(`dora${RUN}`, 940000 + (RUN % 1e5));
  const r = await c.req("/account");
  const body = await r.text();
  check("settings page shows the name", r.status === 200 && body.includes(`dora${RUN}`));
  check("settings page no-store", r.headers.get("cache-control") === "no-store");
});

test("display name rules", async () => {
  const a = new Client();
  await a.login(`erin${RUN}`, 950000 + (RUN % 1e5));
  const b = new Client();
  await b.login(`frank${RUN}`, 960000 + (RUN % 1e5));
  let r = await form(a, { action: "name", name: `  Erin   Example ${RUN} ` });
  check("valid name saved (303)", r.status === 303, r.status);
  check("oc_login updated", decodeURIComponent(a.jar.get("oc_login") ?? "") === `Erin Example ${RUN}`);
  const me = (await a.json("/api/me")).body?.user;
  check("whitespace normalized", me?.displayName === `Erin Example ${RUN}`, me?.displayName);
  r = await form(b, { action: "name", name: `ERIN EXAMPLE ${RUN}` });
  check("name taken (case-insensitive) -> 400", r.status === 400 && /already uses/.test(await r.text()), r.status);
  r = await form(b, { action: "name", name: `erin${RUN}` });
  check("someone else's GitHub login -> 400", r.status === 400 && /GitHub username/.test(await r.text()), r.status);
  for (const bad of ["deleted user", "user-abcdefghijkl", "<script>", "x".repeat(41), ""]) {
    r = await form(b, { action: "name", name: bad });
    check(`rejected: ${JSON.stringify(bad.slice(0, 20))}`, r.status === 400, r.status);
  }
  r = await form(b, { action: "name", name: `Frank Ünïcødé ${RUN}` });
  check("unicode letters ok", r.status === 303, r.status);
  r = await c_cross(b);
  check("cross-site name change refused", r.status === 403, r.status);
});
const c_cross = (c) => c.req("/account", { method: "POST", form: { action: "name", name: "Mallory" }, origin: "https://evil.example" });

test("a GitHub login's owner gets their name back from a squatter", async () => {
  const squatter = new Client();
  await squatter.login(`sq${RUN}`, 970000 + (RUN % 1e5));
  const victim = `victim${RUN}`;
  await form(squatter, { action: "name", name: victim });
  check("squatter took the name", (await squatter.json("/api/me")).body?.user?.displayName === victim);
  const v = new Client();
  await v.login(victim, 980000 + (RUN % 1e5));
  check("owner gets their login as name", (await v.json("/api/me")).body?.user?.displayName === victim);
  const sname = (await squatter.json("/api/me")).body?.user?.displayName;
  check("squatter renamed to user-<id>", /^user-[a-z2-7]{12}$/.test(sname), sname);
});

test("links: saved, validated, shown as unverified on the cached profile", async () => {
  const c = new Client();
  await c.login(`gail${RUN}`, 990000 + (RUN % 1e5));
  let r = await form(c, { action: "links", label0: "Homepage", url0: "example.org/~gail", label1: "", url1: "https://dblp.org/pid/1" });
  check("saved", r.status === 303, r.status);
  r = await form(c, { action: "links", label0: "x", url0: "javascript:alert(1)" });
  check("javascript: refused", r.status === 400, r.status);
  const id = (await c.json("/api/me")).body?.user?.id;
  const p = await new Client().req(`/u/${id}`);
  const t = await p.text();
  check("profile 200, publicly cached", p.status === 200 && p.headers.get("cache-control") === "public, max-age=600", `${p.status} ${p.headers.get("cache-control")}`);
  check("profile is noindex", /<meta name="robots" content="noindex">/.test(t));
  check("https added, label kept", t.includes('href="https://example.org/~gail"') && t.includes(">Homepage<"));
  check("blank label -> host", t.includes(">dblp.org<"));
  check("links are nofollow ugc", /rel="nofollow ugc noopener"/.test(t));
  check("marked unverified", /unverified/.test(t));
  check("verified GitHub link shown", t.includes(`https://github.com/gail${RUN}`) && /on GitHub since 2015/.test(t));
  check("unknown profile 404", (await new Client().req("/u/aaaaaaaaaaaa")).status === 404);
});

test("navbar renders the static Sign in link (app.js swaps in the name)", async () => {
  const t = await (await new Client().req("/")).text();
  check("nav-account link", /class="nav-account">Sign in</.test(t));
});

// ------------------------------------------------------------------------------------------- step 3
async function newToken(c, name = "agent", scopes = ["comment", "upload"], forId) {
  const f = new URLSearchParams({ action: "token-create", name });
  for (const s of scopes) f.append("scope", s);
  if (forId) f.set("for", forId);
  const r = await c.req("/account", { method: "POST", raw: f.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const t = await r.text();
  return { status: r.status, token: /id="new-token"[^>]*>(oct_[A-Za-z0-9_-]+)</.exec(t)?.[1], html: t };
}
const bearer = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });

test("tokens: create, use, scopes, revoke", async () => {
  const c = new Client();
  await c.login(`hank${RUN}`, 1000000 + (RUN % 1e5));
  const { status, token } = await newToken(c, "my agent", ["comment"]);
  check("created, shown once", status === 200 && /^oct_[A-Za-z0-9_-]{43}$/.test(token ?? ""), status);
  const page = await (await c.req("/account")).text();
  check("secret not shown again", !page.includes(token) && page.includes("my agent"));
  const agent = new Client();
  const me = await agent.json("/api/me", bearer(token));
  check("bearer works", me.status === 200 && me.body?.via === "token", me.status);
  check("scopes reported", JSON.stringify(me.body?.scopes) === '["comment"]', JSON.stringify(me.body?.scopes));
  check("same user", me.body?.user?.displayName === `hank${RUN}`);
  const viaToken = await agent.req("/account", { method: "POST", form: { action: "name", name: "Agent Smith" }, origin: null, ...bearer(token) });
  check("tokens can't change account settings", viaToken.status === 403, viaToken.status);
  check("garbage bearer -> 401", (await agent.json("/api/me", bearer("oct_nope"))).status === 401);
  const id = /name="id" value="([a-z2-7]{12})"/.exec(page)?.[1];
  const other = new Client();
  await other.login(`ivy${RUN}`, 1010000 + (RUN % 1e5));
  const steal = await other.req("/account", { method: "POST", form: { action: "token-revoke", id } });
  check("someone else can't revoke it", steal.status === 404, steal.status);
  const rv = await c.req("/account", { method: "POST", form: { action: "token-revoke", id } });
  check("revoked (303)", rv.status === 303, rv.status);
  check("revoked token -> 401", (await agent.json("/api/me", bearer(token))).status === 401);
});

test("tokens: need a name and a scope", async () => {
  const c = new Client();
  await c.login(`jo${RUN}`, 1020000 + (RUN % 1e5));
  check("no scope -> 400", (await newToken(c, "x", [])).status === 400);
  check("no name -> 400", (await newToken(c, "   ")).status === 400);
});

// ------------------------------------------------------------------------------------------- step 4
// Needs MAINTAINER_GITHUB_IDS=4242 in worker/.dev.vars.
const MAINT_GHID = 4242;

test("bots: maintainers create them, give them tokens, delete them", async () => {
  const m = new Client();
  await m.login(`maint${RUN}`, MAINT_GHID);
  const me = (await m.json("/api/me")).body?.user;
  check("maintainer role from MAINTAINER_GITHUB_IDS", me?.role === "maintainer", me?.role);
  let r = await form(m, { action: "bot-create", name: `Reviewer ${RUN}` });
  check("bot created", r.status === 303, r.status);
  const page = await (await m.req("/account")).text();
  const botId = /action" value="bot-delete"><input type="hidden" name="id" value="([a-z2-7]{12})"/.exec(page)?.[1];
  check("bot listed", !!botId);
  const { token } = await newToken(m, "reviewer key", ["comment"], botId);
  const bot = await new Client().json("/api/me", bearer(token));
  check("token acts as the bot", bot.body?.user?.kind === "bot" && bot.body?.user?.displayName === `Reviewer ${RUN}`, JSON.stringify(bot.body?.user));
  check("bot shows its owner", bot.body?.user?.owner?.id === me?.id);
  const prof = await (await new Client().req(`/u/${botId}`)).text();
  check("bot profile: operated by", /operated by/.test(prof) && prof.includes(`/u/${me?.id}`));
  const member = new Client();
  await member.login(`kim${RUN}`, 1030000 + (RUN % 1e5));
  r = await form(member, { action: "bot-create", name: `Kimbot ${RUN}` });
  check("members can't create bots", r.status === 403, r.status);
  const { status } = await newToken(member, "x", ["comment"], botId);
  check("members can't create tokens for someone's bot", status === 403, status);
  r = await form(m, { action: "bot-delete", id: botId });
  check("bot deleted", r.status === 303, r.status);
  check("its token stops working", (await new Client().json("/api/me", bearer(token))).status === 401);
  check("bot profile is a tombstone (410)", (await new Client().req(`/u/${botId}`)).status === 410);
});

test("bans: a suspended account is refused, and can be lifted", async () => {
  const m = new Client();
  await m.login(`maint${RUN}`, MAINT_GHID);
  const u = new Client();
  await u.login(`lou${RUN}`, 1040000 + (RUN % 1e5));
  const { token } = await newToken(u, "agent");
  let r = await form(m, { action: "ban", user: `@lou${RUN}` });
  check("banned by GitHub login", r.status === 303, r.status);
  const me = (await u.json("/api/me")).body?.user;
  check("/api/me says banned", me?.banned === true);
  r = await form(u, { action: "name", name: `Lou ${RUN}` });
  check("banned user can't rename", r.status === 403, r.status);
  check("profile says suspended", /suspended/.test(await (await new Client().req(`/u/${me?.id}`)).text()));
  r = await form(m, { action: "ban", user: `maint${RUN}` });
  check("can't ban a maintainer", r.status === 400, r.status);
  r = await form(m, { action: "unban", id: me?.id });
  check("unbanned", r.status === 303 && (await u.json("/api/me")).body?.user?.banned === false);
  check("token still fine after unban", (await new Client().json("/api/me", bearer(token))).status === 200);
});

test("deleting an account leaves a tombstone and frees the name", async () => {
  const c = new Client();
  const login = `mo${RUN}`;
  await c.login(login, 1050000 + (RUN % 1e5));
  await form(c, { links: 1, action: "links", label0: "Home", url0: "https://example.org" });
  const id = (await c.json("/api/me")).body?.user?.id;
  const { token } = await newToken(c, "agent");
  let r = await form(c, { action: "delete" });
  check("needs the confirmation box", r.status === 400, r.status);
  r = await form(c, { action: "delete", confirm: "yes" });
  check("deleted, signed out", r.status === 303 && !c.jar.has("__Host-oc_session"), r.status);
  check("token revoked", (await new Client().json("/api/me", bearer(token))).status === 401);
  check("profile 410", (await new Client().req(`/u/${id}`)).status === 410);
  const again = new Client();
  await again.login(login, 1050000 + (RUN % 1e5));
  const me2 = (await again.json("/api/me")).body?.user;
  check("same GitHub account signs up fresh, with its name back", me2?.id !== id && me2?.displayName === login, `${me2?.id} ${me2?.displayName}`);
});

// ------------------------------------------------------------------------------------------- step 5
const orcidOf = (n) => {
  // A made-up but well-formed iD (ISO 7064 check digit), unique per run.
  const base = String(RUN * 10 + n).padStart(15, "0").slice(-15);
  let t = 0;
  for (const d of base) t = (t + Number(d)) * 2;
  const r = (12 - (t % 11)) % 11;
  const s = base + (r === 10 ? "X" : String(r));
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
};
const devOrcid = (c, orcid, name = "", next = "/account") =>
  c.req(`/auth/dev-orcid?orcid=${orcid}&name=${encodeURIComponent(name)}&next=${encodeURIComponent(next)}`);
const identityForm = (c, provider, pid, change) => form(c, { action: "identity", provider, pid, change });

test("ORCID: link to a GitHub account, then sign in with either", async () => {
  const c = new Client();
  const ghid = 1060000 + (RUN % 1e5);
  await c.login(`nia${RUN}`, ghid);
  const orcid = orcidOf(1);
  const r = await devOrcid(c, orcid);
  check("linked (303 /account?saved=orcid)", r.status === 303 && r.headers.get("location") === "/account?saved=orcid", `${r.status} ${r.headers.get("location")}`);
  const me = (await c.json("/api/me")).body?.user;
  const oi = me?.identities?.find((i) => i.provider === "orcid");
  check("orcid identity: handle = iD, url", oi?.handle === orcid && oi?.url === `https://orcid.org/${orcid}`, JSON.stringify(oi));
  const viaOrcid = new Client();
  await devOrcid(viaOrcid, orcid, "Someone Else");
  check("signing in with the ORCID iD reaches the same account", (await viaOrcid.json("/api/me")).body?.user?.id === me?.id);
  const other = new Client();
  await other.login(`otto${RUN}`, 1070000 + (RUN % 1e5));
  const steal = await devOrcid(other, orcid);
  check("an iD linked elsewhere can't be linked again (409)", steal.status === 409, steal.status);
});

test("ORCID-only accounts", async () => {
  const c = new Client();
  const orcid = orcidOf(2);
  await devOrcid(c, orcid, `Wang Fang ${RUN}`, "/2024/1");
  const me = (await c.json("/api/me")).body?.user;
  check("account created, named from ORCID", me?.displayName === `Wang Fang ${RUN}`, me?.displayName);
  check("only identity is ORCID", me?.identities?.length === 1 && me.identities[0].provider === "orcid");
  const d = new Client();
  await devOrcid(d, orcidOf(3), `Wang Fang ${RUN}`);
  check("a taken ORCID name falls back to user-<id>", /^user-[a-z2-7]{12}$/.test((await d.json("/api/me")).body?.user?.displayName ?? ""));
});

test("identity visibility: hide, show, remove; one stays public", async () => {
  const c = new Client();
  const ghid = String(1080000 + (RUN % 1e5));
  await c.login(`pia${RUN}`, Number(ghid));
  let r = await identityForm(c, "github", ghid, "hide");
  check("can't hide the only public sign-in", r.status === 400, r.status);
  r = await identityForm(c, "github", ghid, "remove");
  check("can't remove the only sign-in", r.status === 400, r.status);
  const orcid = orcidOf(4);
  await devOrcid(c, orcid);
  r = await identityForm(c, "github", ghid, "hide");
  check("GitHub hidden once ORCID is public", r.status === 303, r.status);
  const id = (await c.json("/api/me")).body?.user?.id;
  const prof = await (await new Client().req(`/u/${id}`)).text();
  check("profile shows ORCID, not GitHub", prof.includes(orcid) && !prof.includes(`github.com/pia${RUN}`));
  r = await identityForm(c, "orcid", orcid, "hide");
  check("can't hide the last public one", r.status === 400, r.status);
  r = await identityForm(c, "github", ghid, "show");
  check("show again", r.status === 303, r.status);
  r = await identityForm(c, "orcid", orcid, "remove");
  check("ORCID removed", r.status === 303 && !(await c.json("/api/me")).body?.user?.identities?.some((i) => i.provider === "orcid"));
  r = await identityForm(c, "github", "1", "hide");
  check("someone else's identity: refused", r.status === 400, r.status);
});

// ------------------------------------------------------------------------------------------------
for (const [name, fn] of tests) {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (e) {
    check("threw", false, e?.stack ?? String(e));
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
