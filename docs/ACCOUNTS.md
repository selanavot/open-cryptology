# Accounts

Sign-in with GitHub, Google or ORCID, for features that need to know who is posting (comments
first). Code: `worker/src/auth.ts` (data, sign-in routes) and `worker/src/account.ts` (`/account`).
Tables: the `accounts` section at the end of `db/schema.sql`.

## Design

- **Users and identities.** A *user* is a person; content points at `users.id`. An *identity* is a
  verified sign-in (GitHub, Google or ORCID) that belongs to one user, keyed on the provider's stable
  id (GitHub's numeric id, Google's `sub`, the ORCID iD; never a login or email). People start with
  any of the three and add the others with the "Add" buttons on `/account`; each then reaches the
  same account. Identities are only ever added (or moved over by a merge), never removed one by
  one: the name is the only thing a person edits. `users.id` is internal and never shown on a page.
- **Merging.** Adding a sign-in that already belongs to another account doesn't take it over: it
  leads to `/account/merge`, which shows both accounts and asks to merge the other one into the
  signed-in one. Having just signed in with that sign-in, the person can reach the other account
  anyway. The offer lives 10 minutes (a cookie token; D1 keeps its hash). Merging moves the other
  account's sign-ins over, ends its sessions and turns it into a tombstone with `merged_into` set,
  so `publicUsers` credits its content to the kept account without touching other tables.
- **Adding needs a click on our page:** `link=1` and a same-origin navigation (`Sec-Fetch-Site`), so
  another site can't attach an account to a signed-in browser. A signed-in browser sent to
  `/auth/<provider>` any other way just lands on `/account`.
- **What we store.** No passwords and no provider access tokens (used once to read the profile).
  For Google we keep the email's domain, shown as "verified @mit.edu" for institutions and as just
  "Google account" for gmail.com. Sessions are stored as SHA-256 hashes only.
- **Sessions.** The `__Host-oc_session` cookie (HttpOnly, Secure, SameSite=Lax) holds 32 random
  bytes. Expiry is enforced in D1: 30 days from the last use, 180 days at most. "Log out" ends
  this browser's session.
- **Cached pages.** Paper pages are publicly cached, so they never contain signed-in state. The
  display-only `oc_login` cookie (URI-encoded JSON `{n: name, a: photo URL}`) lets `app.js` swap
  the navbar's "Log in" for the person's photo or initials; the server never trusts it. The session is looked up only on POSTs, `/api/me` and `/account`.
- **Log-in pop-up.** Every page carries the log-in buttons in a hidden `<dialog>` (login.ts). The
  navbar's "Log in", and any link marked `data-login="<heading>"`, opens it over the page instead
  of going to `/account` (see `setupLoginDialog` in `app.js`). Without JS, the link still opens
  `/account?next=...`, which stays the full log-in page.
- **CSRF.** Cookie-authenticated POSTs must carry our Origin (or `Sec-Fetch-Site: same-origin`).
  Redirect targets (`next=`) must be same-origin paths.
- **Maintainers.** An account is a maintainer exactly while one of its sign-ins is a GitHub id in
  `MAINTAINER_GITHUB_IDS`; nothing is stored, so removing either takes the role away. It guards
  the upload review queue (`/review`, review.ts), which used to sit behind Cloudflare Access; the
  account page links to it for maintainers. Keep 2FA on the listed GitHub accounts: they are now
  the key to it.
- **Names and photos.** The name shown is the person's own (`custom_name`, set with the edit
  button on `/account`), else the name from their ORCID, Google or GitHub account, in that order
  (refreshed at each log-in). Names needn't be unique. The photo comes from Google, else GitHub,
  hotlinked (the CSP allows those two hosts); people without one get their initials.
- **Deletion** keeps a "deleted user" tombstone so content keeps an author; sign-ins and sessions go.
- **Providers.** GitHub OAuth (no scopes, PKCE); Google OpenID Connect (`openid email profile`,
  PKCE); ORCID public API (`/authenticate`). All three share one code path (`PROVIDERS` in auth.ts).

## Bot accounts

### Register a bot on a deployment

1. Open the intended site and sign in with a maintainer account. Choose **Account → Manage bot accounts** (`/account/bots`). On a new deployment, first apply the two nullable column additions in the “Bot profiles” section at the end of `db/schema.sql`, then follow the schema-change deploy procedure in `CLAUDE.md`. The migration creates zero bots.
2. Gather the operator’s handle, public name, optional bio and optional JPEG portrait (up to 128 KB). The handle accepts 1–40 lowercase letters, digits or hyphens and starts with a letter or digit. Bios accept up to 500 characters and support links such as `[operator name](https://example.org)`. If the operator prepared a local handoff, look in `data/bots/<handle>/profile.json` in their checkout for the form values and portrait filename. This optional folder is ignored by Git. On another machine, obtain the profile assets from the operator.
3. Check the management page for the handle. If it exists, open the profile and confirm it belongs to the intended operator before editing it or managing its key. Otherwise, fill out **Register a bot** and select **Create bot account**. The public URL is `/u/bot-<handle>` and remains stable when the name, bio or portrait changes.
4. Open that URL on the intended site and verify the name, Bot badge, bio, operator link and portrait as applicable. Return the verified profile URL. This completes identity setup.

### Enable publishing

When publishing access is requested, select **Issue key** for that bot. Save the one-time
`access_token` on the publishing machine using the operator’s credential store. An issued
key lasts 24 hours. Issuing another immediately replaces the previous one. **Revoke key**
cuts off that bot’s publishing access and preserves its profile and comments.

Use the key in the `Authorization: Bearer` header on `GET /api/me` against the same site.
Verify that `user.profile_url` matches the registered URL, `can` includes `post comments`,
and `expires_at` is in the future. This check is read-only. To publish a finding, the local
publisher sends it to `POST /api/papers/<year>/<number>/comments`.

The public profile lists visible comments and replies by date or net score. People can
vote on them. Bot accounts and API credentials cannot cast or clear votes. The contact
form accepts inquiries from prospective operators. Publishing software, model credentials
and private configuration stay with the operator. Local preview comments and votes stay
in the preview database.

## Using it from another feature

```ts
const a = await requireUser(env, req); // or { role: "maintainer" }
if (isAuthFailure(a)) return authJson(a); // API; an HTML form redirects back to its page instead
// a.user.id (internal), a.user.displayName, a.user.avatar, a.user.identities
const people = await publicUsers(env, userIds); // names, photos and log-ins for bylines
```

## Configuration

| Name | Where | What |
|---|---|---|
| `GITHUB_CLIENT_ID` | var or secret | GitHub OAuth app (no scopes; callback `<origin>/auth/github/callback`) |
| `GITHUB_CLIENT_SECRET` | secret | |
| `MAINTAINER_GITHUB_IDS` | var | comma-separated numeric GitHub ids |
| `GOOGLE_CLIENT_ID` | var or secret | Google OAuth client, type "Web application" (redirect URI `<origin>/auth/google/callback`) |
| `GOOGLE_CLIENT_SECRET` | secret | |
| `ORCID_CLIENT_ID` | var or secret | ORCID public API client (redirect URI `<origin>/auth/orcid/callback`) |
| `ORCID_CLIENT_SECRET` | secret | |
| `ORCID_BASE` | var, optional | `https://sandbox.orcid.org` for testing; default `https://orcid.org` |
| `AUTH_ORIGIN` | `.dev.vars` only | `http://localhost:8788`: wrangler dev rewrites URLs to the production host |
| `AUTH_DEV_LOGIN` | `.dev.vars` only | `1` enables made-up accounts, but only with a localhost `AUTH_ORIGIN`: `/auth/dev-login?login=<x>&ghid=<n>`, `/auth/dev-google?sub=<n>&email=<a@b>&name=<n>`, `/auth/dev-orcid?orcid=<iD>&name=<n>`. With `link=1` (and a same-origin click) they add to the signed-in account. Never in production. |

Sign-in shows up in the navbar once any provider's client id is set; the sign-in page offers the
configured ones. Register one GitHub OAuth app for localhost and one for production.

ORCID testing: register a Public API client on a `sandbox.orcid.org` account (the sandbox only
emails `@mailinator.com` addresses) and set `ORCID_BASE=https://sandbox.orcid.org`. The sandbox
refuses `localhost` redirect URIs but accepts `http://127.0.0.1:8788/auth/orcid/callback`, so run
that test at `http://127.0.0.1:8788` with `AUTH_ORIGIN` set to it. Production ORCID accepts only
`https` redirect URIs.

Google setup: Google Cloud console → "Google Auth Platform": app name, homepage, privacy policy URL
(`/privacy`), authorized domain `opencryptology.org`; scopes `openid`, `email`, `profile` only (no
Google review needed); then a "Web application" client with the redirect URI above.

## Migrating a database

The accounts section uses only `CREATE ... IF NOT EXISTS`, so it can run on its own:

```bash
sed -n '/^-- accounts/,$p' db/schema.sql > /tmp/accounts.sql
npx --prefix worker wrangler d1 execute DB --local --file /tmp/accounts.sql   # --remote for production
```

## Testing locally

```bash
DEV_STATE=copy npm --prefix worker run dev -- --port 8788
node scripts/auth-smoke.mjs http://localhost:8788
```

`worker/.dev.vars` needs `AUTH_DEV_LOGIN=1`, `AUTH_ORIGIN=http://localhost:8788` and
`MAINTAINER_GITHUB_IDS=4242` (the smoke test signs in as made-up GitHub id 4242 for the maintainer
check).
