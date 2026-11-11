import type { Env } from "./db";
import { html } from "./html";
import { page } from "./layout";

/** /support: what hosting costs and where to chip in. Donations never unlock anything. */
export function supportPage(env: Env): Response {
  return page(env, {
    title: "Support hosting",
    description: `${env.SITE_NAME} is free to use. Donations only pay for hosting.`,
    canonical: "https://opencryptology.org/support",
    cache: "public, max-age=3600",
    body: html`<section class="message">
  <h3>Support hosting</h3>
  <p>${env.SITE_NAME} costs about $7 a month to run: Cloudflare Workers, storage for the PDFs, and the
  domain. If the site is useful to you, you can chip in on GitHub Sponsors, once or monthly.</p>
  <p>Donations only pay for hosting. Everything on the site stays free for everyone, and donors get
  nothing extra: no early access, no higher limits.</p>
  <p><a class="btn btn-outline-dark" href="${env.SPONSOR_URL}">Sponsor on GitHub</a></p>
  <p>Other ways to help: <a href="/missing">upload a missing PDF</a>, send a pull request on
  <a href="${env.REPO_URL}">GitHub</a>, or <a href="/#contact">get in touch</a>.</p>
</section>`,
  });
}
