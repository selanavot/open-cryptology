import { type Env } from "./db";
import { html } from "./html";
import { page } from "./layout";

// Every email the Worker sends goes through sendMail(). Production (ENVIRONMENT=production) hands
// it to the send_email binding. Anywhere else (staging, local runs, or a config that forgot the
// variable) every message is stored in a mail sink: JSON objects under mail-sink/ in that
// environment's own R2 bucket, listed at /__dev/mail. Of those, only mail addressed to the
// maintainer alone (CONTACT_TO, nobody else: no cc, no bcc) is also delivered, with "[staging]"
// in the subject, so staging's contact form and alarms still reach the maintainer. Mail to anyone
// else (authors, people replying) is never delivered outside production. A unit test fails if any
// other file uses env.MAILER (test/mail.test.ts). docs/STAGING.md.

export const SINK_PREFIX = "mail-sink/";
const SINK_KEEP = 200; // newest messages listed (older ones stay in R2 until cleared)

export const isProduction = (env: Env): boolean => env.ENVIRONMENT === "production";

/** Staging and local runs (scripts/dev.sh sets ENVIRONMENT=local): the /__dev/* routes exist. */
export const isTestEnv = (env: Env): boolean => env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "local";

/** Mail to the maintainer can go out (production) or be captured (elsewhere). */
export const maintainerMailReady = (env: Env): boolean =>
  Boolean(env.CONTACT_TO && env.CONTACT_FROM && (env.MAILER || !isProduction(env)));

export type MailResult = { delivered: true } | { captured: string; delivered: boolean };

const addresses = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? v.flatMap(addresses) : [typeof v === "object" ? String((v as EmailAddress).email) : String(v)];

/** The message goes to the maintainer (CONTACT_TO) and nobody else. */
export function onlyToMaintainer(env: Env, mail: EmailMessageBuilder): boolean {
  const me = (env.CONTACT_TO ?? "").trim().toLowerCase();
  const m = mail as EmailMessageBuilder & { cc?: unknown; bcc?: unknown };
  const to = addresses(m.to).map((a) => a.trim().toLowerCase());
  return Boolean(me) && to.length > 0 && to.every((a) => a === me) && !addresses(m.cc).length && !addresses(m.bcc).length;
}

/**
 * Send (production) or capture (anywhere else; mail for the maintainer alone is also sent) one
 * email. `kind` names the feature, for the log and the sink ("contact", "review-reminder", ...).
 * Throws if delivery fails.
 */
export async function sendMail(env: Env, kind: string, mail: EmailMessageBuilder): Promise<MailResult> {
  if (isProduction(env)) {
    if (!env.MAILER) throw new Error("sendMail: no MAILER binding");
    await env.MAILER.send(mail);
    return { delivered: true };
  }
  // Newest first in R2's lexicographic listing: the key starts with (max - now).
  const at = new Date();
  const inv = String(9_999_999_999_999 - at.getTime()).padStart(13, "0");
  const key = `${SINK_PREFIX}${inv}-${crypto.randomUUID().slice(0, 8)}.json`;
  const { attachments: _a, ...rest } = mail as EmailMessageBuilder & { attachments?: unknown };
  const deliver = Boolean(env.MAILER) && onlyToMaintainer(env, mail);
  await env.PDFS.put(key, JSON.stringify({ at: at.toISOString(), kind, environment: env.ENVIRONMENT ?? null, delivered: deliver, ...rest }), {
    httpMetadata: { contentType: "application/json" },
  });
  console.log("mail captured", kind, key, JSON.stringify({ to: mail.to, subject: mail.subject, delivered: deliver }));
  if (deliver) await env.MAILER!.send({ ...mail, subject: `[${env.ENVIRONMENT || "test"}] ${mail.subject}` });
  return { captured: key, delivered: deliver };
}

interface Captured {
  key: string;
  at: string;
  kind: string;
  delivered?: boolean;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  replyTo?: unknown;
  subject?: string;
  text?: string;
  html?: string;
}

async function listCaptured(env: Env, limit: number): Promise<Captured[]> {
  const listed = await env.PDFS.list({ prefix: SINK_PREFIX, limit });
  const out = await Promise.all(
    listed.objects.map(async (o) => {
      const body = await env.PDFS.get(o.key);
      if (!body) return null;
      try {
        return { key: o.key, ...(await body.json<Omit<Captured, "key">>()) };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((m): m is Captured => m !== null);
}

const addr = (v: unknown): string =>
  v == null
    ? ""
    : Array.isArray(v)
      ? v.map(addr).join(", ")
      : typeof v === "object"
        ? `${(v as EmailAddress).name} <${(v as EmailAddress).email}>`
        : String(v);

/**
 * /__dev/mail (staging and local only): the mail sink. GET lists captured messages, newest first
 * (?format=json for scripts and agents, ?to=<substring> filters by recipient); POST action=clear
 * empties it. The caller checks isTestEnv and same-origin for POST.
 */
export async function handleMailSink(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    if (form?.get("action") !== "clear") return new Response("Unknown action\n", { status: 400 });
    let cursor: string | undefined;
    do {
      const l = await env.PDFS.list({ prefix: SINK_PREFIX, cursor });
      if (l.objects.length) await env.PDFS.delete(l.objects.map((o) => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return new Response(null, { status: 303, headers: { location: "/__dev/mail", "cache-control": "no-store" } });
  }
  const to = (url.searchParams.get("to") ?? "").toLowerCase();
  const all = await listCaptured(env, to ? 1000 : SINK_KEEP);
  const mails = (to ? all.filter((m) => addr(m.to).toLowerCase().includes(to)) : all).slice(0, SINK_KEEP);
  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ environment: env.ENVIRONMENT ?? null, count: mails.length, mails }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }
  return page(env, {
    title: "Captured email",
    cache: "no-store",
    noindex: true,
    body: html`<h1>Captured email</h1>
<p>Outside production every email is stored here. Only mail to the maintainer alone is also sent;
mail to anyone else is never sent (<code>worker/src/mail.ts</code>).
${mails.length ? `${mails.length} message${mails.length === 1 ? "" : "s"}, newest first.` : "Nothing captured yet."}
<a href="/__dev/mail?format=json${to ? `&to=${encodeURIComponent(to)}` : ""}">JSON</a></p>
${mails.length > 0 &&
html`<form method="post" action="/__dev/mail"><input type="hidden" name="action" value="clear"><button class="btn">Clear all</button></form>`}
${mails.map(
  (m) => html`<article class="dev-mail">
  <p><strong>${m.subject ?? "(no subject)"}</strong><br>
  <small>${m.at} · ${m.kind}${m.delivered ? " · also sent to the maintainer" : ""}<br>From: ${addr(m.from)}<br>To: ${addr(m.to)}${m.cc ? html`<br>Cc: ${addr(m.cc)}` : ""}${m.bcc ? html`<br>Bcc: ${addr(m.bcc)}` : ""}${m.replyTo ? html`<br>Reply-to: ${addr(m.replyTo)}` : ""}</small></p>
  ${m.text && html`<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${m.text}</pre>`}
  ${m.html && html`<details><summary>HTML version</summary><iframe sandbox="" srcdoc="${m.html}" title="HTML version" style="width:100%;min-height:20rem;border:1px solid #ccc"></iframe></details>`}
</article>`,
)}`,
  });
}
