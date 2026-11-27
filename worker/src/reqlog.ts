/**
 * One line per request for Workers Logs (kept 7 days), so traffic questions can be answered later
 * without deciding up front what to count. While the site is young this records as much as is
 * useful: the full address with its query string, the client's IP address, network and rough
 * location, and what Cloudflare says about bots. /privacy describes it; keep the two in step.
 *
 * Each line also says what kind of client sent it (`client`, see clientOf), and the same request
 * is written as one Analytics Engine data point (TRAFFIC binding, kept about 3 months) so
 * scripts/traffic.mjs can answer "who, from where, reading what" over longer spans.
 *
 * Values of query parameters that are credentials (sign-in codes and the like) are replaced
 * with "REDACTED" in this line. Workers Logs itself also attaches the full request URL, query
 * string included and unredacted ($workers.event.request.url / .search), to every log event, so
 * this redaction does not keep a secret out of the logs: never put one in a URL. Send it in a
 * POST body, a header or a cookie.
 */
import { LOGIN_COOKIE } from "./auth";
import type { Env } from "./db";

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
  const line: Record<string, unknown> = {
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
    login: loginName(req),
  };
  return { ...line, ...clientOf(line) };
}

/**
 * What kind of client sent a request:
 * - "site": our own tools (pipeline, backfill and maintenance scripts name themselves so);
 * - "agent": an AI assistant fetching for a person right now (ChatGPT-User, Claude-User, ...), or
 *   anything Cloudflare files under "AI Assistant" (scripts run in OpenAI's sandboxes, say);
 * - "crawler": any other self-declared bot, or one Cloudflare verified;
 * - "person": a browser that sends what real browsers send (a Mozilla user-agent, an
 *   Accept-Language and Sec-Fetch headers);
 * - "script": everything else (curl, Python, browsers faked without the headers).
 * Crawlers that fake a full browser still count as "person" here; traffic.mjs filters those by
 * their pattern (one request per address, datacenter networks).
 */
export type Client = "site" | "agent" | "crawler" | "person" | "script";

// Our tools name themselves "open-cryptology-<tool>", first ("open-cryptology-pipeline/0.1 ...") or
// inside a browser-style user-agent ("Mozilla/5.0 (compatible; open-cryptology-deploy-check)").
const SITE_UA = /(?:^|[\s;(])open-?cryptology(?:-|\/|$)/i;
const AGENTS: Array<[RegExp, string]> = [
  [/ChatGPT-User|ChatGPT Agent/i, "chatgpt"],
  [/Claude-User|Claude-Web/i, "claude"],
  [/Perplexity-User/i, "perplexity"],
  [/Gemini-CLI|Google-Agent|Gemini-Deep-Research/i, "gemini"],
  [/MistralAI-User/i, "mistral"],
  [/DuckAssistBot/i, "duckassist"],
  [/Meta-External(Fetcher|Agent)/i, "meta"],
];
const BOT_UA = /bot\b|bot\/|crawl|spider|slurp|fetcher|scrap|preview|monitor|checker|archiver|\+https?:/i;

export function clientOf(line: Record<string, unknown>): { client: Client; agent: string } {
  const ua = String(line.ua ?? "");
  const cat = String(line.botCategory ?? "");
  if (SITE_UA.test(ua)) return { client: "site", agent: "" };
  for (const [re, name] of AGENTS) if (re.test(ua)) return { client: "agent", agent: name };
  if (cat === "AI Assistant") {
    const org = String(line.asOrg ?? "");
    return { client: "agent", agent: /openai/i.test(org) ? "openai-sandbox" : /anthropic/i.test(org) ? "anthropic-sandbox" : "other" };
  }
  if (cat || line.verifiedBot === true || BOT_UA.test(ua)) return { client: "crawler", agent: "" };
  const browser = ua.startsWith("Mozilla/") && !!line.lang && !!(line.secFetchDest || line.secFetchSite);
  return { client: browser ? "person" : "script", agent: "" };
}

/** The display name in the (untrusted, display-only) sign-in cookie, or "". */
export function loginName(req: Request): string {
  const m = new RegExp(`(?:^|;\\s*)${LOGIN_COOKIE}=([^;]*)`).exec(req.headers.get("cookie") ?? "");
  if (!m) return "";
  try {
    const n = (JSON.parse(decodeURIComponent(m[1])) as { n?: unknown }).n;
    return typeof n === "string" ? n.slice(0, 80) : "";
  } catch {
    return "";
  }
}

/** "2024/123" for an ePrint paper's page, PDF or versions; "2026-11-15/3" for a manuscript; else "". */
export function paperOf(path: string): string {
  const m = /^\/(?:api\/papers\/|api\/upload\/)?(\d{4})\/(\d{1,6})(?:[./]|$)/.exec(path);
  if (m) return `${m[1]}/${m[2]}`;
  const ms = /^\/(\d{4}-\d{2}-\d{2})\/(\d{1,4})(?:[./]|$)/.exec(path);
  return ms ? `${ms[1]}/${ms[2]}` : "";
}

/**
 * The Analytics Engine data point for a log line. Field order is what traffic.mjs queries, so
 * only ever append: blob1..blob20 and double1..double20 are positional.
 */
export function dataPoint(line: Record<string, unknown>): AnalyticsEngineDataPoint {
  const s = (k: string, max = 200): string => String(line[k] ?? "").slice(0, max);
  const n = (k: string): number => (typeof line[k] === "number" ? (line[k] as number) : 0);
  return {
    indexes: [s("ip", 64)], // sampling key: a busy address is sampled as a whole
    blobs: [
      s("client"), s("agent"), s("path", 300), paperOf(String(line.path ?? "")), s("method"), s("referer", 500),
      s("ip", 64), s("country"), s("region"), s("city"), s("asOrg", 120), s("ref"), s("ua", 300),
      s("botCategory"), s("lang", 100), s("type"), s("login"), s("query", 300), s("secFetchDest"), s("host"),
    ],
    doubles: [n("status"), n("ms"), n("bytes"), n("asn"), line.signedIn ? 1 : 0],
  };
}

export function logRequest(env: Env, req: Request, u: URL, status: number, ms: number, res?: Response): void {
  const line = requestLine(req, u, status, ms, res);
  console.log(line);
  try {
    env.TRAFFIC?.writeDataPoint(dataPoint(line));
  } catch (e) {
    console.error("traffic data point", e instanceof Error ? e.message : String(e));
  }
}
