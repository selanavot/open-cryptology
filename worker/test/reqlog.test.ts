// The request log line (reqlog.ts). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataPoint, loggedQuery, paperOf, requestLine } from "../src/reqlog";

test("query strings are logged, credential values are not", () => {
  assert.equal(loggedQuery(new URL("https://x.test/search?q=lattice+sigs&page=2")), "q=lattice+sigs&page=2");
  assert.equal(loggedQuery(new URL("https://x.test/auth/github/callback?code=abc123&state=xyz&next=%2F")), "code=REDACTED&state=REDACTED&next=%2F");
  assert.equal(loggedQuery(new URL("https://x.test/2024/123")), "");
});

test("request line carries the client, the address and the answer", () => {
  const u = new URL("https://opencryptology.org/2024/123.pdf?download=1");
  const req = new Request(u, {
    headers: {
      "user-agent": "curl/8.7.1",
      referer: "https://opencryptology.org/2024/123",
      "cf-connecting-ip": "203.0.113.7",
      range: "bytes=0-99",
      cookie: "oc_login=1; __Host-oc_session=abc",
    },
  });
  const res = new Response("x".repeat(100), { status: 206, headers: { "content-type": "application/pdf", "content-length": "100" } });
  const line = requestLine(req, u, res.status, 12, res);
  assert.deepEqual(
    { kind: line.kind, path: line.path, query: line.query, status: line.status, ms: line.ms, bytes: line.bytes, type: line.type },
    { kind: "request", path: "/2024/123.pdf", query: "download=1", status: 206, ms: 12, bytes: 100, type: "application/pdf" },
  );
  assert.equal(line.ip, "203.0.113.7");
  assert.equal(line.ref, "opencryptology.org");
  assert.equal(line.referer, "https://opencryptology.org/2024/123");
  assert.equal(line.range, true);
  assert.equal(line.signedIn, true);
  assert.ok(!JSON.stringify(line).includes("abc"), "the session cookie is never logged");
});

test("a request that threw still gets a line", () => {
  const u = new URL("https://opencryptology.org/2020/035.pdf");
  const line = requestLine(new Request(u), u, 500, 3);
  assert.equal(line.status, 500);
  assert.equal(line.bytes, undefined);
  assert.equal(line.signedIn, false);
});

function lineFor(headers: Record<string, string>, cf: Record<string, unknown> = {}, path = "/2024/123") {
  const u = new URL(`https://opencryptology.org${path}`);
  const req = new Request(u, { headers });
  Object.defineProperty(req, "cf", { value: cf });
  return requestLine(req, u, 200, 5);
}
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

test("each request is labelled with the kind of client", () => {
  const person = lineFor({ "user-agent": CHROME, "accept-language": "en-US,en;q=0.9", "sec-fetch-dest": "document" });
  assert.deepEqual([person.client, person.agent], ["person", ""]);
  // a browser user-agent without what browsers send (the fake-Google-referrer scraper)
  assert.equal(lineFor({ "user-agent": CHROME, referer: "https://www.google.com/" }).client, "script");
  const gpt = lineFor({ "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" }, { verifiedBotCategory: "AI Assistant" });
  assert.deepEqual([gpt.client, gpt.agent], ["agent", "chatgpt"]);
  const cc = lineFor({ "user-agent": "Claude-User (claude-code/2.1.330; +https://support.anthropic.com/)" });
  assert.deepEqual([cc.client, cc.agent], ["agent", "claude"]);
  const sandbox = lineFor({ "user-agent": "Python-urllib/3.12" }, { verifiedBotCategory: "AI Assistant", asOrganization: "OpenAI" });
  assert.deepEqual([sandbox.client, sandbox.agent], ["agent", "openai-sandbox"]);
  assert.equal(lineFor({ "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" }, { verifiedBotCategory: "AI Crawler" }).client, "crawler");
  assert.equal(lineFor({ "user-agent": "Mozilla/5.0 (compatible; SERankingBacklinksBot/1.0; +https://seranking.com/backlinks-crawler)" }).client, "crawler");
  assert.equal(lineFor({ "user-agent": "curl/8.7.1" }).client, "script");
  assert.equal(lineFor({ "user-agent": "open-cryptology-backfill/1.0 (local requested backfill)" }).client, "site");
  assert.equal(lineFor({ "user-agent": "Mozilla/5.0 (compatible; open-cryptology-deploy-check)" }).client, "site");
  assert.equal(lineFor({ "user-agent": "ExampleBot/1.0 (+https://opencryptology.org)" }).client, "crawler");
});

test("the sign-in cookie's display name is logged, not the session", () => {
  const name = encodeURIComponent(JSON.stringify({ n: "Ada Lovelace", a: "" }));
  const line = lineFor({ cookie: `oc_login=${name}; __Host-oc_session=secret` });
  assert.equal(line.login, "Ada Lovelace");
  assert.equal(lineFor({ cookie: "oc_login=%7Bbroken" }).login, "");
  assert.ok(!JSON.stringify(line).includes("secret"));
});

test("paper ids are pulled from paths", () => {
  assert.equal(paperOf("/2024/123"), "2024/123");
  assert.equal(paperOf("/2024/123.pdf"), "2024/123");
  assert.equal(paperOf("/2024/1685/versions/20261114T035804Z.pdf"), "2024/1685");
  assert.equal(paperOf("/api/papers/2026/2997"), "2026/2997");
  assert.equal(paperOf("/2026-11-15/3.pdf"), "2026-11-15/3");
  assert.equal(paperOf("/2024"), "");
  assert.equal(paperOf("/search"), "");
});

test("the Analytics Engine data point keeps its field order", () => {
  const line = lineFor({ "user-agent": CHROME, "accept-language": "en", "sec-fetch-dest": "document", "cf-connecting-ip": "203.0.113.7" }, { country: "KR", asOrganization: "Seoul National University" }, "/2026/656.pdf");
  const p = dataPoint(line);
  assert.deepEqual(p.indexes, ["203.0.113.7"]);
  const b = p.blobs as string[];
  assert.deepEqual([b[0], b[2], b[3], b[6], b[7], b[10]], ["person", "/2026/656.pdf", "2026/656", "203.0.113.7", "KR", "Seoul National University"]);
  assert.ok(b.length <= 20 && (p.doubles as number[]).length <= 20);
  assert.equal((p.doubles as number[])[0], 200);
});
