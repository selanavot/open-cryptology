// The log-in buttons ("Continue with GitHub / Google / ORCID"), shared by the /account log-in
// page and the log-in pop-up that every page carries (layout.ts; opened by app.js).
import type { Env } from "./db";
import { html, type Html } from "./html";
import { devLogin, type Provider, PROVIDER_LABEL } from "./auth";

export const PROVIDERS: Provider[] = ["github", "google", "orcid"];

/** Provider marks for log-in buttons and rows: GitHub's Octicons mark (MIT), Google's "G" and
 *  ORCID's iD icon as their sign-in brand guidelines give them. */
export const PROVIDER_ICON: Record<Provider, Html> = {
  github: html`<svg class="provider-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="#24292f" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  google: html`<svg class="provider-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  orcid: html`<svg class="provider-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="#A6CE39" d="M256 128c0 70.7-57.3 128-128 128S0 198.7 0 128 57.3 0 128 0s128 57.3 128 128z"/><path fill="#fff" d="M86.3 186.2H70.9V79.1h15.4v107.1zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7C191.7 111.2 178 93 148 93h-23.7v79.4zM88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1c0-5.6 4.5-10.1 10.1-10.1s10.1 4.6 10.1 10.1z"/></svg>`,
};

/** Where a log-in button points: the real provider when configured, else (local test server
 *  only) a made-up account. Null when neither is available. */
export function providerHref(env: Env, p: Provider, next: string, link: boolean): string | null {
  const n = encodeURIComponent(next);
  const l = link ? "link=1&" : "";
  const real = { github: env.GITHUB_CLIENT_ID, google: env.GOOGLE_CLIENT_ID, orcid: env.ORCID_CLIENT_ID }[p];
  if (real) return `/auth/${p}?${l}next=${n}`;
  if (!devLogin(env)) return null;
  if (p === "github") return `/auth/dev-login?${l}login=dev-user&ghid=1&name=Ada%20Lovelace&next=${n}`;
  if (p === "google") return `/auth/dev-google?${l}sub=1&email=dev%40example.edu&name=Ada%20Lovelace&next=${n}`;
  return `/auth/dev-orcid?${l}orcid=0000-0002-1825-0097&name=Ada%20Lovelace&next=${n}`;
}

/** The log-in buttons for `next`, or null when logging in isn't switched on. */
export function loginButtons(env: Env, next: string): Html | null {
  const buttons = PROVIDERS.map((p) => [p, providerHref(env, p, next, false)] as const).filter(([, h]) => h);
  if (!buttons.length) return null;
  return html`<div class="login-buttons">${buttons.map(([p, h]) => html`<a class="btn btn-outline-dark" href="${h}">${PROVIDER_ICON[p]}<span>Continue with ${PROVIDER_LABEL[p]}</span></a>`)}</div>`;
}

/** The log-in pop-up: hidden until app.js opens it over the page (see setupLoginDialog there).
 *  Pages are publicly cached, so it carries no personal data; app.js points each button's `next`
 *  at the page (or the link's own `next`) when it opens. */
export function loginDialog(env: Env): Html | null {
  const buttons = loginButtons(env, "/");
  if (!buttons) return null;
  return html`<dialog class="login-dialog" id="login-dialog" aria-labelledby="login-dialog-title">
  <div class="settings-card settings-login">
    <button type="button" class="login-dialog-close" aria-label="Close" data-login-close>&times;</button>
    <h2 class="settings-title" id="login-dialog-title">Log in or create an account</h2>
    ${buttons}
    <p class="settings-fine"><a href="/privacy">Privacy</a></p>
  </div>
</dialog>`;
}
