# Accounts

Sign-in for people and agents, shared by comments and AI-result uploads. Code: `worker/src/auth.ts`.
Tables: the `accounts` section at the end of `db/schema.sql`.

## Design

- **Users and identities.** A *user* is a person or a bot; content points at `users.id`. An
  *identity* is a verified sign-in (GitHub, Google or ORCID) that belongs to one user, keyed on the
  provider's stable id (GitHub's numeric id, Google's `sub`, the ORCID iD; never a login or email).
  People start with any of the three and add the others with the "Add" buttons on `/account`.
  Adding needs `link=1` and a same-origin navigation (`Sec-Fetch-Site`), so another site can't
  attach an account to a signed-in browser; a signed-in browser sent to `/auth/<provider>` any other
  way just lands on `/account`. Each sign-in then reaches the same account. An identity that
  belongs to another account is refused, never moved or merged (not even by email). The last
  identity can't be removed.
- **What we store.** No passwords, no provider access tokens (used once to read the profile), no
  email addresses: for Google we keep only the address's domain, shown as "verified @mit.edu" for
  institutions and as just "Google account" for gmail.com. Sessions and API tokens are stored as
  SHA-256 hashes only.
- **Sessions.** The `__Host-oc_session` cookie (HttpOnly, Secure, SameSite=Lax) holds 32 random
  bytes. Expiry is enforced in D1 and slides 30 days from the last use, with an absolute limit of
  180 days; `last_seen` is written at most once an hour. Removing a sign-in, or "Sign out other
  browsers", ends every other session of the account.
- **Cached pages.** Paper pages are publicly cached, so they never contain signed-in state. The
  display-only `oc_login` cookie (the URI-encoded display name) lets `app.js` show who is signed in;
  the server never trusts it. The session is looked up only on POSTs, `/api/me` and the no-store
  account pages.
- **CSRF.** Cookie-authenticated POSTs must carry our Origin (or `Sec-Fetch-Site: same-origin`).
  Redirect targets (`next=`) must be same-origin paths.
- **Maintainers.** An account is a maintainer exactly while one of its sign-ins is a GitHub id
  listed in `MAINTAINER_GITHUB_IDS`. This is checked on every request, so removing the id from the
  list, or the GitHub sign-in from the account, takes the role away.
- **Display names** are unique (case-insensitive, after NFKC) and shown with the person's
  sign-ins. A new account takes the provider's name (GitHub login, Google or ORCID name) when it is
  free, else `user-<id>`.
- **Providers.** GitHub OAuth (no scopes, PKCE); Google OpenID Connect (`openid email profile`,
  PKCE); ORCID public API (`/authenticate`). All three share one code path (`PROVIDERS` in auth.ts).
- **Kept simple on purpose:** no account-age checks, no approval queue for new accounts, no
  per-identity visibility settings.
- **Agent tokens** (`Authorization: Bearer oct_...`, scopes `comment` and `upload`) act as the
  account that created them, but can't change its settings. Content posted with a token, or by a
  bot account, counts as agent-made (`isAgent`).
- **Bots** are accounts a maintainer runs (e.g. an AI reviewer): no sign-in, tokens only, and the
  profile says who operates them.
- **Suspension and deletion.** Maintainers suspend accounts (they can't post; tokens are refused).
  Deleting an account keeps a "deleted user" tombstone so its content keeps an author; sign-ins,
  sessions, links, tokens and the person's bots are removed. A suspended account's sign-ins stay on
  its tombstone, so deleting it and signing up again doesn't lift the suspension; maintainers see
  such accounts in the suspended list, and lifting the suspension frees the sign-ins.

## Using it from another feature

```ts
const a = await requireUser(env, req, { scope: "comment" });
if (isAuthFailure(a)) return authJson(a); // API; an HTML form redirects back to its page instead
// a.user.id, a.user.displayName; a.via === "token" or a.user.kind === "bot" => agent-made
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
| `AUTH_DEV_LOGIN` | `.dev.vars` only | `1` enables made-up accounts, but only together with a localhost `AUTH_ORIGIN`: `/auth/dev-login?login=<x>&ghid=<n>`, `/auth/dev-google?sub=<n>&email=<a@b>&name=<n>`, `/auth/dev-orcid?orcid=<iD>&name=<n>`. With `link=1` (and a same-origin click) they add to the signed-in account, like the real routes. Never in production. |

Sign-in shows up in the navbar once any provider's client id is set; the sign-in page offers the
configured ones.

Google setup: Google Cloud console → "Google Auth Platform": app name, homepage, privacy policy URL,
authorized domain `opencryptology.org`; scopes `openid`, `email`, `profile` only (no Google review
needed); then a "Web application" client with the redirect URI above.

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
`MAINTAINER_GITHUB_IDS=4242` (the smoke test signs in as made-up GitHub id 4242 for the maintainer checks).
