// Email goes out only from production (mail.ts). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SINK_PREFIX, sendMail } from "../src/mail";
import type { Env } from "../src/db";

function fakeEnv(vars: Partial<Env>) {
  const objects = new Map<string, string>();
  const sent: unknown[] = [];
  const env = {
    ...vars,
    PDFS: { put: async (k: string, v: string) => void objects.set(k, v) },
    MAILER: { send: async (m: unknown) => void sent.push(m) },
  } as unknown as Env;
  return { env, objects, sent };
}
const mail = { from: { name: "t", email: "contact@opencryptology.org" }, to: "author@example.edu", subject: "hi", text: "body" };

test("production delivers through the binding", async () => {
  const { env, objects, sent } = fakeEnv({ ENVIRONMENT: "production" });
  assert.deepEqual(await sendMail(env, "test", mail), { delivered: true });
  assert.equal(sent.length, 1);
  assert.equal(objects.size, 0);
});

for (const ENVIRONMENT of ["staging", "local", undefined, "Production", ""]) {
  test(`ENVIRONMENT=${JSON.stringify(ENVIRONMENT)} captures mail to an author instead of sending it`, async () => {
    const { env, objects, sent } = fakeEnv({ ENVIRONMENT });
    const r = await sendMail(env, "test", mail);
    assert.equal(sent.length, 0, "mail to anyone but the maintainer never reaches the binding outside production");
    assert.ok("captured" in r && r.captured.startsWith(SINK_PREFIX));
    const saved = JSON.parse([...objects.values()][0]);
    assert.equal(saved.to, "author@example.edu");
    assert.equal(saved.kind, "test");
  });
}

test("captured mail lists newest first", async () => {
  const { env, objects } = fakeEnv({ ENVIRONMENT: "staging" });
  await sendMail(env, "a", mail);
  await new Promise((r) => setTimeout(r, 5));
  await sendMail(env, "b", mail);
  const keys = [...objects.keys()].sort();
  assert.equal(JSON.parse(objects.get(keys[0])!).kind, "b");
});

test("only mail.ts touches the send_email binding", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && f !== "mail.ts" && f !== "db.ts")
    .filter((f) => /env\.MAILER|MAILER[!?]?\.send|\{[^}]*\bMAILER\b[^}]*\}\s*=\s*env/.test(readFileSync(src + f, "utf8")));
  assert.deepEqual(offenders, [], "send email with sendMail() from src/mail.ts, so staging and local runs capture it");
});

test("outside production, mail to the maintainer alone is also sent, marked", async () => {
  const { env, objects, sent } = fakeEnv({ ENVIRONMENT: "staging", CONTACT_TO: "Me@Example.org" });
  const r = await sendMail(env, "contact", { ...mail, to: "me@example.org" });
  assert.deepEqual({ delivered: (r as { delivered: boolean }).delivered, sent: sent.length, stored: objects.size }, { delivered: true, sent: 1, stored: 1 });
  assert.match((sent[0] as { subject: string }).subject, /^\[staging\] /);
  await sendMail(env, "contact", { ...mail, to: [{ name: "Me", email: "me@example.org" }] });
  assert.equal(sent.length, 2, "an address object counts too");
});

test("outside production, mail to anyone else is never sent", async () => {
  const { env, objects, sent } = fakeEnv({ ENVIRONMENT: "staging", CONTACT_TO: "me@example.org" });
  await sendMail(env, "author", { ...mail, to: "author@example.edu" });
  await sendMail(env, "author", { ...mail, to: ["me@example.org", "author@example.edu"] });
  await sendMail(env, "author", { ...mail, to: "me@example.org", cc: "author@example.edu" } as typeof mail);
  await sendMail(env, "author", { ...mail, to: "me@example.org", bcc: ["author@example.edu"] } as typeof mail);
  assert.equal(sent.length, 0);
  assert.equal(objects.size, 4, "all of it is captured");
  const { env: noMe, sent: sent2 } = fakeEnv({ ENVIRONMENT: "staging" });
  await sendMail(noMe, "contact", { ...mail, to: "" });
  assert.equal(sent2.length, 0, "no CONTACT_TO, nothing sent");
});
