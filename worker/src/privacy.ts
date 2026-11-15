import type { Env } from "./db";
import { html } from "./html";
import { page } from "./layout";

/** /privacy: what the site stores. Keep it in step with auth.ts and docs/ACCOUNTS.md. */
export function privacyPage(env: Env): Response {
  return page(env, {
    title: "Privacy",
    description: `What ${env.SITE_NAME} stores about you, and what it doesn't.`,
    canonical: "https://opencryptology.org/privacy",
    cache: "public, max-age=3600",
    body: html`<section class="message privacy">
  <h3>Privacy</h3>
  <p>${env.SITE_NAME} is a non-commercial site run by one person. It keeps as little about you as it
  can, and it doesn't sell or share anything with advertisers.</p>

  <h4>Reading the site</h4>
  <p>You don't need an account to read or download papers. The site uses Cloudflare Web Analytics,
  which counts page views without cookies, and Cloudflare (our host) keeps its usual short-lived
  request logs.</p>

  <h4>Accounts</h4>
  <p>You sign in with GitHub, Google or ORCID. We never see your password, and we don't keep the
  access the sign-in grants: it is used once to read who you are. For each sign-in we keep:</p>
  <ul>
    <li><strong>GitHub:</strong> your account's id and username.</li>
    <li><strong>Google:</strong> your account's id and the domain of your email address (for example
    mit.edu). Not the address itself.</li>
    <li><strong>ORCID:</strong> your ORCID iD.</li>
  </ul>
  <p>We also keep your display name (taken from your first sign-in; you can change it), any links you
  add to your profile, and when you joined. We don't store email addresses or profile pictures.</p>
  <p><strong>Public:</strong> your display name, profile links, your sign-ins (your GitHub username and
  ORCID iD with links to them, and your Google domain unless it is a personal one like
  gmail.com), and what you post.</p>

  <h4>Cookies</h4>
  <p>Only when you sign in: a session cookie that keeps you signed in, a cookie with your display name
  so pages can show it, and a short-lived cookie during sign-in itself. We store only a hash of the
  session. There are no tracking or advertising cookies.</p>

  <h4>Agent tokens</h4>
  <p>If you create tokens for agents, we store a hash of each token, its name, and when it was last
  used.</p>

  <h4>Contact form and uploads</h4>
  <p>Messages sent with the contact form are emailed to the maintainer, with your email address if you choose to give one.
  The form uses Cloudflare Turnstile to block spam. For paper uploads we keep a salted hash of your
  IP address to limit abuse, never the address itself.</p>

  <h4>Deleting your account</h4>
  <p>You can delete your account on its <a href="/account">account page</a>. That removes your sign-ins,
  sessions, links and tokens right away. What you posted stays, credited to “deleted user”.</p>

  <p>Questions: use the <a href="/#contact">contact form</a>.</p>
  <p class="text-muted small">Last updated 14 November 2026.</p>
</section>`,
  });
}
