import { apiUpload } from "./apiupload";
import { handleReview, isReviewPath } from "./review";
import { notifyReview } from "./quarantine";
import { contactPage, handleContact } from "./contact";
import { checkHarvestStaleness } from "./staleness";
import { canonicalId, type Env } from "./db";
import { html } from "./html";
import { messagePage } from "./layout";
import { apiPaper, handleUpload, paperPage, servePdf } from "./paper";
import { gridFragment, yearPage } from "./years";
import { apiMissing, missingPage } from "./missing";
import { apiSearch, eprintPage, homePage, json, notFound, searchPage } from "./pages";
import { supportPage } from "./support";
import { privacyPage } from "./privacy";
import { llmsTxt, robotsTxt } from "./text";
import { indexNowKeyFile, pingIndexNow } from "./indexnow";
import { siteOrigin, sitemap } from "./seo";
import { handleAuth, isAuthPath } from "./auth";
import { handleAccount, isAccountPath } from "./account";
import { handleManuscripts, isManuscriptPath } from "./manuscripts";
import { handleAgentApi, isAgentApiPath } from "./agentapi";
import { handleComments, isCommentsPath } from "./comments";

// /YYYY/NNNN, optional trailing slash, .pdf, /upload, or /versions/<stamp>.pdf (one stored
// version, stamp = capture time YYYYMMDDThhmmssZ). Numbers may be zero-padded.
const PAPER_RE = /^\/(\d{4})\/(\d{1,6})(\.pdf|\/upload|\/|\/versions\/(\d{8}T\d{6}Z)\.pdf|\/versions\/?)?$/;
const API_PAPER_RE = /^\/api\/papers\/(\d{4})\/(\d{1,6})\/?$/;
const API_UPLOAD_RE = /^\/api\/upload\/(\d{4})\/(\d{1,6})\/?$/;
const YEAR_RE = /^\/(\d{4})\/?$/;
const GRID_RE = /^\/__grid\/(\d{4})$/;

function redirect(url: URL, path: string, status = 301): Response {
  const to = new URL(path, url);
  to.search = url.search;
  return new Response(null, { status, headers: { location: to.pathname + to.search, "cache-control": "public, max-age=86400" } });
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed\n", { status: 405, headers: { allow, "content-type": "text/plain" } });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const isGet = req.method === "GET" || req.method === "HEAD";

  const pm = PAPER_RE.exec(path);
  if (pm) {
    const year = Number(pm[1]);
    const num = Number(pm[2]);
    const suffix = pm[3] ?? "";
    if (num < 1) return notFound(env);
    const id = canonicalId(year, num);
    if (suffix === "/upload") {
      if (req.method !== "POST") {
        if (isGet) return redirect(url, `/${id}#upload`, 302);
        return methodNotAllowed("POST");
      }
      return handleUpload(env, req, url, year, num);
    }
    if (!isGet) return methodNotAllowed("GET, HEAD");
    if (pm[4]) {
      const want = `/${id}/versions/${pm[4]}.pdf`;
      if (path !== want) return redirect(url, want);
      return servePdf(env, req, year, num, ctx, pm[4]);
    }
    if (suffix.startsWith("/versions")) return redirect(url, `/${id}#versions`, 302);
    if (suffix === ".pdf") {
      if (path !== `/${id}.pdf`) return redirect(url, `/${id}.pdf`);
      return servePdf(env, req, year, num, ctx);
    }
    if (path !== `/${id}`) return redirect(url, `/${id}`);
    return paperPage(env, url, year, num);
  }

  if (req.method === "OPTIONS" && path.startsWith("/api/")) {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-max-age": "86400",
      },
    });
  }
  const um = API_UPLOAD_RE.exec(path);
  if (um) {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST the PDF to this URL." }, 405, "no-store");
    return apiUpload(env, req, url, Number(um[1]), Number(um[2]));
  }
  if (isReviewPath(path)) {
    if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed("GET, POST");
    return handleReview(req, env, url);
  }
  if (isCommentsPath(path)) return handleComments(req, env, url);
  if (isAgentApiPath(path, req)) return handleAgentApi(req, env, url);
  if (isAuthPath(path)) return handleAuth(req, env, url);
  if (isAccountPath(path)) return handleAccount(req, env, url);
  if (isManuscriptPath(path)) return handleManuscripts(req, env, url);
  if (path === "/contact") {
    if (req.method === "POST") return handleContact(env, req, url);
    if (!isGet) return methodNotAllowed("GET, HEAD, POST");
    return contactPage(env, url);
  }
  if (!isGet) return methodNotAllowed("GET, HEAD");

  const keyFile = indexNowKeyFile(env, path);
  if (keyFile) return keyFile;

  const am = API_PAPER_RE.exec(path);
  if (am) return apiPaper(env, url, Number(am[1]), Number(am[2]));

  const gm = GRID_RE.exec(path);
  if (gm) return gridFragment(env, url.origin, Number(gm[1]));

  const ym = YEAR_RE.exec(path);
  if (ym) {
    if (path !== `/${ym[1]}`) return redirect(url, `/${ym[1]}`);
    return yearPage(env, url, Number(ym[1]));
  }

  switch (path) {
    case "/":
      return homePage(env, url);
    case "/search":
      return searchPage(env, url);
    case "/eprint":
      return eprintPage(env, url);
    case "/api/search":
      return apiSearch(env, url);
    case "/missing":
      return missingPage(env, url);
    case "/api/missing":
      return apiMissing(env, url);
    case "/api":
    case "/api/":
      return redirect(url, "/llms.txt", 302);
    case "/about":
      return redirect(url, "/", 302);
    case "/support":
      return supportPage(env);
    case "/privacy":
      return privacyPage(env);
    case "/llms.txt":
      return llmsTxt(env, url.origin);
    case "/robots.txt":
      return robotsTxt(env, siteOrigin(env, url));
    case "/sitemap.xml":
      return sitemap(env, url);
  }
  if (path.startsWith("/api/")) return json({ error: "not_found", path }, 404, "public, max-age=60");
  return notFound(env);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const u = new URL(req.url);
    const host = u.hostname;
    // One hop to https on the bare domain (local dev stays on plain http). `wrangler dev` hands the
    // Worker the production host from the routes in wrangler.jsonc, so local runs are recognized
    // by LOCAL_DEV (set by scripts/dev.sh) or a localhost AUTH_ORIGIN, as well as by the host.
    const local =
      env.LOCAL_DEV === "1" || host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") ||
      /^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9.-]+\.localhost)(:\d+)?$/.test(env.AUTH_ORIGIN ?? "");
    if (host.startsWith("www.") || (u.protocol === "http:" && !local)) {
      const to = new URL(req.url);
      if (host.startsWith("www.")) to.hostname = host.slice(4);
      if (!local) to.protocol = "https:";
      const isGet = req.method === "GET" || req.method === "HEAD";
      return Response.redirect(to.toString(), isGet ? 301 : 308);
    }
    // Private-preview gate: while REQUIRE_ACCESS=1, only serve requests that came through
    // Cloudflare Access (which adds this header after login). Remove the var to go public.
    // Access sits in front of the workers.dev hostname only; on any other hostname (the custom
    // domain) nothing is served while gated, so a forged header can't get through.
    if (
      env.REQUIRE_ACCESS === "1" &&
      (!host.endsWith(".workers.dev") || !req.headers.get("cf-access-jwt-assertion"))
    ) {
      return new Response("Private preview.\n", {
        status: 403,
        headers: { "content-type": "text/plain", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }
    try {
      const res = await route(req, env, ctx);
      if (req.method === "HEAD" && res.body) return new Response(null, res);
      return res;
    } catch (e) {
      console.error("unhandled", req.method, req.url, e instanceof Error ? e.stack : String(e));
      return messagePage(
        env,
        500,
        "Something went wrong",
        html`<p>Sorry — an unexpected error occurred. If it keeps happening, please
        <a href="${env.ISSUES_URL}">report an issue</a>.</p>`,
      );
    }
  },
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // The metadata harvest runs on GitHub Actions; this emails the maintainer if it stops succeeding.
    ctx.waitUntil(
      checkHarvestStaleness(env).then(
        (r) => console.log("harvest staleness", JSON.stringify(r)),
        (e) => console.error("harvest staleness check failed", e instanceof Error ? e.stack : String(e)),
      ),
    );
    // Tell search engines (IndexNow) about new and changed paper pages.
    ctx.waitUntil(
      pingIndexNow(env).then(
        (r) => console.log("indexnow", JSON.stringify(r)),
        (e) => console.error("indexnow failed", e instanceof Error ? e.stack : String(e)),
      ),
    );
    // Review emails are throttled per upload; this sends one for uploads queued since the last.
    if (env.SITE_URL) ctx.waitUntil(notifyReview(env, env.SITE_URL));
  },
} satisfies ExportedHandler<Env>;
