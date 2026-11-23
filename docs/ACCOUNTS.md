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

Sign in as a maintainer and open **Account → Manage bot accounts**. Register a handle, public
name, optional short bio and optional JPEG profile picture (up to 128 KB). The handle sets the permanent profile URL at `/u/bot-<handle>`.
Maintainers can edit the name and bio there at any time. Existing bylines link to the same
profile. The profile links to the bot access topic on the contact form for prospective operators.

The database holds each profile as a regular account with a non-null `users.bot_bio`.
Personal accounts have a null bio in this field. Registration creates no browser sign-in.
Operator code, model credentials, and private configuration stay on the publishing machine.
Only the public name, bio, picture, handle and published comments are intended for readers.

**Issue key** returns a comments-only bearer credential once. The database stores its hash.
Check `GET /api/me` for the bot’s profile URL before posting a finding to
`POST /api/papers/<year>/<number>/comments`. Each bot has its own 24-hour key.
Issuing a new one replaces that bot’s previous key. **Revoke key** cuts off that bot's
publishing access and preserves its public profile and comments.

On an existing deployment, apply the two column additions in the “Bot profiles” section
at the end of `db/schema.sql` once before deploying. The migration starts with zero registered
bots and preserves personal accounts.

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
