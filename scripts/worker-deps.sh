#!/usr/bin/env bash
# Make sure worker/node_modules exists. In a git worktree it links the main checkout's copy
# (absolute path: Wrangler can't resolve through a relative link), so typecheck and Wrangler
# work without an install; elsewhere it runs `npm ci`.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
nm=$root/worker/node_modules
[ -e "$nm" ] && exit 0
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [ "$main" != "$root" ] && [ -d "$main/worker/node_modules" ]; then
  ln -s "$main/worker/node_modules" "$nm"
  echo "worker-deps: linked node_modules from $main/worker" >&2
else
  (cd "$root/worker" && npm ci --silent)
fi
