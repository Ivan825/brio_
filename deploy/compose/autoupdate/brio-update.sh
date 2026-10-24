#!/usr/bin/env bash
# Keeps a server's Brio on the newest commit of its branch: fetches, and when there is something new, pulls it, adds
# any new settings to .env (setup.sh changes no value), rebuilds and restarts, then clears build leftovers so the disk
# does not fill up. Runs from the systemd timer that install.sh sets up; safe to run by hand.
#   brio-update.sh          update if the branch moved
#   brio-update.sh --check  only say whether an update is waiting (exit 0: up to date, 10: update waiting)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
compose="$(dirname "$here")"
repo="$(git -C "$compose" rev-parse --show-toplevel)"
exec 9>"${TMPDIR:-/tmp}/brio-update.lock"
flock -n 9 || { echo "another update is running"; exit 0; }

branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
git -C "$repo" fetch --quiet origin "$branch"
local_rev="$(git -C "$repo" rev-parse HEAD)"
remote_rev="$(git -C "$repo" rev-parse "origin/$branch")"
if [ "$local_rev" = "$remote_rev" ]; then
  echo "up to date at ${local_rev:0:7}"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "update waiting: ${local_rev:0:7} -> ${remote_rev:0:7}"
  exit 10
fi

echo "updating ${local_rev:0:7} -> ${remote_rev:0:7}"
git -C "$repo" merge --ff-only --quiet "origin/$branch"
cd "$compose"
./setup.sh
docker compose up -d --build --remove-orphans
# Build leftovers only: the layers of earlier builds and untagged old images. Never volumes.
docker builder prune -f --filter until=72h >/dev/null
docker image prune -f >/dev/null
echo "now at ${remote_rev:0:7}"
