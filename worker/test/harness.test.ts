// The test Worker itself (harness.ts): schema loads, sign-in works, a public comment round-trips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testWorker } from "./harness";

test("a signed-in person posts a comment and everyone sees it", async () => {
  const t = await testWorker();
  t.paper("2025/542", ["Ada", "Bob"]);
  const me = await t.person({ name: "Carol" });
  const res = await t.form("/2025/542/comments", { title: "A question", body: "Is lemma 3 tight?", kind: "question" }, me);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /comment=posted/);
  const page = await t.text("/2025/542");
  assert.match(page, /Is lemma 3 tight\?/);
  const api = (await (await t.get("/api/papers/2025/542/comments")).json()) as { comments: { title: string }[] };
  assert.equal(api.comments[0].title, "A question");
});

test("bots post through the API with their key", async () => {
  const t = await testWorker();
  t.paper("2025/542", ["Ada"]);
  const b = await t.bot();
  const res = await t.postJson("/api/papers/2025/542/comments", { title: "Finding", body: "Theorem 2 fails.", kind: "issue", severity: "high" }, b);
  assert.equal(res.status, 201);
  assert.match(await t.text(`/u/${b.id}`), /Theorem 2 fails/);
});
