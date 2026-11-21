/**
 * One line per request for Workers Logs (kept 7 days), so traffic questions can be answered later
 * without deciding up front what to count. While the site is young this records as much as is
 * useful: the full address with its query string, the client's IP address, network and rough
 * location, and what Cloudflare says about bots. /privacy describes it; keep the two in step.
 *
 * Values of query parameters that are credentials (sign-in codes and the like) are replaced
 * with "REDACTED".
 */

const SECRET_PARAMS = /^(code|state|token|access_token|id_token|key|secret|password|sig|signature)$/i;
const MAX = 300;

/** The query string as sent, with credential values redacted and long strings cut. */
export function loggedQuery(u: URL): string {
  if (!u.search) return "";
  const out = new URLSearchParams();
  for (const [k, v] of u.searchParams) out.append(k, SECRET_PARAMS.test(k) ? "REDACTED" : v);
  return out.toString().slice(0, 1000);
}

function header(req: Request, name: string, max = MAX): string {
  return (req.headers.get(name) ?? "").slice(0, max);
}

/** The fields of the log line. `res` is absent when the Worker threw before answering. */
export function requestLine(req: Request, u: URL, status: number, ms: number, res?: Response): Record<string, unknown> {
  const referer = header(req, "referer", 500);
  let ref = "";
  try {
    ref = new URL(referer).hostname;
  } catch {
    // no referer, or not a URL
  }
  const cf = (req.cf ?? {}) as Record<string, unknown>;
  const bot = (cf.botManagement ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const bytes = Number(res?.headers.get("content-length") ?? "");
  return {
    kind: "request",
    method: req.method,
    host: u.hostname,
    path: u.pathname,
    query: loggedQuery(u),
    status,
    ms,
    bytes: Number.isFinite(bytes) && res?.headers.has("content-length") ? bytes : undefined,
    type: (res?.headers.get("content-type") ?? "").split(";")[0],
    ip: header(req, "cf-connecting-ip", 64),
    country: str(cf.country),
    region: str(cf.region),
    city: str(cf.city),
    timezone: str(cf.timezone),
    asn: num(cf.asn),
    asOrg: str(cf.asOrganization).slice(0, 120),
    colo: str(cf.colo),
    http: str(cf.httpProtocol),
    tls: str(cf.tlsVersion),
    botScore: num(bot.score),
    verifiedBot: typeof bot.verifiedBot === "boolean" ? bot.verifiedBot : undefined,
    botCategory: str(cf.verifiedBotCategory),
    ua: header(req, "user-agent"),
    lang: header(req, "accept-language", 100),
    accept: header(req, "accept", 200),
    ref,
    referer,
    range: req.headers.has("range"),
    rangeHeader: header(req, "range", 100),
    secFetchSite: header(req, "sec-fetch-site", 40),
    secFetchDest: header(req, "sec-fetch-dest", 40),
    signedIn: /(?:^|;\s*)__Host-oc_session=/.test(req.headers.get("cookie") ?? ""),
  };
}

export function logRequest(req: Request, u: URL, status: number, ms: number, res?: Response): void {
  console.log(requestLine(req, u, status, ms, res));
}
