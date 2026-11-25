#!/usr/bin/env bash
# curl against staging through Cloudflare Access with the service token (docs/STAGING.md).
#   scripts/staging-curl.sh /2025/001 -i
#   scripts/staging-curl.sh '/__dev/mail?format=json'
#   scripts/staging-curl.sh /__dev/cron -X POST -H 'origin: https://staging.opencryptology.org'
# The token comes from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET, else worker/.staging.env
# (this checkout's, else the main checkout's).
set -euo pipefail
path=${1:?usage: scripts/staging-curl.sh PATH [curl args...]}
shift
root=$(git rev-parse --show-toplevel)
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
for f in "$root/worker/.staging.env" "$main/worker/.staging.env"; do
  if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] && [ -f "$f" ]; then
    # shellcheck disable=SC1090
    set -a; . "$f"; set +a
  fi
done
[ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ] ||
  { echo "staging-curl: no service token (worker/.staging.env, see docs/STAGING.md)" >&2; exit 1; }
exec curl -sS -H "cf-access-client-id: $CF_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $CF_ACCESS_CLIENT_SECRET" \
  "https://staging.opencryptology.org$path" "$@"
