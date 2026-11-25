#!/usr/bin/env bash
# Deploy this checkout (any branch, local changes included) to staging: the open-cryptology-staging
# Worker at https://staging.opencryptology.org, with its own D1, R2 and secrets (docs/STAGING.md).
#
#   scripts/deploy-staging.sh             # deploy, unless another branch went up in the last 2 hours
#   scripts/deploy-staging.sh --take      # replace it anyway (tell whoever was testing)
#   scripts/deploy-staging.sh --dry-run   # checks and build only
#
# It only ever deploys `--env staging`. Production deploys go through scripts/deploy.sh from main.
# Before uploading it runs the Worker's tests, which include test/config.test.ts: staging's name,
# routes, D1, bucket and rate limits differ from production's, CONTACT_TO (the one address staging
# may email, src/mail.ts) is a secret, and the Access gate is on. Schema: db/schema.sql changes go to staging D1 with
# scripts/staging-data.sh schema, before deploying code that needs them.
set -euo pipefail

die() { printf '\ndeploy-staging: %s\n' "$*" >&2; exit 1; }

take=0
dry=0
while [ $# -gt 0 ]; do
  case $1 in
    --take) take=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"
bash "$root/scripts/worker-deps.sh"
unset CLOUDFLARE_ENV WRANGLER_ENV
wr() { (cd "$root/worker" && npx --no-install wrangler "$@" --env staging); }

# 1. The config can't point at production; the code type-checks and passes its tests.
(cd worker && npm run -s typecheck) || die "typecheck failed"
(cd worker && npm test >/dev/null 2>&1) || die "tests failed (npm --prefix worker test shows which); test/config.test.ts guards the staging config"
name=$(cd worker && node -e '
  import("wrangler").then(({ unstable_readConfig }) => {
    process.stdout.write(unstable_readConfig({ config: "wrangler.jsonc", env: "staging" }).name);
  });')
[ "$name" = open-cryptology-staging ] || die "the staging config resolves to Worker '$name', not open-cryptology-staging"

# 2. What we're deploying.
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = HEAD ] && branch=detached
short=$(git rev-parse --short=12 HEAD)
dirty=""
[ -z "$(git status --porcelain --untracked-files=no -- worker db)" ] || dirty="+dirty"
msg="staging: $branch $short$dirty: $(git log -1 --format='%s')"
msg=${msg:0:100}

# 3. Someone else's branch deployed in the last 2 hours? Don't pull the rug out from under them.
status=$(wr deployments status --json 2>/dev/null || true)
if [ -n "$status" ]; then
  read -r prev_branch prev_age < <(node -e '
    const d = JSON.parse(process.argv[1]);
    const m = /^staging: (\S+) /.exec((d.annotations || {})["workers/message"] || "");
    const age = Math.round((Date.now() - Date.parse(d.created_on)) / 60000);
    process.stdout.write(`${m ? m[1] : "?"} ${Number.isFinite(age) ? age : 9999}\n`);
  ' "$status")
  if [ "$prev_branch" != "$branch" ] && [ "$prev_age" -lt 120 ] && [ "$take" = 0 ]; then
    die "staging has branch '$prev_branch', deployed $prev_age minutes ago. Someone may be testing it.
Use --take to replace it (and tell them), or wait."
  fi
  echo "deploy-staging: replacing $prev_branch (deployed $prev_age minutes ago)"
else
  echo "deploy-staging: no staging deployment yet"
fi

# 4. Deploy.
if [ "$dry" = 1 ]; then
  wr deploy --dry-run --tag "$short" --message "$msg"
  echo "deploy-staging: --dry-run: would deploy $branch $short$dirty"
  exit 0
fi
wr deploy --tag "$short" --message "$msg"
echo
echo "deploy-staging: $branch $short$dirty is on https://staging.opencryptology.org"
echo "  (Cloudflare Access: people log in; agents send the service token, see docs/STAGING.md)"
