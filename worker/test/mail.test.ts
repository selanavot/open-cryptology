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
  test(`ENVIRONMENT=${JSON.stringify(ENVIRONMENT)} captures instead of sending`, async () => {
    const { env, objects, sent } = fakeEnv({ ENVIRONMENT });
    const r = await sendMail(env, "test", mail);
    assert.equal(sent.length, 0, "nothing may reach the binding outside production");
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
