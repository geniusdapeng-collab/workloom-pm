#!/usr/bin/env bash
set -euo pipefail

release_root="${WORKLOOM_RELEASE_ROOT:-/opt/workloom-pm/current}"
node_bin="${WORKLOOM_NODE_BIN:-/opt/workloom-pm/runtime/current/bin/node}"

if [[ ! -x "$node_bin" ]]; then
  printf 'WorkLoom Node runtime is missing: %s\n' "$node_bin" >&2
  exit 1
fi
if [[ ! -f "$release_root/node_modules/tsx/dist/cli.mjs" ]]; then
  printf 'WorkLoom release dependencies are incomplete: %s\n' "$release_root" >&2
  exit 1
fi

cd "$release_root"
exec "$node_bin" node_modules/tsx/dist/cli.mjs apps/server/src/index.ts
