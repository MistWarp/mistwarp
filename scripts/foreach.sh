#!/usr/bin/env bash
# Run an npm-style task in every JavaScript project, using each project's own
# package manager. Usage: scripts/foreach.sh <install|test|build|...>
set -uo pipefail

task="${1:?usage: foreach.sh <task> [project ...]}"; shift

# path:package-manager
ALL="
packages/scratch-audio:npm
packages/scratch-blocks:npm
packages/scratch-gui:pnpm
packages/scratch-paint:npm
packages/scratch-render:npm
packages/scratch-vm:npm
apps/docs:npm
apps/packager:npm
apps/desktop:npm
services/realtime:npm
services/status-worker:npm
"

targets="$ALL"
if [ "$#" -gt 0 ]; then
  targets=""
  for want in "$@"; do
    match=$(echo "$ALL" | grep -E "(^|/)$want:") || true
    [ -z "$match" ] && { echo "unknown project: $want" >&2; exit 2; }
    targets="$targets$match"$'\n'
  done
fi

root=$(cd "$(dirname "$0")/.." && pwd)
failed=()

while IFS=':' read -r path pm; do
  [ -z "$path" ] && continue
  [ -d "$root/$path" ] || { echo "skip $path (missing; run 'npm run setup')"; continue; }
  [ -f "$root/$path/package.json" ] || continue
  echo "==> $path ($pm $task)"
  if [ "$task" = "install" ]; then
    ( cd "$root/$path" && "$pm" install ) || failed+=("$path")
  else
    ( cd "$root/$path" && "$pm" run "$task" ) || failed+=("$path")
  fi
done <<< "$targets"

if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[*]}" >&2
  exit 1
fi
