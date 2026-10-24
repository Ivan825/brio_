#!/usr/bin/env bash
# Keeps a server's Brio on the newest commit of its branch: fetches, and when there is something new, pulls it, adds
# any new settings to .env (setup.sh changes no value), then either downloads that commit's ready-made images (when
# BRIO_IMAGE_PREFIX is set: only once they are published, so the code and images always match) or rebuilds here, and
# restarts. Then it clears leftovers so the disk does not fill up. Runs from the systemd timer that install.sh sets
# up; safe to run by hand.
#   brio-update.sh          update if the branch moved
#   brio-update.sh --check  only say whether an update is waiting (exit 0: up to date, 10: update waiting)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
compose="$(dirname "$here")"
repo="$(git -C "$compose" rev-parse --show-toplevel)"
exec 9>"${TMPDIR:-/tmp}/brio-update.lock"
flock -n 9 || { echo "another update is running"; exit 0; }

# A setting from .env (the last line wins, as in Compose); empty when absent.
setting() { sed -n "s/^$1=//p" "$compose/.env" 2>/dev/null | tail -n 1; }
prefix="$(setting BRIO_IMAGE_PREFIX)"
[ "$prefix" = brio ] && prefix=

branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
git -C "$repo" fetch --quiet origin "$branch"
local_rev="$(git -C "$repo" rev-parse HEAD)"
remote_rev="$(git -C "$repo" rev-parse "origin/$branch")"

if [ -n "$prefix" ]; then
  want="sha-${remote_rev:0:12}"
  if [ "$local_rev" = "$remote_rev" ] && [ "$(setting BRIO_VERSION)" = "$want" ]; then
    echo "up to date at ${local_rev:0:7}"
    exit 0
  fi
  # GitHub publishes a commit's images some minutes after it is pushed, and not at all when its checks fail.
  for target in api runner web; do
    if ! docker manifest inspect "$prefix-$target:$want" >/dev/null 2>&1; then
      echo "${remote_rev:0:7} is waiting for its images ($prefix-$target:$want is not published yet)"
      exit 0
    fi
  done
else
  if [ "$local_rev" = "$remote_rev" ]; then
    echo "up to date at ${local_rev:0:7}"
    exit 0
  fi
fi
if [ "${1:-}" = "--check" ]; then
  echo "update waiting: ${local_rev:0:7} -> ${remote_rev:0:7}"
  exit 10
fi

echo "updating ${local_rev:0:7} -> ${remote_rev:0:7}"
git -C "$repo" merge --ff-only --quiet "origin/$branch"
cd "$compose"
./setup.sh
if [ -n "$prefix" ]; then
  if grep -q '^BRIO_VERSION=' .env; then
    sed -i.bak "s/^BRIO_VERSION=.*/BRIO_VERSION=$want/" .env && rm -f .env.bak
  else
    echo "BRIO_VERSION=$want" >> .env
  fi
  docker compose pull --quiet
  docker compose up -d --no-build --remove-orphans
  # Earlier commits' images: still tagged, so the prune below would keep them. One in use is refused and stays.
  docker images --filter "reference=$prefix-*" --format '{{.Repository}}:{{.Tag}}' \
    | grep -v -e ":$want\$" -e ':latest$' | xargs -r docker rmi >/dev/null 2>&1 || true
else
  docker compose up -d --build --remove-orphans
  # Build leftovers: the layers of earlier builds.
  docker builder prune -f --filter until=72h >/dev/null
fi
# Untagged old images. Never volumes.
docker image prune -f >/dev/null
echo "now at ${remote_rev:0:7}"
