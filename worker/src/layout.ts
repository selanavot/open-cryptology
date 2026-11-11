import { TURNSTILE_JS, turnstileOn } from "./turnstile";
import type { Env } from "./db";
import { html, type Html, type Val } from "./html";

const KATEX = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.19.1";
const KATEX_SRI = {
  css: "sha384-WwGtaC6ywCHxA5cstpj/3+xIZvTez8dq2IcBQaXRkenHZ7FVVq1ZROtURwfbtTlG",
  js: "sha384-a1WQdjRj162i159OYq041X6I4K8NenkrI09LlPmiHg0YOb7CR+wJOraXwK9abpnE",
  autoRender: "sha384-bjyGPfbij8/NDKJhSGZNP/khQVgtHUE5exjm4Ydllo42FwIgYsdLO2lXGmRBf5Mz",
};
const ASSET_VER = "9";

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    // KaTeX writes inline style attributes.
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "font-src https://cdnjs.cloudflare.com",
    "img-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

/** Whether a piece of text likely needs KaTeX (so plain pages skip the CDN entirely). */
export const hasTex = (...texts: (string | null | undefined)[]): boolean =>
  texts.some((t) => !!t && /\$|\\\(|\\\[/.test(t));

export interface PageOpts {
  title: string;
  description?: string;
  body: Html;
  status?: number;
  cache?: string; // Cache-Control
  katex?: boolean;
  /** Link shown in the "unofficial mirror" strip; defaults to the ePrint homepage. */
  original?: string;
  originalLabel?: string;
  canonical?: string;
  noindex?: boolean;
  query?: string;
  headers?: Record<string, string>;
}

export function page(env: Env, o: PageOpts): Response {
  const site = env.SITE_NAME;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title === site ? site : `${o.title} · ${site}`}</title>
${o.description && html`<meta name="description" content="${o.description}">`}
${o.canonical && html`<link rel="canonical" href="${o.canonical}">`}
${o.noindex && html`<meta name="robots" content="noindex">`}
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#FFC72C">
<link rel="icon" href="/favicon.svg?v=${ASSET_VER}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ASSET_VER}">
<link rel="stylesheet" href="/static/style.css?v=${ASSET_VER}">
${o.katex &&
html`<link rel="stylesheet" href="${KATEX}/katex.min.css" integrity="${KATEX_SRI.css}" crossorigin="anonymous" referrerpolicy="no-referrer">
<script defer src="${KATEX}/katex.min.js" integrity="${KATEX_SRI.js}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script defer src="${KATEX}/contrib/auto-render.min.js" integrity="${KATEX_SRI.autoRender}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`}
<script defer src="/static/app.js?v=${ASSET_VER}"></script>
${turnstileOn(env) && html`<script src="${TURNSTILE_JS}" async defer></script>`}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header id="topNavbar">
  <nav class="navbar" aria-label="Main">
    <div class="container nav-inner">
      <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Show menu">
      <label for="nav-toggle" class="nav-burger" aria-hidden="true"><span></span><span></span><span></span></label>
      <a class="site-name" href="/"><img class="site-logo" src="/static/logo.svg?v=${ASSET_VER}" alt="" width="40" height="40">${site}</a>
      <ul class="nav-links">
        <li><a href="/search">Papers</a></li>
      </ul>
      <details class="nav-search">
        <summary title="Search" aria-label="Search">${searchIcon()}</summary>
        <form class="nav-search-dd" action="/search" method="get" role="search">
          <div class="input-group">
            <input type="search" name="q" value="${o.query ?? ""}" class="form-control" placeholder="Search papers, or go to 2024/123" aria-label="Search papers" autocomplete="off">
            <button class="btn btn-secondary" type="submit">Search</button>
          </div>
        </form>
      </details>
    </div>
  </nav>
</header>
<main id="main" class="container eprintContent">
${o.body}
</main>
${footer(env)}
</body>
</html>`;
  return new Response(doc.value, {
    status: o.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": o.cache ?? "public, max-age=300",
      ...SECURITY_HEADERS,
      ...o.headers,
    },
  });
}

function footer(env: Env): Html {
  return html`<footer class="container site-footer">
  <nav aria-label="Footer">
    <a href="/llms.txt">For AI agents (llms.txt)</a> ·
    <a href="/#contact">Contact</a> ·
    <a href="${env.ISSUES_URL}">Report an issue</a>
  </nav>
  <p>${env.SITE_NAME} is an unofficial, non-commercial mirror of the
  <a href="${env.ORIGIN_BASE}">Cryptology ePrint Archive</a> and is not affiliated with the IACR.
  Papers remain under their authors’ licenses; please cite the original ePrint entry.</p>
</footer>`;
}

function searchIcon(): Html {
  // Hand-drawn magnifier (our own); inherits the navbar text colour.
  return html`<svg class="search-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/>
  <path d="M15 15l6 6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
}

/** Small inline icons used on buttons (our own drawings). */
export const icons = {
  pdf: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 1v4h4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 9h5M5.5 11.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  copy: html`<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="5" width="9" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 11H3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
};

/** ePrint-style card: centred h3 header with the gradient underline, then content. */
export function card(title: string, content: Val, cls = "", id = ""): Html {
  return html`<section class="eprintCard ${cls}"${id ? html` id="${id}"` : ""}>
  <div class="eprintCardHeader"><h3>${title}</h3></div>
  <div class="eprintCardContent">${content}</div>
</section>`;
}

const CATEGORY_SLUGS: Record<string, string> = {
  Applications: "applications",
  "Cryptographic protocols": "protocols",
  Foundations: "foundations",
  Implementation: "implementation",
  "Secret-key cryptography": "secretkey",
  "Public-key cryptography": "publickey",
  "Attacks and cryptanalysis": "attacks",
};
/** Category label -> ePrint-like badge (warm tints instead of ePrint's). */
export function categoryBadge(cat: string | null | undefined): Html | "" {
  if (!cat) return "";
  const slug = CATEGORY_SLUGS[cat] ?? "uncategorized";
  return html`<small class="badge category category-${slug}">${cat}</small>`;
}

/** Simple message page (errors, notices). */
export function messagePage(
  env: Env,
  status: number,
  title: string,
  body: Val,
  extra: Partial<PageOpts> = {},
): Response {
  return page(env, {
    title,
    status,
    cache: status >= 500 ? "no-store" : "public, max-age=60",
    noindex: status >= 400,
    body: html`<section class="message"><h3>${title}</h3>${body}</section>`,
    ...extra,
  });
}
