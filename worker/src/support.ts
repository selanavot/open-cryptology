import type { Env } from "./db";
import { html } from "./html";
import { page } from "./layout";

/** /support: what hosting costs and where to chip in. Donations never unlock anything. */
export function supportPage(env: Env): Response {
  return page(env, {
    title: "Support hosting",
    description: `Help cover ${env.SITE_NAME}'s hosting costs.`,
    canonical: "https://opencryptology.org/support",
    cache: "public, max-age=3600",
    body: html`<section class="message">
  <h3>Support hosting</h3>
  <p>${env.SITE_NAME} costs about $7 a month to run. If it's useful to you, you can help cover that
  on GitHub Sponsors.</p>
  <p><a class="btn btn-outline-dark" href="${env.SPONSOR_URL}">Sponsor on GitHub</a></p>
</section>`,
  });
}
