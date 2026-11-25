import { type Env } from "./db";

// The REQUIRE_ACCESS gate (index.ts). Cloudflare Access sits in front of the site and adds a signed
// JWT (Cf-Access-Jwt-Assertion) to every request it lets through, for people (after login) and for
// service tokens (agents, scripts). With ACCESS_TEAM_DOMAIN and ACCESS_AUD set, the gate checks
// that JWT: RS256 signature against the team's published keys, this application's audience, the
// team as issuer, not expired. Anything else gets 403, so a missing or misconfigured Access app
// leaves the site closed rather than open. docs/STAGING.md.

interface Jwk extends JsonWebKey {
  kid: string;
}

let keyCache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;
const KEY_TTL = 3600_000;

async function teamKeys(team: string, refresh = false): Promise<Map<string, CryptoKey>> {
  if (!refresh && keyCache && keyCache.team === team && Date.now() - keyCache.at < KEY_TTL) return keyCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = await res.json<{ keys: Jwk[] }>();
  const map = new Map<string, CryptoKey>();
  for (const k of keys ?? []) {
    if (k.kty !== "RSA" || !k.kid) continue;
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache = { team, at: Date.now(), keys: map };
  return map;
}

const b64urlBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** The verified claims of an Access JWT, or null. `now` is for tests. */
export async function verifyAccessJwt(
  token: string,
  team: string,
  aud: string,
  now = Date.now(),
  keys: (team: string, refresh: boolean) => Promise<Map<string, CryptoKey>> = teamKeys,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  let key = (await keys(team, false)).get(header.kid);
  if (!key) key = (await keys(team, true)).get(header.kid); // keys rotate
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return null;
  if (claims.iss !== `https://${team}`) return null;
  const t = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp < t - 60) return null;
  if (typeof claims.nbf === "number" && claims.nbf > t + 60) return null;
  return claims;
}

/** JWT verification is configured (staging): the gate then works on any hostname. */
export const accessVerifies = (env: Env): boolean => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

/**
 * Whether a request may be served while REQUIRE_ACCESS=1. With ACCESS_TEAM_DOMAIN and ACCESS_AUD:
 * a valid Access JWT. Without them (the old private preview): a workers.dev hostname, which Access
 * covered, and the header present.
 */
export async function passedAccess(req: Request, env: Env, host: string): Promise<boolean> {
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return false;
  if (!accessVerifies(env)) return host.endsWith(".workers.dev");
  try {
    return (await verifyAccessJwt(jwt, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!)) !== null;
  } catch (e) {
    console.error("access check failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}
