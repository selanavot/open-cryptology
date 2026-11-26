// Moderation (moderation.ts): reports, the maintainer review pages and actions, suspended accounts,
// and comments' earlier versions. Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { testWorker } from "./harness";
import { makePdf } from "./makepdf";

async function setup() {
  const t = await testWorker();
  t.paper("2025/542", ["Ada"]);
  const author = await t.person({ name: "Mallory" });
  const reader = await t.person({ name: "Carol" });
  const mod = await t.person({ name: "Maintainer", maintainer: true });
  const r = await t.form("/2025/542/comments", { title: "Buy now", body: "Cheap watches at example.test", kind: "comment" }, author);
  const id = Number(/comment-(\d+)/.exec(r.headers.get("location") ?? "")![1]);
  return { t, author, reader, mod, id };
}

const location = (r: Response) => r.headers.get("location") ?? "";

test("a reader reports a comment; the maintainer is emailed, sees it and hides it", async () => {
  const { t, reader, mod, id } = await setup();
  assert.match(await t.text("/2025/542"), new RegExp(`href="/report\\?comment=${id}"[^>]*data-can="other"`));

  const form = await t.text(`/report?comment=${id}`, reader);
  assert.match(form, /Report a comment/);
  assert.match(form, /Cheap watches/);
  let r = await t.form("/report", { kind: "comment", target: String(id), reason: "spam", note: "obvious spam" }, reader);
  assert.equal(r.status, 200);
  r = await t.form("/report", { kind: "comment", target: String(id), reason: "spam" }, reader); // again: still one open report
  assert.equal(r.status, 200);
  assert.equal(t.d1.rows("SELECT * FROM reports").length, 1);
  assert.equal(t.mail.filter((m) => /reported item/.test(m.subject)).length, 1);

  const list = await t.text("/review/reports", mod);
  assert.match(list, /Cheap watches/);
  assert.match(list, /obvious spam/);

  r = await t.form("/review/act", { kind: "comment", target: String(id), action: "hide", back: "/review/reports" }, mod);
  assert.equal(r.status, 303);
  assert.match(location(r), /^\/review\/reports\?done=comment%20hidden/);
  assert.doesNotMatch(await t.text("/2025/542"), /Cheap watches/);
  assert.equal(t.d1.rows<{ outcome: string }>("SELECT outcome FROM reports")[0].outcome, "actioned");
  assert.match(await t.text("/review/reports", mod), /No open reports/);
  const log = t.d1.rows<{ action: string; subject: string }>("SELECT action, subject FROM mod_log");
  assert.deepEqual(log.map((l) => l.action), ["hide"]);

  // and back again
  r = await t.form("/review/act", { kind: "comment", target: String(id), action: "unhide", back: `/review/comments/${id}` }, mod);
  assert.match(location(r), /comment%20restored/);
  assert.match(await t.text("/2025/542"), /Cheap watches/);
});

test("hiding from the comment's menu is logged too", async () => {
  const { t, mod, id } = await setup();
  await t.form(`/comments/${id}/hide`, {}, mod);
  assert.equal(t.d1.rows<{ action: string }>("SELECT action FROM mod_log")[0].action, "hide");
});

test("dismissing closes the reports without touching the comment", async () => {
  const { t, reader, mod, id } = await setup();
  await t.form("/report", { kind: "comment", target: String(id), reason: "other" }, reader);
  await t.form("/review/act", { kind: "comment", target: String(id), action: "dismiss" }, mod);
  assert.equal(t.d1.rows<{ outcome: string }>("SELECT outcome FROM reports")[0].outcome, "dismissed");
  assert.match(await t.text("/2025/542"), /Cheap watches/);
});

test("review pages and actions are for maintainers only; reporting needs a sign-in", async () => {
  const { t, reader, id } = await setup();
  assert.equal((await t.get("/review/reports", reader)).status, 403);
  assert.equal((await t.form("/review/act", { kind: "comment", target: String(id), action: "hide" }, reader)).status, 403);
  assert.match(await t.text("/2025/542"), /Cheap watches/);
  const r = await t.get(`/report?comment=${id}`);
  assert.equal(r.status, 303);
  assert.match(location(r), /^\/account\?next=%2Freport%3Fcomment%3D/);
  // Signed-out readers see Report in the menu; it opens the log-in pop-up (data-login).
  const page = await t.text("/2025/542");
  assert.match(page, /<details class="cm-menu">/);
  assert.match(page, new RegExp(`href="/report\\?comment=${id}" rel="nofollow" data-can="other" data-login="Log in or create an account to report">Report`));
});

test("edits keep the earlier text for maintainers; a report keeps a copy if the author deletes it", async () => {
  const { t, author, reader, mod, id } = await setup();
  await t.form("/report", { kind: "comment", target: String(id), reason: "spam" }, reader);
  await t.form(`/comments/${id}/edit`, { body: "Nothing to see here" }, author);
  assert.doesNotMatch(await t.text("/2025/542"), /Cheap watches/);
  let page = await t.text(`/review/comments/${id}`, mod);
  assert.match(page, /Nothing to see here/);
  assert.match(page, /Earlier versions[\s\S]*Cheap watches/);
  assert.match(await t.text("/review/reports", mod), /Edited since it was reported/);

  await t.form(`/comments/${id}/delete`, {}, author);
  assert.equal(t.d1.rows("SELECT * FROM comment_revisions").length, 0);
  page = await t.text(`/review/comments/${id}`, mod);
  assert.match(page, /Deleted by its author\. As reported:[\s\S]*Cheap watches/);
});

test("a comment's edit history is public, until a maintainer deletes the earlier versions", async () => {
  const { t, author, mod, id } = await setup();
  assert.doesNotMatch(await t.text("/2025/542"), /\/history/); // not edited: no link
  await t.form(`/comments/${id}/edit`, { body: "Second text" }, author);
  await t.form(`/comments/${id}/edit`, { body: "Third text", title: "Retitled" }, author);
  assert.match(await t.text("/2025/542"), new RegExp(`<a class="cm-edited" href="/comments/${id}/history"`));

  const page = await t.text(`/comments/${id}/history`); // signed out
  assert.match(page, /Current[\s\S]*Third text[\s\S]*Earlier[\s\S]*Second text[\s\S]*Original[\s\S]*Cheap watches/);
  assert.match(page, /Retitled[\s\S]*Buy now/);
  const one = (await (await t.get(`/api/comments/${id}`)).json()) as { history_url: string };
  assert.match(one.history_url, new RegExp(`/api/comments/${id}/history$`));
  const j = (await (await t.get(`/api/comments/${id}/history`)).json()) as { versions: { body: string; until: string | null }[] };
  assert.deepEqual(j.versions.map((v) => v.body), ["Third text", "Second text", "Cheap watches at example.test"]);
  assert.equal(j.versions[0].until, null);

  let r = await t.form("/review/act", { kind: "comment", target: String(id), action: "clear_history", back: `/review/comments/${id}` }, mod); // no tick
  assert.match(location(r), /nothing%20changed/);
  r = await t.form("/review/act", { kind: "comment", target: String(id), action: "clear_history", confirm: "yes", back: `/review/comments/${id}` }, mod);
  assert.match(location(r), /earlier%20versions%20deleted/);
  const after = await t.text(`/comments/${id}/history`);
  assert.doesNotMatch(after, /Cheap watches|Second text/);
  assert.match(after, /Earlier versions weren’t kept/);

  await t.form(`/comments/${id}/hide`, {}, mod);
  assert.equal((await t.get(`/comments/${id}/history`)).status, 404);
  assert.equal((await t.get(`/api/comments/${id}/history`)).status, 404);
});

test("a suspended account can't post, edit, vote, rename or use agents; unsuspending undoes it", async () => {
  const { t, author, reader, mod, id } = await setup();
  const agent = await t.token(author);
  const r = await t.form("/review/act", { kind: "user", target: author.id, action: "suspend", note: "spam", back: `/review/users/${author.id}` }, mod);
  assert.match(location(r), /account%20suspended/);
  assert.match(await t.text(`/review/users/${author.id}`, mod), /Suspended since/);

  let res = await t.form("/2025/542/comments", { title: "More", body: "More spam", kind: "comment" }, author);
  assert.match(location(res), /comment=suspended/);
  res = await t.form(`/comments/${id}/edit`, { body: "edited" }, author);
  assert.match(location(res), /comment=suspended/);
  const other = Number(/comment-(\d+)/.exec(location(await t.form("/2025/542/comments", { title: "Hi", body: "Real comment", kind: "comment" }, reader)))![1]);
  res = await t.form(`/comments/${other}/vote`, { vote: "1" }, author);
  assert.match(location(res), /comment=suspended/);
  res = await t.form("/account", { action: "name", name: "Someone Else" }, author);
  assert.equal(res.status, 403);
  // Suspending revoked the agent's token.
  res = await t.postJson("/api/papers/2025/542/comments", { title: "Via agent", body: "x" }, agent);
  assert.equal(res.status, 401);
  // A token from after the suspension doesn't work either.
  res = await t.postJson("/api/papers/2025/542/comments", { title: "Via agent", body: "x" }, await t.token(author));
  assert.equal(res.status, 403);
  // Deleting their own comment still works.
  res = await t.form(`/comments/${id}/delete`, {}, author);
  assert.match(location(res), /comment=deleted/);
  // So does an upload attempt being refused.
  const fd = new FormData();
  fd.set("file", new File([makePdf({ pages: [["On Lattices", "Ada"]] })], "p.pdf", { type: "application/pdf" }));
  assert.equal((await t.multipart("/submit", fd, author)).status, 403);

  await t.form("/review/act", { kind: "user", target: author.id, action: "unsuspend" }, mod);
  res = await t.form("/2025/542/comments", { title: "Back", body: "I'm back", kind: "comment" }, author);
  assert.match(location(res), /comment=posted/);
  assert.deepEqual(t.d1.rows<{ action: string }>("SELECT action FROM mod_log ORDER BY id").map((x) => x.action), ["suspend", "unsuspend"]);
});

test("hide all hides every visible comment of the account and closes their reports", async () => {
  const { t, author, reader, mod, id } = await setup();
  await t.form("/2025/542/comments", { title: "Two", body: "Second spam", kind: "comment" }, author);
  await t.form("/report", { kind: "comment", target: String(id), reason: "spam" }, reader);
  let r = await t.form("/review/act", { kind: "user", target: author.id, action: "hide_all" }, mod); // no tick: nothing
  assert.match(location(r), /nothing%20changed/);
  r = await t.form("/review/act", { kind: "user", target: author.id, action: "hide_all", confirm: "yes" }, mod);
  assert.match(location(r), /2%20comments%20hidden/);
  const page = await t.text("/2025/542");
  assert.doesNotMatch(page, /Cheap watches|Second spam/);
  assert.equal(t.d1.rows("SELECT * FROM reports WHERE closed_at IS NULL").length, 0);
});

test("accounts can be reported, and a maintainer can reset an offensive name", async () => {
  const { t, author, reader, mod } = await setup();
  await t.form("/account", { action: "name", name: "Rude Name" }, author);
  assert.match(await t.text(`/u/${author.id}`), new RegExp(`href="/report\\?user=${author.id}"`));
  await t.form("/report", { kind: "user", target: author.id, reason: "abuse" }, reader);
  assert.match(await t.text("/review/reports", mod), /Rude Name/);
  await t.form("/review/act", { kind: "user", target: author.id, action: "reset_name" }, mod);
  assert.doesNotMatch(await t.text(`/u/${author.id}`), /Rude Name/);
  assert.match(t.d1.rows<{ note: string }>("SELECT note FROM mod_log")[0].note, /Rude Name/);
});
