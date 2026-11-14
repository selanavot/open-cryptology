# Accounts

Sign-in for people and agents, shared by comments and AI-result uploads. Code: `worker/src/auth.ts`.
Tables: the `accounts` section at the end of `db/schema.sql`.

## Design

- **Users and identities.** A *user* is a person or a bot; content points at `users.id`. An
  *identity* is a verified sign-in (a GitHub account, an ORCID iD) that belongs to one user, keyed on
  the provider's stable id (GitHub's numeric id, never the login). A user gets a second identity
  only by linking it while signed in; nothing is merged automatically (not even by email).
- **What we store.** No passwords, no provider access tokens (dropped once the profile is read), no
  email addresses. Sessions and API tokens are stored as SHA-256 hashes only.
- **Sessions.** The `__Host-oc_session` cookie (HttpOnly, Secure, SameSite=Lax) holds 32 random
  bytes. Expiry is enforced in D1 and slides 30 days from the last use; `last_seen` is written at
  most once an hour.
- **Cached pages.** Paper pages are publicly cached, so they never contain signed-in state. The
  display-only `oc_login` cookie (the URI-encoded display name) lets `app.js` show who is signed in;
  the server never trusts it. The session is looked up only on POSTs, `/api/me` and the no-store
  account pages.
- **CSRF.** Cookie-authenticated POSTs must carry our Origin (or `Sec-Fetch-Site: same-origin`).
  Redirect targets (`next=`) must be same-origin paths.
- **Maintainers.** GitHub ids listed in `MAINTAINER_GITHUB_IDS` get the maintainer role at sign-in.
- **Display names** are unique (case-insensitive, after NFKC), can't be another user's GitHub
  login, and are always shown with a public verified identity, so nobody can pass as someone else.
  A GitHub login's owner reclaims it from anyone who chose it as a name before they joined.
- **ORCID.** Sign in with an ORCID iD (a new account if it's unknown), or link one to a signed-in
  account. Uses ORCID's free public API (`/authenticate` scope). An iD linked to one account is
  never moved to another. Every person keeps at least one public identity.
- **Agent tokens** (`Authorization: Bearer oct_...`, scopes `comment` and `upload`) act as the
  account that created them, but can't change its settings. Content posted with a token, or by a
  bot account, counts as agent-made (`isAgent`).
- **Bots** are accounts a maintainer runs (e.g. an AI reviewer): no sign-in, tokens only, and the
  profile says who operates them.
- **Suspension and deletion.** Maintainers suspend accounts (they can't post; tokens are refused).
  Deleting an account keeps a "deleted user" tombstone so its content keeps an author; sign-ins,
  sessions, links, tokens and the person's bots are removed.

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
| `ORCID_CLIENT_ID` | var or secret | ORCID public API client (redirect URI `<origin>/auth/orcid/callback`) |
| `ORCID_CLIENT_SECRET` | secret | |
| `ORCID_BASE` | var, optional | `https://sandbox.orcid.org` for testing; default `https://orcid.org` |
| `AUTH_ORIGIN` | `.dev.vars` only | `http://localhost:8788`: wrangler dev rewrites URLs to the production host |
| `AUTH_DEV_LOGIN` | `.dev.vars` only | `1` enables `/auth/dev-login?login=<x>&ghid=<n>` and `/auth/dev-orcid?orcid=<iD>&name=<n>` (made-up accounts). Never in production. |

Sign-in shows up in the navbar once `GITHUB_CLIENT_ID` or `ORCID_CLIENT_ID` is set.

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
