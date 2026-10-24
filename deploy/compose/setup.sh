#!/usr/bin/env sh
# Writes .env for the self-host bundle with fresh secrets. It never changes a value in an existing .env: run again
# after an upgrade, it only adds the settings this version has that the file lacks (blank, or with their defaults).
#   ./setup.sh [address] [--prebuilt]
# --prebuilt: download ready-made images from GitHub Packages instead of building them here, for small servers (1 GB).
set -eu
cd "$(dirname "$0")"
rand() { openssl rand -base64 "$1" | tr -d '\n'; }
app_url=http://localhost:8080
image_prefix=
image_version=
for arg in "$@"; do
  case "$arg" in
    --prebuilt)
      # Images of the repository this was cloned from: ghcr.io/<owner>/brio-*.
      owner="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#' | tr 'A-Z' 'a-z')"
      case "$owner" in "" | */* | *:*) owner=ivan825 ;; esac
      image_prefix="ghcr.io/$owner/brio"
      image_version=latest
      ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) app_url="$arg" ;;
  esac
done
data_dir="$(pwd)/data/runner"
mkdir -p "$data_dir"
umask 077
template="$(mktemp)"
trap 'rm -f "$template"' EXIT
cat > "$template" <<ENV
# Brio self-host settings (docs/SELF_HOST.md has every option). Keep this file secret and backed up:
# without BRIO_VAULT_LOCAL_KEK the API keys stored in Brio cannot be decrypted.
BRIO_APP_URL=$app_url
# ":80" serves plain HTTP on BRIO_HTTP_PORT; a domain (brio.example.com) gets a TLS certificate on 80/443.
BRIO_SITE_ADDRESS=:80
BRIO_HTTP_PORT=8080
BRIO_HTTPS_PORT=8443

POSTGRES_PASSWORD=$(rand 24 | tr '+/' '-_')
BETTER_AUTH_SECRET=$(rand 32)
BRIO_KMS_PROVIDER=local
BRIO_VAULT_LOCAL_KEK=$(rand 32)

# Where the runner keeps worktrees: an absolute path that Docker can mount (the same path inside and outside).
BRIO_RUNNER_DIR=$data_dir
# Attempts run at once on this machine. 1 on a 1 GB server.
BRIO_RUNNER_CONCURRENCY=2

# Where Brio's images come from. Empty: built on this machine (needs about 3 GB of memory, with swap). A registry
# prefix such as ghcr.io/ivan825/brio: downloaded ready-made (docker compose pull), which suits a 1 GB server.
# BRIO_VERSION is the tag to run; the automatic updater keeps it on the newest commit (sha-<commit>).
BRIO_IMAGE_PREFIX=$image_prefix
BRIO_VERSION=$image_version

# Who may create an account: your address (and "@yourcompany.com" domains), comma-separated. Set it before Brio is
# reachable from the internet (a tunnel, a public IP); invited people may always join. Empty: anyone who reaches Brio.
BRIO_SIGNUP_ALLOW=

# Email (sign-in links, invitations, notifications). Without any, links are only written to the API's log.
# Any mailbox you have, no domain needed (docs/OWNER_SETUP.md): Gmail with an app password is
# BRIO_SMTP_HOST=smtp.gmail.com, BRIO_SMTP_USER=you@gmail.com, BRIO_SMTP_PASSWORD=<16 letters, no spaces>.
BRIO_SMTP_HOST=
BRIO_SMTP_PORT=465
BRIO_SMTP_USER=
BRIO_SMTP_PASSWORD=
# Or Resend, from a domain verified there.
RESEND_API_KEY=
# The sender; defaults to the SMTP user.
BRIO_EMAIL_FROM=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Browser notifications: npx web-push generate-vapid-keys
BRIO_VAPID_PUBLIC_KEY=
BRIO_VAPID_PRIVATE_KEY=
BRIO_VAPID_SUBJECT=mailto:admin@example.com
ENV
if [ ! -f .env ]; then
  mv "$template" .env
  if [ -n "$image_prefix" ]; then
    echo "Wrote $(pwd)/.env. Next: docker compose pull && docker compose up -d --no-build, then open $app_url"
  else
    echo "Wrote $(pwd)/.env. Next: docker compose up -d, then open $app_url"
  fi
  exit 0
fi

# An existing .env: append each missing setting with the comment above it in the template.
added="$(awk -F= '
  NR == FNR { if ($0 ~ /^[A-Z_][A-Z0-9_]*=/) have[$1] = 1; next }
  /^#/ { note = note $0 "\n"; next }
  /^[A-Z_][A-Z0-9_]*=/ { if (!($1 in have)) { printf "%s%s\n", note, $0 } note = ""; next }
  { note = "" }
' .env "$template")"
if [ -z "$added" ]; then
  echo ".env already has every setting; edit it to change them (delete it to start over)."
  exit 0
fi
{
  printf '\n# Added by setup.sh on %s: settings newer than this file (docs/SELF_HOST.md).\n' "$(date +%F)"
  printf '%b\n' "$added"
} >> .env
echo "Added to $(pwd)/.env:"
printf '%b' "$added" | grep -E '^[A-Z_]' | sed 's/=.*//; s/^/  /'
echo "Fill them in, then: docker compose up -d"
