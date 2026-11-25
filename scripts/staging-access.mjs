// Lets Node scripts reach staging through Cloudflare Access with the service token
// (docs/STAGING.md). Preload it; it adds the token's headers to every fetch to staging:
//   node --import ./scripts/staging-access.mjs scripts/auth-smoke.mjs https://staging.opencryptology.org
// The token comes from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, else worker/.staging.env
// (gitignored; this checkout's, else the main checkout's).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STAGING_HOST = "staging.opencryptology.org";

function readToken() {
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    return { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET };
  }
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
  const roots = [git("rev-parse", "--show-toplevel"), dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir"))];
  for (const r of roots) {
    const f = join(r, "worker", ".staging.env");
    if (!existsSync(f)) continue;
    const vars = Object.fromEntries(
      readFileSync(f, "utf8").split("\n").map((l) => /^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]),
    );
    if (vars.CF_ACCESS_CLIENT_ID && vars.CF_ACCESS_CLIENT_SECRET) return { id: vars.CF_ACCESS_CLIENT_ID, secret: vars.CF_ACCESS_CLIENT_SECRET };
  }
  return null;
}

const token = readToken();
if (!token) {
  console.error("staging-access: no service token (CF_ACCESS_CLIENT_ID/SECRET or worker/.staging.env); staging will answer 403");
} else {
  const plain = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== STAGING_HOST) return plain(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("cf-access-client-id", token.id);
    headers.set("cf-access-client-secret", token.secret);
    return plain(input, { ...init, headers });
  };
}
