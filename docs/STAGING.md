# Staging and test environments

Three places the Worker runs. Only production emails anyone but the maintainer.

## Set-up status (2026-11-25)

Done: D1 `open-cryptology-staging` and R2 `open-cryptology-staging-pdfs` exist and are seeded
(5,336 papers of 2025–2026, 20 with PDFs). Still to do, by the maintainer or with his OK:

1. Cloudflare Zero Trust → Access → a self-hosted application for `staging.opencryptology.org`:
   one Allow policy for the maintainer's email (one-time code), one Service Auth policy with a new
   service token for agents. Put the application's audience tag in `env.staging.vars.ACCESS_AUD`.
   Put the token in `worker/.staging.env` of the main checkout.
2. First deploy: `scripts/deploy-staging.sh`. This creates the Worker and the DNS record. Until
   step 1 is done it answers 403 to everyone.
3. `npx --prefix worker wrangler secret put CONTACT_TO --env staging`: the maintainer's address,
   the same verified Email Routing destination as production. Until then the contact form on
   staging says it isn't set up.
4. OAuth callbacks and secrets for staging (see "Sign-in on staging").

| | Local | Staging | Production |
|---|---|---|---|
| URL | `http://localhost:8787` (`npm --prefix worker run dev`, the `worker` preview) | https://staging.opencryptology.org, behind Cloudflare Access | https://opencryptology.org |
| Worker | `wrangler dev` | `open-cryptology-staging` (`env.staging` in `worker/wrangler.jsonc`) | `open-cryptology` |
| Data | emulated D1/R2, ~20 PDFs (`pipeline/ingest_sample.py`) | D1 `open-cryptology-staging`, R2 `open-cryptology-staging-pdfs`: papers of the last 2 years, 20 PDFs, no users or comments copied | the real thing |
| `ENVIRONMENT` | `local` (set by `scripts/dev.sh`) | `staging` | `production` |
| Email | captured at `/__dev/mail` | captured at `/__dev/mail`; mail to the maintainer alone is also sent, as `[staging] …` | sent |
| Sign-in | made-up accounts (`/auth/dev-*`) | real GitHub/Google/ORCID, and made-up accounts | real |
| Cron | `POST /__dev/cron` | daily, and `POST /__dev/cron` | every 4 h |
| Deploy | — | `scripts/deploy-staging.sh`, any branch | merge to `main` (`scripts/deploy.sh --ci`) |

Use staging for what local can't show: real OAuth callbacks (ORCID especially), Cloudflare's
caching and headers, Access, Turnstile, a real deploy with real bindings, and email content at
staging scale. Don't test on production.

## Email

Every email goes through `sendMail(env, kind, message)` in `worker/src/mail.ts`. With
`ENVIRONMENT=production` it hands the message to the `send_email` binding. Anywhere else, and when
the variable is missing, it stores the message as JSON under `mail-sink/` in that environment's
own R2 bucket. `/__dev/mail` lists them, newest first (`?format=json` for scripts, `?to=<text>` to
filter by recipient, a button to clear). Of those, a message addressed to the maintainer alone
(`CONTACT_TO`, with no other recipient, cc or bcc) is also sent, with `[staging]` in the subject.
That covers the contact form, upload-review reminders and the harvest alarm. Mail to anyone else,
such as authors or people replying, is never sent outside production. A unit test fails if any
other file uses `env.MAILER`, so new notifications get this for free.

Today the binding goes through Cloudflare Email Routing, which delivers only to verified
addresses (one: the maintainer's), so Cloudflare would refuse anything else anyway. Emailing
users will need Cloudflare Email Service, which can send anywhere. From then on `sendMail` is the
only guard, so revisit this section then (for example, give staging its own sending domain).

## Deploying to staging

```bash
scripts/deploy-staging.sh
```

It deploys this checkout, any branch, local changes included, to the staging Worker only. First
it runs the typecheck and the tests, including `worker/test/config.test.ts`. That test checks that
staging's name, routes, D1, bucket and rate limits differ from production's, that `CONTACT_TO`
is a secret there, and that the Access gate is on. If another branch went up in the last 2 hours,
the script stops: someone may be testing it. `--take` replaces it anyway (tell them).

Schema changes: run the new statements on staging first:

```bash
node scripts/staging-data.mjs sql /path/to/new-statements.sql
```

## Data

```bash
node scripts/staging-data.mjs status
node scripts/staging-data.mjs seed [--years 2] [--pdfs 20] [--ids 2024/123,2025/001]
node scripts/staging-data.mjs schema   # only on an empty database
```

`seed` reads paper metadata from production (SELECTs only) and copies the PDFs and versions of a
small sample from the production bucket. Papers outside the sample show as having no PDF yet.
Users, comments, sessions, uploads and logs are never copied. Staging's own accounts and comments
stay there. Re-running `seed` replaces the paper rows and keeps everything else.

## Access

Every request to staging must carry a valid Cloudflare Access JWT. `worker/src/access.ts` checks
its signature, the application's `aud` (`ACCESS_AUD`) and the team (`ACCESS_TEAM_DOMAIN`). Without
a valid JWT the Worker answers 403. With `ACCESS_AUD` empty it refuses everything.

- **People** open https://staging.opencryptology.org and log in with the email code from Access.
- **Agents and scripts** use the service token in `worker/.staging.env` (gitignored; worktrees fall
  back to the main checkout's copy):

  ```
  CF_ACCESS_CLIENT_ID=...
  CF_ACCESS_CLIENT_SECRET=...
  ```

  ```bash
  scripts/staging-curl.sh '/__dev/mail?format=json'
  scripts/staging-curl.sh /__dev/cron -X POST -H 'origin: https://staging.opencryptology.org'
  node --import ./scripts/staging-access.mjs scripts/auth-smoke.mjs https://staging.opencryptology.org
  ```

## Sign-in on staging

- **Made-up accounts** work on staging because every request has passed Access (`devLogin` in
  `worker/src/auth.ts`). For example, sign in as the author with a given ORCID iD:
  `/auth/dev-orcid?orcid=0000-0002-1825-0097&name=Ada%20Lovelace`. Other routes are in
  [ACCOUNTS.md](ACCOUNTS.md#configuration). GitHub id 4242 is a maintainer on staging.
- **Real providers** need the staging callbacks registered (maintainer, once):
  - GitHub: a separate OAuth app (GitHub allows one callback per app), callback
    `https://staging.opencryptology.org/auth/github/callback`. Put its client id in
    `env.staging.vars.GITHUB_CLIENT_ID`.
  - Google: add `https://staging.opencryptology.org/auth/google/callback` to the production client.
  - ORCID: add `https://staging.opencryptology.org/auth/orcid/callback` to the production client.
    Real iDs, so author matching can be tried with real people. For throwaway iDs, use a sandbox
    client with `ORCID_BASE=https://sandbox.orcid.org`.
  - Secrets: `npx --prefix worker wrangler secret put GITHUB_CLIENT_SECRET --env staging` (and
    `GOOGLE_CLIENT_SECRET`, `ORCID_CLIENT_SECRET`).

## Also on staging

- A striped banner on every page; `X-Robots-Tag: noindex, nofollow` on every response.
- Cloudflare's Turnstile test keys (always pass), no analytics beacon, no IndexNow.
- Its own rate-limit counters.

## Production safety

- `scripts/deploy.sh` still deploys only `origin/main`, only to production. It now also ignores
  `CLOUDFLARE_ENV`/`WRANGLER_ENV`, so a shell variable can't point it at another environment.
- Staging is a separate Worker script, so a staging deploy can't replace a production version.
- `worker/test/config.test.ts` runs in Checks on every PR. It pins production to
  `ENVIRONMENT=production`, with no `AUTH_DEV_LOGIN` or `AUTH_ORIGIN`.

## Later, if needed

Per-branch preview URLs on the staging Worker (`wrangler preview`, open beta), for when several
branches need staging at the same time. They would share staging's data. OAuth callbacks and
crons only work on the main staging URL.
