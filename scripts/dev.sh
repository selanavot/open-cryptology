#!/usr/bin/env bash
# `npm run dev` in worker/ (and the "worker" preview in .claude/launch.json): wrangler dev, with a
# git worktree set up first so it works there in one step:
#   - node_modules linked from the main checkout (scripts/worker-deps.sh);
#   - .dev.vars copied from the main checkout (a copy, so edits stay in the worktree);
#   - the main checkout's local D1/R2/KV state (worker/.wrangler/state) instead of an empty one.
#     DEV_STATE=copy uses a private copy instead, for tests that write (uploads set pdf_key).
# Extra arguments go to wrangler dev (e.g. --port 8788).
set -euo pipefail
root=$(git rev-parse --show-toplevel)
bash "$root/scripts/worker-deps.sh"
cd "$root/worker"
main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
persist=()
if [ "$main" != "$root" ]; then
  if [ ! -e .dev.vars ] && [ -f "$main/worker/.dev.vars" ]; then
    cp "$main/worker/.dev.vars" .dev.vars
    echo "dev: copied .dev.vars from the main checkout" >&2
  fi
  state=$main/worker/.wrangler/state
  if [ "${DEV_STATE:-shared}" = copy ]; then
    if [ ! -d .wrangler/state ]; then
      mkdir -p .wrangler
      cp -R "$state" .wrangler/state
      echo "dev: copied the main checkout's local state" >&2
    fi
  elif [ -d "$state" ]; then
    persist=(--persist-to "$state")
    echo "dev: using the main checkout's local state ($state); DEV_STATE=copy for a private copy" >&2
  fi
fi
exec npx --no-install wrangler dev ${persist[@]+"${persist[@]}"} "$@"
