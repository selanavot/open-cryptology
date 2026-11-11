# Working on Open Cryptology

- **Never push to `main`.** `main` is branch-protected (PR required, admins included). Work on a
  branch, open a PR with `gh pr create`, and squash-merge it (`gh pr merge --squash --delete-branch`).
  Squash is the only merge method enabled.
- **Deploy only from an up-to-date `main`** (`cd worker && npx wrangler deploy`), after the PR is merged.
- **Several sessions may share this checkout.** Use a git worktree for larger work, and `git add`
  only the files you changed (never `git add -A` in the shared checkout).
- **Never fetch PDFs from eprint.iacr.org** or bypass its bot challenge. Metadata comes from OAI-PMH
  plus one read of the RSS feed (`/rss/rss.xml`, for current PDF sizes), every 4 h at most; HTML
  pages (abstract, versions) answer GitHub Actions with a challenge, so we don't use them. PDFs come
  from public copies (GitHub community mirror, Wayback) and verified uploads.
- **Git holds code only**: no PDFs, metadata dumps or secrets. Scratch data goes in `data/` (gitignored).
- **Cloudflare is the maintainer's personal account.** Payments, plan changes and account creation are
  the maintainer's to do; secrets live in Wrangler secrets / `.dev.vars`, never in the repo.
- **UI:** keep the simplified-ePrint layout in yellow (see `worker/public/static/style.css`).
- **README:** keep it short. Every README change must be reviewed by a human before merging.
