// Account emails (auth.ts, identity_emails): each sign-in's verified email is kept, refreshed at
// sign-in, shown only to its owner on /account, and deleted with the account.
// Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { testWorker, type Who } from "./harness";
import { githubEmail, orcidEmail } from "../src/auth";

const ADA = "0000-0002-1825-0097";
const dev = () => testWorker({ AUTH_DEV_LOGIN: "1", AUTH_ORIGIN: "http://localhost:8788" });
type T = Awaited<ReturnType<typeof dev>>;

/** Follow a dev sign-in route; returns the session it started (or the one passed in, when linking). */
async function signIn(t: T, path: string, who?: Who): Promise<Who> {
  const r = await t.get(path, who, who ? { "sec-fetch-site": "same-origin" } : {});
  assert.equal(r.status, 303, await r.clone().text());
  const c = r.headers.getSetCookie().find((x) => x.startsWith("__Host-oc_session="));
  return c ? { id: "", cookie: c.split(";")[0] } : who!;
}

const emails = (t: T) =>
  (t.d1.db.prepare("SELECT provider, email FROM identity_emails ORDER BY provider").all() as { provider: string; email: string }[]).map(
    (r) => `${r.provider}:${r.email}`,
  );

test("githubEmail takes the primary email only if verified", () => {
  assert.equal(githubEmail([{ email: "x@a.test", primary: false, verified: true }, { email: "Ada@B.test", primary: true, verified: true }]), "ada@b.test");
  assert.equal(githubEmail([{ email: "ada@b.test", primary: true, verified: false }]), null);
  assert.equal(githubEmail({ message: "Not Found" }), null);
});

test("orcidEmail takes a verified public email, the primary one first", () => {
  const e = (email: string, primary: boolean, verified = true) => ({ email, primary, verified, visibility: "public" });
  assert.equal(orcidEmail({ email: [e("other@a.test", false), e("Ada@Uni.test", true)] }), "ada@uni.test");
  assert.equal(orcidEmail({ email: [e("other@a.test", false)] }), "other@a.test");
  assert.equal(orcidEmail({ email: [e("ada@uni.test", true, false)] }), null);
  assert.equal(orcidEmail({ email: [] }), null);
  assert.equal(orcidEmail(null), null);
});

test("sign-ins keep their emails, shown only on the owner's /account", async () => {
  const t = await dev();
  const me = await signIn(t, "/auth/dev-google?sub=7&email=Ada%40Lovelace-Lab.test&name=Ada");
  assert.deepEqual(emails(t), ["google:ada@lovelace-lab.test"]);

  // Adding GitHub with an email keeps both.
  await signIn(t, "/auth/dev-login?login=ada&ghid=42&email=ada%40github.test&link=1", me);
  assert.deepEqual(emails(t), ["github:ada@github.test", "google:ada@lovelace-lab.test"]);

  const page = await t.text("/account", me);
  assert.match(page, /ada@lovelace-lab\.test/);
  assert.match(page, /ada@github\.test/);
  assert.doesNotMatch(await t.text("/api/me", me), /@lovelace-lab\.test|@github\.test/);

  // Signing in again refreshes the email.
  await signIn(t, "/auth/dev-google?sub=7&email=ada%40new.test&name=Ada");
  assert.deepEqual(emails(t), ["github:ada@github.test", "google:ada@new.test"]);
});

test("an ORCID email is cleared when the record no longer makes it public", async () => {
  const t = await dev();
  await signIn(t, `/auth/dev-orcid?orcid=${ADA}&name=Ada&email=ada%40uni.test`);
  assert.deepEqual(emails(t), ["orcid:ada@uni.test"]);
  await signIn(t, `/auth/dev-orcid?orcid=${ADA}&name=Ada`);
  assert.deepEqual(emails(t), []);
});

test("deleting the account deletes its emails", async () => {
  const t = await dev();
  const me = await signIn(t, "/auth/dev-google?sub=7&email=ada%40lab.test&name=Ada");
  await signIn(t, "/auth/dev-google?sub=8&email=bob%40lab.test&name=Bob");
  const r = await t.form("/account", { action: "delete", confirm: "yes" }, me);
  assert.equal(r.status, 303);
  assert.deepEqual(emails(t), ["google:bob@lab.test"]);
});
