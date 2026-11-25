// The Access JWT check behind REQUIRE_ACCESS (access.ts). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "../src/access";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = Date.UTC(2026, 10, 25, 12) ;

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString("base64url");

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const keys = async () => new Map([["k1", pair.publicKey]]);

async function jwt(claims: Record<string, unknown>, { kid = "k1", alg = "RS256", key = pair.privateKey } = {}) {
  const head = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const good = { aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, iat: NOW / 1000, email: "a@b.c" };
const check = (t: string) => verifyAccessJwt(t, TEAM, AUD, NOW, keys);

test("a valid Access JWT passes", async () => {
  assert.equal((await check(await jwt(good)))?.email, "a@b.c");
  assert.ok(await check(await jwt({ ...good, aud: AUD })), "aud may be a string");
});

test("anything else is refused", async () => {
  assert.equal(await check(await jwt({ ...good, aud: ["other-app"] })), null, "another application");
  assert.equal(await check(await jwt({ ...good, iss: "https://evil.cloudflareaccess.com" })), null, "another team");
  assert.equal(await check(await jwt({ ...good, exp: NOW / 1000 - 3600 })), null, "expired");
  assert.equal(await check(await jwt({ ...good, nbf: NOW / 1000 + 3600 })), null, "not yet valid");
  assert.equal(await check(await jwt(good, { key: other.privateKey })), null, "wrong signature");
  assert.equal(await check(await jwt(good, { kid: "unknown" })), null, "unknown key");
  assert.equal(await check(await jwt(good, { alg: "none" })), null, "alg none");
  const t = await jwt(good);
  const [h, , s] = t.split(".");
  assert.equal(await check(`${h}.${b64url(JSON.stringify({ ...good, email: "x@y.z" }))}.${s}`), null, "tampered claims");
  assert.equal(await check("not-a-jwt"), null);
  assert.equal(await check(""), null);
});
