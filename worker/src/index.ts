import { contactPage, handleContact } from "./contact";
import { canonicalId, type Env } from "./db";
import { html } from "./html";
import { messagePage } from "./layout";
import { apiPaper, handleUpload, paperPage, servePdf } from "./paper";
import { aboutPage, apiDocsPage, apiSearch, homePage, json, notFound, searchPage } from "./pages";
import { llmsTxt, robotsTxt } from "./text";

// /YYYY/NNNN, optional trailing slash, .pdf, or /upload. Numbers may be zero-padded.
const PAPER_RE = /^\/(\d{4})\/(\d{1,6})(\.pdf|\/upload|\/)?$/;
const API_PAPER_RE = /^\/api\/papers\/(\d{4})\/(\d{1,6})\/?$/;

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
    if (suffix === ".pdf") {
      if (path !== `/${id}.pdf`) return redirect(url, `/${id}.pdf`);
      return servePdf(env, req, year, num);
    }
    if (path !== `/${id}`) return redirect(url, `/${id}`);
    return paperPage(env, ctx, url, year, num);
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
  if (path === "/contact") {
    if (req.method === "POST") return handleContact(env, req, url);
    if (!isGet) return methodNotAllowed("GET, HEAD, POST");
    return contactPage(env, url);
  }
  if (!isGet) return methodNotAllowed("GET, HEAD");

  const am = API_PAPER_RE.exec(path);
  if (am) return apiPaper(env, ctx, url, Number(am[1]), Number(am[2]));

  switch (path) {
    case "/":
      return homePage(env);
    case "/search":
      return searchPage(env, url);
    case "/api/search":
      return apiSearch(env, url);
    case "/api":
      return apiDocsPage(env, url.origin);
    case "/api/":
      return redirect(url, "/api");
    case "/about":
      return aboutPage(env);
    case "/llms.txt":
      return llmsTxt(env, url.origin);
    case "/robots.txt":
      return robotsTxt(env, url.origin);
  }
  if (path.startsWith("/api/")) return json({ error: "not_found", path }, 404, "public, max-age=60");
  return notFound(env);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Private-preview gate: while REQUIRE_ACCESS=1, only serve requests that came through
    // Cloudflare Access (which adds this header after login). Remove the var to go public.
    if (env.REQUIRE_ACCESS === "1" && !req.headers.get("cf-access-jwt-assertion")) {
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
} satisfies ExportedHandler<Env>;
