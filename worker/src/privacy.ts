import type { Env } from "./db";
import { html } from "./html";
import { page } from "./layout";

/** /privacy: what the site stores. Keep it in step with auth.ts and docs/ACCOUNTS.md. */
export function privacyPage(env: Env): Response {
  return page(env, {
    title: "Privacy",
    description: `What ${env.SITE_NAME} stores about you.`,
    canonical: "https://opencryptology.org/privacy",
    cache: "public, max-age=3600",
    body: html`<section class="message privacy">
  <h3>Privacy</h3>
  <p>${env.SITE_NAME} is a non-commercial site run by one person. It keeps as little about you as it
  can, and it doesn't sell or share anything with advertisers.</p>

  <h4>Reading the site</h4>
  <p>You don't need an account to read or download papers. The site uses Cloudflare Web Analytics,
  which counts page views without cookies, and Cloudflare (our host) keeps its usual short-lived
  request logs. For seven days we also keep a log line for each request: the address you asked for
  (including search terms), your IP address, network and approximate location, your browser's
  user-agent and language, and the page that linked you here. We use it to understand how the site
  is used and to tell readers from crawlers.</p>

  <h4>Accounts</h4>
  <p>You sign in with GitHub, Google or ORCID. We never see your password, and we don't keep the
  access the sign-in grants: it is used only while you sign in, to read who you are. For each sign-in we keep:</p>
  <ul>
    <li><strong>GitHub:</strong> your account's id, username, name, profile photo link and primary email address.</li>
    <li><strong>Google:</strong> your account's id, name, profile photo link and email address.</li>
    <li><strong>ORCID:</strong> your ORCID iD, name and email address if your ORCID record makes it public.</li>
  </ul>
  <p>Your email addresses are shown only to you, on your account page.</p>
  <p>Your name here comes from those accounts unless you set your own, and we keep when you joined.
  Your name and log-in methods are shown next to what you post (your Google domain only if it isn't
  a personal one like gmail.com). Profile photos are loaded from GitHub or Google when shown; we
  don't keep copies.</p>

  <h4>Original manuscripts</h4>
  <p>What you post is public right away, with your name and photo shown as the uploader, and it stays
  public as described in the <a href="/terms">terms</a>. We keep each version you post, with when you posted
  it.</p>
  <p>Authors' ORCID iDs are shown with their names; their emails are never shown.</p>

  <h4>Comments</h4>
  <p>Comments are public right away, with your name and photo, and we keep when you posted and last
  edited them. Editing replaces the text, and earlier versions stay public in the comment's edit history.
  Deleting a comment erases its text and earlier versions; maintainers can hide one instead, keeping the text.
  A report keeps who sent it and a copy of what was reported. Votes on comments are kept with your account so you can change them; pages
  show only the totals, never who voted, and your votes are deleted with your account.</p>

  <h4>Cookies</h4>
  <p>Only when you sign in: a session cookie that keeps you signed in, a cookie with your display name
  so pages can show it, and a short-lived cookie during sign-in itself. We store only a hash of the
  session. Sessions end after 30 days without use, and after 180 days at most. There are no
  tracking or advertising cookies.</p>

  <h4>Contact form and uploads</h4>
  <p>Messages sent with the contact form are emailed to the maintainer, with your email address if you
  choose to give one. The form uses Cloudflare Turnstile to block spam. For paper uploads we keep a
  salted hash of your IP address to limit abuse, never the address itself.</p>

  <h4>Deleting your account</h4>
  <p>You can delete your account on its <a href="/account">account page</a>. That removes your sign-ins
  and sessions right away. What you posted stays, credited to “deleted user”.</p>

  <p>Questions: use the <a href="/contact">contact form</a>.</p>
  <p class="text-muted small">Last updated 14 November 2026.</p>
</section>`,
  });
}
