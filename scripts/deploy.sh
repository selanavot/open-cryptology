#!/usr/bin/env bash
# Deploy a Worker from this repo, safely when several checkouts may deploy at once.
#
#   scripts/deploy.sh                                  # the site (worker/wrangler.jsonc)
#   scripts/deploy.sh --force                          # skip the "live is newer" check
#   scripts/deploy.sh --dry-run                        # run the checks and build, don't upload
#   scripts/deploy.sh --ci [--schema-applied]          # continuous deploy (.github/workflows/deploy.yml)
#
# It deploys only when:
#   - this checkout's HEAD is exactly origin/main (just fetched), with no local changes;
#   - the live version is older than HEAD. Each deploy is tagged with its commit, so a
#     checkout that deploys a stale main finds a newer commit live and stops instead of
#     replacing it. A live version without a tag (deployed by hand) only warns.
#   - with --ci: db/schema.sql is unchanged since the live commit, unless --schema-applied says
#     the new statements already ran on production D1. (By hand it only reminds you.)
# After deploying it checks again: if a deploy of an older commit landed right after ours
# (two deploys racing), it puts ours back; anything else that replaced ours, it reports.
# Then, for the site, it loads a few pages; if any returns a server error it puts the
# previous version back.
# With --ci, a HEAD that main has already moved past exits quietly: the newer commit deploys.
set -euo pipefail

die() { printf '\ndeploy: %s\n' "$*" >&2; exit 1; }

config=worker/wrangler.jsonc
force=0
dry=0
ci=0
schema_applied=0
while [ $# -gt 0 ]; do
  case $1 in
    -c | --config) config=$2; shift 2 ;;
    --force) force=1; shift ;;
    --dry-run) dry=1; shift ;;
    --ci) ci=1; shift ;;
    --schema-applied) schema_applied=1; shift ;;
    -h | --help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"
# Production only: an environment selected through the shell (Wrangler reads these) would make
# every command below act on another Worker. Staging deploys with scripts/deploy-staging.sh.
unset CLOUDFLARE_ENV WRANGLER_ENV
[ -f "$config" ] || die "no Wrangler config at $config"
config=$(cd "$(dirname "$config")" && pwd)/$(basename "$config")

# Wrangler and its dependencies live in worker/ (the other Workers deploy with -c from there).
bash "$(dirname "$0")/worker-deps.sh"
wr() { (cd "$root/worker" && npx --no-install wrangler "$@" -c "$config"); }

# 1. Exactly origin/main, nothing local.
git fetch -q origin main
head=$(git rev-parse HEAD)
main=$(git rev-parse origin/main)
short=$(git rev-parse --short=12 HEAD)
if [ "$ci" = 1 ] && [ "$head" != "$main" ] && git merge-base --is-ancestor "$head" "$main"; then
  echo "deploy: $short is behind origin/main ($(git rev-parse --short=12 origin/main)); the newer commit's run deploys it."
  exit 0
fi
[ "$head" = "$main" ] ||
  die "HEAD is $short, not origin/main ($(git rev-parse --short=12 origin/main)).
Deploy only the latest main: git checkout main && git pull --ff-only (in a worktree: git checkout --detach origin/main)."
# Tracked changes anywhere; untracked files only where they would be bundled or uploaded.
dirty=$(git status --porcelain --untracked-files=no
  git status --porcelain --untracked-files=all -- worker "$(dirname "$config")" | sort -u)
[ -z "$dirty" ] || die "the checkout has local changes, which would ship too:
$dirty"

# 2. The live version must be older than HEAD.
live_version() { wr deployments status --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const d = JSON.parse(s); const v = (d.versions || []).sort((a, b) => b.percentage - a.percentage)[0];
    process.stdout.write(v ? v.version_id : "");
  });'; }
version_tag() { wr versions view "$1" --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    process.stdout.write((JSON.parse(s).annotations || {})["workers/tag"] || "");
  });'; }

live=$(live_version) || die "could not read the live deployment (is Wrangler logged in?)"
live_tag=$([ -n "$live" ] && version_tag "$live" || true)
if [ -z "$live" ]; then
  echo "deploy: no live deployment yet"
elif [ -z "$live_tag" ]; then
  echo "deploy: the live version ($live) has no commit tag (deployed without this script); can't tell if it's newer"
elif [ "$force" = 1 ]; then
  echo "deploy: --force: replacing live $live_tag"
elif ! git cat-file -e "$live_tag^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$live_tag" HEAD; then
  die "the live version is from $live_tag, which is not in the history of origin/main ($short):
newer code, or a branch, is live. Pull and retry; use --force only if you mean to replace it."
elif [ "$(git rev-parse "$live_tag")" = "$head" ]; then
  echo "deploy: $short is already live ($live). Nothing to do."
  exit 0
else
  echo "deploy: live is $live_tag, older than $short"
fi

# Schema changes go to production D1 by hand (db/schema.sql), before the code that needs them.
if [ -n "$live_tag" ] && git cat-file -e "$live_tag^{commit}" 2>/dev/null &&
  ! git diff --quiet "$live_tag" HEAD -- db/schema.sql; then
  if [ "$ci" = 1 ] && [ "$schema_applied" = 0 ]; then
    die "db/schema.sql changed since the live version ($live_tag):
$(git diff --stat "$live_tag" HEAD -- db/schema.sql)
Apply the new statements to production D1 (wrangler d1 execute open-cryptology --remote ...), then
run the Deploy workflow by hand with 'schema applied' ticked, or run scripts/deploy.sh."
  fi
  echo "deploy: note: db/schema.sql changed since $live_tag; production D1 needs the new statements first."
fi

# 3. Type-check the site before shipping it.
if [ "$config" = "$root/worker/wrangler.jsonc" ]; then
  (cd worker && npm run -s typecheck) || die "typecheck failed"
fi

# 4. Deploy, tagged with the commit.
msg=$(git log -1 --format='%h %s' | cut -c1-100)
if [ "$dry" = 1 ]; then
  wr deploy --dry-run --tag "$short" --message "$msg"
  echo "deploy: --dry-run: checks passed; would deploy $short"
  exit 0
fi
out=$(mktemp)
wr deploy --tag "$short" --message "$msg" 2>&1 | tee "$out"
ours=$(sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' "$out" | tail -1)
rm -f "$out"
[ -n "$ours" ] || die "could not find the new version ID in Wrangler's output"

# 6 (defined first). The site must still serve pages; a server error puts the previous version
# back. Only 5xx (or no answer) counts: a bot challenge (403) from Cloudflare isn't the Worker failing.
healthy_or_rollback() {
  local site page code tries bad=""
  site=$(sed -n 's/.*"SITE_URL": *"\(https\{0,1\}:[^"]*\)".*/\1/p' "$config" | head -1)
  [ -n "$site" ] || return 0 # a Worker without SITE_URL
  for page in / /eprint /2024/001; do
    for tries in 1 2 3; do
      code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -A 'Mozilla/5.0 (compatible; open-cryptology-deploy-check)' "$site$page" || true)
      case $code in 5* | 000 | "") sleep 5 ;; *) break ;; esac
    done
    echo "deploy: $site$page -> $code"
    case $code in 5* | 000 | "") bad="$bad $page ($code)" ;; esac
  done
  [ -z "$bad" ] && return 0
  [ -n "$live" ] || die "the site fails after deploying $short:$bad; there is no previous version to put back"
  echo "deploy: the site fails after deploying $short:$bad; putting the previous version $live back" >&2
  wr versions deploy "$live@100" --yes --message "rollback: $short failed the health check:$bad"
  die "rolled back to $live (${live_tag:-untagged}); $short failed the health check:$bad"
}

# 5. Did another deploy replace ours? Put ours back only if theirs is an older commit.
sleep 15
now=$(live_version || true)
if [ "$now" = "$ours" ]; then
  echo "deploy: live is $ours ($short)"
  healthy_or_rollback
  exit 0
fi
now_tag=$([ -n "$now" ] && version_tag "$now" || true)
if [ -n "$now_tag" ] && git cat-file -e "$now_tag^{commit}" 2>/dev/null &&
  git merge-base --is-ancestor "$head" "$now_tag"; then
  echo "deploy: a newer commit ($now_tag) went live after ours; leaving it."
  exit 0
fi
if [ -z "$now_tag" ] || ! git cat-file -e "$now_tag^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$now_tag" "$head"; then
  die "version $now (${now_tag:-untagged}) replaced ours ($ours, $short) right after, and it isn't an older
commit of main, so it was left live. Check who deployed it: npx wrangler deployments list"
fi
echo "deploy: version $now ($now_tag, older) replaced ours right after; putting $short back" >&2
wr versions deploy "$ours@100" --yes --message "$msg (restored: replaced by ${now_tag:-an untagged deploy})"
echo "deploy: live is $ours ($short)"
healthy_or_rollback
