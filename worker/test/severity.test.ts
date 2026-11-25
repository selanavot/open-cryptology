// Severity of Issue posts (severity.ts, comments.ts). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKind, commentsSection, editComment, type Thread } from "../src/comments";
import { SEVERITY, severityBody } from "../src/severity";
import { llmsTxt } from "../src/text";
import type { Env } from "../src/db";
import type { User } from "../src/auth";

const fail = (code: string) => ({ error: code });

test("an Issue needs a severity, nothing else may have one", () => {
  assert.deepEqual(checkKind("issue", "Lemma 3 is false", false, "high"), { kind: "issue", title: "Lemma 3 is false", severity: "high" });
  assert.deepEqual(checkKind("issue", "t", false, " Critical "), { kind: "issue", title: "t", severity: "critical" });
  assert.deepEqual(checkKind("issue", "t", false), fail("severity"));
  assert.deepEqual(checkKind("issue", "t", false, "severe"), fail("severity"));
  assert.deepEqual(checkKind("question", "t", false, "low"), fail("severity"));
  assert.deepEqual(checkKind("", "t", false, "low"), fail("severity"));
  assert.deepEqual(checkKind("question", "t", false), { kind: "question", title: "t", severity: null });
  assert.deepEqual(checkKind("comment", "", true), { kind: "comment", title: null, severity: null });
  assert.deepEqual(checkKind("comment", "", true, "low"), fail("severity"));
  assert.deepEqual(checkKind("issue", "", true, "low"), fail("bad_kind"));
});

// ---- editing, against a D1 stand-in that records the UPDATE
type Updated = { body: string; title: string | null; kind: string; severity: string | null } | null;
function fakeEnv(): { env: Env; updated: () => Updated } {
  let last: Updated = null;
  const DB = {
    prepare: (sql: string) => ({
      bind: (...a: unknown[]) => ({
        run: async () => {
          assert.match(sql, /^UPDATE comments SET body = \?2, title = \?3, kind = \?4, severity = \?5/);
          last = { body: a[1] as string, title: a[2] as string | null, kind: a[3] as string, severity: a[4] as string | null };
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  return { env: { DB } as unknown as Env, updated: () => last };
}
const me = { id: "u1" } as User;
const post = (o: object) =>
  ({ id: 7, target: "2024/123", user_id: "u1", owner: "u1", reply_to: null, body: "text", state: "visible", created_at: "", edited_at: null, kind: "issue", title: "T", severity: "high", score: 0, ...o }) as Parameters<typeof editComment>[2];

test("editing keeps, changes or drops an Issue's severity", async () => {
  let f = fakeEnv();
  assert.equal(await editComment(f.env, me, post({}), "new text"), null);
  assert.equal(f.updated()?.severity, "high");

  f = fakeEnv();
  assert.equal(await editComment(f.env, me, post({}), "text", undefined, undefined, "low"), null);
  assert.deepEqual(f.updated(), { body: "text", title: "T", kind: "issue", severity: "low" });

  f = fakeEnv(); // relabelled as a question: the severity goes
  assert.equal(await editComment(f.env, me, post({}), "text", undefined, "question"), null);
  assert.deepEqual(f.updated(), { body: "text", title: "T", kind: "question", severity: null });

  f = fakeEnv(); // relabelled as an Issue: needs one
  assert.deepEqual(await editComment(f.env, me, post({ kind: "question", severity: null }), "text", undefined, "issue"), fail("severity"));
  assert.equal(await editComment(f.env, me, post({ kind: "question", severity: null }), "text", undefined, "issue", "medium"), null);
  assert.equal(f.updated()?.severity, "medium");

  f = fakeEnv(); // an Issue from before severities gets one when it is saved
  assert.deepEqual(await editComment(f.env, me, post({ severity: null }), "new text"), fail("severity"));
  assert.equal(f.updated(), null);

  f = fakeEnv(); // nothing changed: nothing written
  assert.equal(await editComment(f.env, me, post({}), "text", "T", "issue", "high"), null);
  assert.equal(f.updated(), null);

  assert.deepEqual(await editComment(f.env, { id: "u2" } as User, post({}), "x", undefined, undefined, "low"), fail("not_yours"));
});

// ---- the page
const person = (id: string) => ({ id, displayName: "Ada", customName: null, botBio: null, avatar: "", role: "user", identities: [], deleted: false });
const row = (o: object) => ({ target: "2024/123", user_id: "u1", reply_to: null, body: "b", state: "visible", created_at: "2026-11-25T00:00:00Z", edited_at: null, kind: "comment", title: "T", severity: null, score: 0, ...o });

test("a posted Issue's chip shows its severity and links to the levels", () => {
  const t = {
    target: "2024/123",
    uploader: null,
    rows: [row({ id: 1, kind: "issue", severity: "critical", title: "Broken" }), row({ id: 2, kind: "issue", title: "Old" }), row({ id: 3, kind: "question", title: "Q" })],
    people: new Map([["u1", person("u1")]]),
  } as unknown as Thread;
  const h = String(commentsSection(t, new URL("https://x.test/2024/123")));
  assert.match(h, /id="comment-1" data-kind="issue" data-severity="critical"/);
  assert.match(h, /<a class="cm-flair cm-flair-issue cm-sev cm-sev-critical" href="\/severity#critical"[^>]*>Issue · Critical<\/a>/);
  assert.match(h, /id="comment-2" data-kind="issue" data-owner/); // from before severities: no attribute
  assert.match(h, /<span class="cm-flair cm-flair-issue">Issue<\/span>/);
  assert.doesNotMatch(h, /id="comment-3"[^>]*data-severity/);
  // the composer's picker: one radio per level, sent only once Issue is picked, and a link to /severity
  assert.equal(h.match(/name="severity" value="[a-z]+" required disabled/g)?.length, SEVERITY.length); // the top box only
  assert.match(h, /<a class="cm-severity-help" href="\/severity"/);
});

test("/severity says it is an early version and asks for opinions", () => {
  const h = String(severityBody());
  assert.match(h, /early version/);
  assert.match(h, /href="\/contact"/);
  for (const l of SEVERITY) assert.match(h, new RegExp(`id="${l.key}"`));
});

test("llms.txt documents the severity field and its levels", async () => {
  const t = await llmsTxt({ SITE_NAME: "Open Cryptology" } as Env, "https://x.test").text();
  assert.match(t, /"severity": "high"/);
  assert.match(t, /https:\/\/x\.test\/severity/);
  for (const l of SEVERITY) assert.ok(t.includes(`"${l.key}": ${l.short}`));
});
