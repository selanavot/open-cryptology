import { type Env } from "./db";
import { html, type Html } from "./html";
import { messagePage } from "./layout";

// Contact form → email to the maintainer via Cloudflare Email Routing (send_email binding).
// The destination address lives in the CONTACT_TO secret (never in git) and must be a verified
// destination in Email Routing. CONTACT_FROM must be an address on the zone with Email Routing.
// TODO before going public: Turnstile + per-IP rate limiting (honeypot + same-origin only for now).

const TOPICS: Record<string, string> = {
  paper: "Problem with a paper (wrong/outdated PDF, metadata)",
  takedown: "Takedown / author request",
  bug: "Bug or feature request",
  other: "Something else",
};
const MAX_MSG = 5000;
const PAPER_ID_RE = /^\d{4}\/\d{1,6}$/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function contactConfigured(env: Env): boolean {
  return Boolean(env.MAILER && env.CONTACT_TO && env.CONTACT_FROM);
}

/** Contact form, rendered as a panel on the home page (posts to /contact). */
export function contactForm(env: Env, url: URL): Html {
  const paper = url.searchParams.get("paper") ?? "";
  const topic = url.searchParams.get("topic") ?? (paper ? "paper" : "other");
  return html`${!contactConfigured(env) && html`<div class="alert alert-warning small">The contact form isn’t configured on this deployment yet — please
<a href="${env.ISSUES_URL}">open a GitHub issue</a> instead.</div>`}
<form class="contact-form" action="/contact" method="post">
  <div><label class="form-label" for="c-topic">Topic</label>
    <select class="form-select" id="c-topic" name="topic">${Object.entries(TOPICS).map(
      ([k, v]) => html`<option value="${k}"${k === topic ? html` selected` : ""}>${v}</option>`,
    )}</select>
  </div>
  <div><label class="form-label" for="c-paper">Paper ID <span class="text-muted small">(optional, e.g. 2024/123)</span></label>
    <input class="form-control" id="c-paper" name="paper" value="${PAPER_ID_RE.test(paper) ? paper : ""}" inputmode="numeric" maxlength="12" pattern="\\d{4}/\\d{1,6}">
  </div>
  <div><label class="form-label" for="c-email">Your email <span class="text-muted small">(optional, only if you want a reply)</span></label>
    <input class="form-control" type="email" id="c-email" name="email" maxlength="200" autocomplete="email">
  </div>
  <div><label class="form-label" for="c-message">Message</label>
    <textarea class="form-control" id="c-message" name="message" required maxlength="${MAX_MSG}" rows="4"></textarea>
  </div>
  <div class="hp" aria-hidden="true"><label for="c-website">Website</label> <input id="c-website" name="website" tabindex="-1" autocomplete="off"></div>
  <div><button class="btn btn-outline-dark" type="submit">Send</button></div>
</form>`;
}

export async function handleContact(env: Env, req: Request, url: URL): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) {
    return messagePage(env, 403, "Message rejected", html`<p>Cross-site submissions are not accepted.</p>`);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return messagePage(env, 400, "Message rejected", html`<p>That didn’t look like a form submission.</p>`);
  }
  const s = (k: string) => String(form.get(k) ?? "").trim();
  const thanks = () =>
    messagePage(env, 200, "Thanks!", html`<p>Your message was sent. <a href="/">Back to the homepage</a>.</p>`);

  if (s("website")) return thanks(); // honeypot: pretend success, send nothing
  const message = s("message");
  const topic = TOPICS[s("topic")] ? s("topic") : "other";
  const paper = PAPER_ID_RE.test(s("paper")) ? s("paper") : "";
  const email = EMAIL_RE.test(s("email")) ? s("email") : "";
  if (!message) return messagePage(env, 400, "Message is empty", html`<p><a href="/contact">Go back</a> and write something.</p>`);
  if (message.length > MAX_MSG) return messagePage(env, 413, "Message too long", html`<p>Please keep it under ${MAX_MSG} characters.</p>`);

  if (!contactConfigured(env)) {
    console.warn("contact form submitted but MAILER/CONTACT_TO/CONTACT_FROM not configured");
    return messagePage(env, 503, "Contact isn’t set up yet",
      html`<p>Sorry — please <a href="${env.ISSUES_URL}">open a GitHub issue</a> instead.</p>`);
  }

  const lines = [
    `Topic: ${TOPICS[topic]}`,
    paper && `Paper: ${url.origin}/${paper} (original: ${env.ORIGIN_BASE}/${paper})`,
    `Reply-to: ${email || "(none given)"}`,
    `Sent: ${new Date().toISOString()}`,
    "",
    message,
  ].filter((l) => l !== "");
  try {
    await env.MAILER!.send({
      from: { name: `${env.SITE_NAME} contact form`, email: env.CONTACT_FROM! },
      to: env.CONTACT_TO!,
      ...(email ? { replyTo: email } : {}),
      subject: `[${env.SITE_NAME}] ${topic}${paper ? ` ${paper}` : ""}: ${message.slice(0, 60).replace(/\s+/g, " ")}`,
      text: lines.join("\n"),
    });
  } catch (e) {
    console.error("contact send failed", e instanceof Error ? e.message : String(e));
    return messagePage(env, 502, "Couldn’t send your message",
      html`<p>Something went wrong on our side. Please try again later or <a href="${env.ISSUES_URL}">open a GitHub issue</a>.</p>`);
  }
  return thanks();
}
