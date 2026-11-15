# Accounts

Sign-in with GitHub, Google or ORCID, for features that need to know who is posting (comments
first). Code: `worker/src/auth.ts` (data, sign-in routes) and `worker/src/account.ts` (`/account`).
Tables: the `accounts` section at the end of `db/schema.sql`.

## Design

- **Users and identities.** A *user* is a person; content points at `users.id`. An *identity* is a
  verified sign-in (GitHub, Google or ORCID) that belongs to one user, keyed on the provider's stable
  id (GitHub's numeric id, Google's `sub`, the ORCID iD; never a login or email). People start with
  any of the three and add the others with the "Add" buttons on `/account`; each then reaches the
  same account. The last identity can't be removed.
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
  bytes. Expiry is enforced in D1: 30 days from the last use, 180 days at most. Removing a sign-in,
  or "Sign out other browsers", ends every other session of the account.
- **Cached pages.** Paper pages are publicly cached, so they never contain signed-in state. The
  display-only `oc_login` cookie (the URI-encoded display name) lets `app.js` show who is signed in;
  the server never trusts it. The session is looked up only on POSTs, `/api/me` and `/account`.
- **CSRF.** Cookie-authenticated POSTs must carry our Origin (or `Sec-Fetch-Site: same-origin`).
  Redirect targets (`next=`) must be same-origin paths.
- **Maintainers.** An account is a maintainer exactly while one of its sign-ins is a GitHub id in
  `MAINTAINER_GITHUB_IDS`; nothing is stored, so removing either takes the role away.
- **Display names** are unique (case-insensitive, after NFKC). A new account takes the provider's
  name (GitHub login, Google or ORCID name) when it is free, else `user-<id>`.
- **Deletion** keeps a "deleted user" tombstone so content keeps an author; sign-ins and sessions go.
- **Providers.** GitHub OAuth (no scopes, PKCE); Google OpenID Connect (`openid email profile`,
  PKCE); ORCID public API (`/authenticate`). All three share one code path (`PROVIDERS` in auth.ts).
- **Not yet:** public profile pages, agent tokens, bot accounts, suspensions. Add them when a
  feature needs them.

## Using it from another feature

```ts
const a = await requireUser(env, req); // or { role: "maintainer" }
if (isAuthFailure(a)) return authJson(a); // API; an HTML form redirects back to its page instead
// a.user.id, a.user.displayName, a.user.identities
const people = await publicUsers(env, userIds); // names and sign-ins for bylines
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
