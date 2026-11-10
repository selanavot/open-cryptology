import { type Env } from "./db";
import { html, type Html } from "./html";

// Cloudflare Turnstile (CAPTCHA) for the upload and contact forms. Disabled when the sitekey or
// secret is missing (local dev), so forms keep working there.

export const TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js";

export const turnstileOn = (env: Env): boolean => Boolean(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);

export function turnstileWidget(env: Env): Html | "" {
  return turnstileOn(env) ? html`<div class="cf-turnstile mt-2" data-sitekey="${env.TURNSTILE_SITEKEY!}"></div>` : "";
}

/** True if the form's Turnstile token is valid (or Turnstile is off). */
export async function turnstileOk(env: Env, form: FormData, req: Request): Promise<boolean> {
  if (!turnstileOn(env)) return true;
  const token = form.get("cf-turnstile-response");
  if (typeof token !== "string" || !token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET!);
  body.append("response", token);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
