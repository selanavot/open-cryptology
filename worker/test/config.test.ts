// worker/wrangler.jsonc: staging must never point at production, and production must never turn
// on test-only behaviour. Reads the config the way `wrangler deploy [--env staging]` resolves it
// (inherited keys included). Run: npm --prefix worker test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

const config = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const prod = unstable_readConfig({ config });
const staging = unstable_readConfig({ config, env: "staging" });
const hosts = (c: typeof prod) =>
  (c.routes ?? []).map((r) => (typeof r === "string" ? r : r.pattern).replace(/\/.*$/, "").replace(/^\*\.?/, ""));

test("production: sends email, no made-up accounts, served at opencryptology.org", () => {
  assert.equal(prod.name, "open-cryptology");
  assert.equal(prod.vars.ENVIRONMENT, "production");
  assert.equal(prod.vars.AUTH_DEV_LOGIN, undefined, "made-up accounts must never be configured in production");
  assert.equal(prod.vars.AUTH_ORIGIN, undefined, "AUTH_ORIGIN belongs in .dev.vars only");
  assert.equal(prod.vars.LOCAL_DEV, undefined);
  assert.ok(hosts(prod).includes("opencryptology.org"));
});

test("staging: its own Worker, data and hostname", () => {
  assert.equal(staging.name, "open-cryptology-staging");
  assert.notEqual(staging.name, prod.name);
  for (const h of hosts(staging)) assert.match(h, /^staging\./, `staging route ${h} must be a staging host`);
  assert.ok(!hosts(staging).some((h) => hosts(prod).includes(h)), "staging must not claim a production route");
  const prodDb = new Set(prod.d1_databases.map((d) => d.database_id));
  assert.ok(staging.d1_databases.length > 0);
  for (const d of staging.d1_databases) assert.ok(!prodDb.has(d.database_id), `staging D1 ${d.database_name} is production's`);
  const prodBuckets = new Set(prod.r2_buckets.map((b) => b.bucket_name));
  assert.ok(staging.r2_buckets.length > 0);
  for (const b of staging.r2_buckets) assert.ok(!prodBuckets.has(b.bucket_name), `staging bucket ${b.bucket_name} is production's`);
  const prodNs = new Set(prod.ratelimits.map((r) => r.namespace_id));
  for (const r of staging.ratelimits) assert.ok(!prodNs.has(r.namespace_id), `rate-limit namespace ${r.namespace_id} is shared with production`);
});

test("staging: email only through sendMail, behind a verified Access gate, not indexed", () => {
  assert.equal(staging.vars.ENVIRONMENT, "staging", "mail.ts sends only maintainer mail outside production");
  assert.deepEqual(staging.send_email.map((b) => b.name), ["MAILER"]);
  assert.equal(staging.vars.CONTACT_TO, undefined, "CONTACT_TO (the one address staging may email) is a secret");
  assert.equal(staging.vars.REQUIRE_ACCESS, "1");
  assert.ok(staging.vars.ACCESS_TEAM_DOMAIN, "the Access JWT check needs the team domain");
  assert.equal(staging.workers_dev, false, "workers.dev would be a second, ungated-by-hostname URL");
  assert.equal(staging.preview_urls, false);
  assert.equal(staging.vars.CF_BEACON_TOKEN, undefined, "no analytics on staging");
  assert.equal(staging.vars.INDEXNOW_KEY, undefined);
});
