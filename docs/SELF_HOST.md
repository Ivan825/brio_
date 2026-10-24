# Self-hosting Brio

Brio runs on your own machine or cluster with the same features as the hosted product. You bring the vendor keys (BYOK, `SECURITY_GOVERNANCE.md` §2); Brio never needs anything from us.

There are two ways to run it:

| | Docker Compose (`deploy/compose`) | Helm (`deploy/helm/brio`) |
|---|---|---|
| For | One machine: a laptop, a VM, a small team server | A Kubernetes cluster |
| Database | Included (Postgres 17 + pgvector) | Bring your own (Postgres 15+ with pgvector) |
| Sandboxes | The machine's Docker | A Docker engine inside each runner pod (privileged `docker:dind` sidecar) |
| TLS | Caddy, automatic with a domain | Your ingress controller |

Either way you get the same five parts: **web** (Next.js), **api** (REST, SSE, MCP, A2A, the orchestrator), **runner** (one sandbox container per attempt), **Postgres**, and a one-shot **migrate** step that runs before the API starts.

---

## 1. Docker Compose (about 15 minutes)

**You need:** Docker Engine 24+ with Compose v2 (Docker Desktop is fine), 4 CPU / 8 GB RAM / 40 GB disk for a small team, `git` and `openssl`. Node 22 only for the optional smoke test.

```sh
git clone https://github.com/Ivan825/brio_.git brio && cd brio/deploy/compose
./setup.sh                      # writes .env with fresh secrets (or: ./setup.sh https://brio.example.com)
docker compose up -d            # builds the images (5–10 min the first time), migrates, starts everything
docker compose ps               # wait until api, runner and web are "healthy"
```

Open **http://localhost:8080**.

**First sign-in.** Without an email provider, sign-in links are written to the API's log rather than sent:

```sh
docker compose logs api | grep "Sign in to Brio"
```

Open the `link` from the newest line. The first person to create a workspace owns it. To send real emails, set `RESEND_API_KEY` and `BRIO_EMAIL_FROM` in `.env` (a Resend-verified domain) and run `docker compose up -d` again. Google sign-in needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with `<BRIO_APP_URL>/api/auth/callback/google` as the redirect URI.

**A real domain with TLS.** Point a DNS record at the machine, then in `.env` set:
- `BRIO_APP_URL=https://brio.example.com`
- `BRIO_SITE_ADDRESS=brio.example.com`
- `BRIO_HTTP_PORT=80` and `BRIO_HTTPS_PORT=443`

Then `docker compose up -d`. Caddy gets the certificate on its own. `BRIO_APP_URL` must be exactly the origin people use: sign-in cookies, OAuth for MCP clients and links in emails all depend on it.

**What runs where.**
- Caddy is the only published port. It sends `/api/auth`, `/v1`, `/mcp`, `/a2a`, `/.well-known` and `/health` to the API, and everything else to the web app. That covers server-sent events, the local-runner WebSocket, and MCP and A2A clients.
- The runner drives the host's Docker through its socket and starts one sandbox container per attempt.
- Worktrees live in `BRIO_RUNNER_DIR`, which `setup.sh` sets to `deploy/compose/data/runner`. It is mounted at the same path inside the runner, because the sandboxes mount it from the host. On Docker Desktop this path must be under a shared folder, such as your home directory.

> **The Docker socket.** Whoever controls the runner container controls the machine's Docker, and so the machine. The runner never runs agent code itself: agents run in sandboxes with no capabilities, as a non-root user, read-only except their worktree, and behind an egress proxy (`SECURITY_GOVERNANCE.md` §3). Still, give Brio a machine of its own, or use the Helm layout, where each runner has a private Docker engine.

## 2. Kubernetes with Helm (about 25 minutes)

**You need:** Kubernetes 1.27+, an ingress controller, Postgres 15+ with `CREATE EXTENSION vector` allowed (for example RDS, Cloud SQL, Neon or CloudNativePG), a registry for the three images, and nodes that allow privileged pods for the runners.

**1. Build and push the images** from the repository root:

```sh
REG=ghcr.io/acme TAG=0.1.0
docker build --target api    -t $REG/brio-api:$TAG .
docker build --target runner -t $REG/brio-runner:$TAG .
docker build --target web    -t $REG/brio-web:$TAG .
docker push $REG/brio-api:$TAG && docker push $REG/brio-runner:$TAG && docker push $REG/brio-web:$TAG
```

**2. Create the secret**, then install the chart:

```sh
kubectl create secret generic brio-secrets \
  --from-literal=DATABASE_URL='postgres://brio:…@db:5432/brio?sslmode=require' \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=BRIO_VAULT_LOCAL_KEK="$(openssl rand -base64 32)"
helm install brio deploy/helm/brio \
  --set image.registry=$REG --set image.tag=$TAG \
  --set existingSecret=brio-secrets \
  --set appUrl=https://brio.example.com --set ingress.host=brio.example.com \
  --set ingress.className=nginx
```

- A Job applies migrations before every install and upgrade. The API then starts with one replica: it hosts the orchestrator loop, and its rollout is `Recreate`.
- The web app scales freely, and runners scale with `runner.replicas` and `runner.concurrency`.
- Each runner pod runs its own Docker engine, listening only on the pod's loopback. Sandboxes are containers inside it, never on the node.
- For nginx ingress, raise the read timeout and turn off buffering so server-sent events and the runner WebSocket stay open (see the commented annotations in `values.yaml`).

## 3. Check it works

From `deploy/compose`, with `BRIO_ALLOW_PRIVATE_URLS=true` in `.env` (the test's fake vendor runs on your machine):

```sh
node smoke.mjs        # or BRIO_URL=https://brio.example.com node smoke.mjs
```

It goes through the public entry point only:
- signs in with an emailed link (read from the log);
- creates a workspace;
- connects a fake OpenAI-compatible vendor;
- plans a mission with one code task and approves it;
- follows the live event stream until the task's check has passed in a sandbox and the mission is done.

```
✓ Brio works at http://localhost:8080: signed in, planned, ran a sandboxed task, checked it, streamed 28 events.
```

Set `BRIO_ALLOW_PRIVATE_URLS` back to `false` afterwards, unless your models really are on your network (a local Ollama or vLLM, your own LiteLLM proxy).

## 4. Configuration reference

All settings are environment variables. A variable left blank counts as unset. Compose reads them from `deploy/compose/.env`; Helm reads them from `env:` and the secret.

### API (`apps/api`)

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection string. The database needs the `vector` extension. |
| `APP_URL` | `http://localhost:3000` | The browser-facing origin. Cookies, OAuth issuer, email links. Compose sets it from `BRIO_APP_URL`. |
| `BETTER_AUTH_SECRET` | — (required) | At least 32 characters. Signs sessions and salts anonymised score contributors. Changing it signs everyone out. |
| `BRIO_KMS_PROVIDER` | `local` | `local` (key from `BRIO_VAULT_LOCAL_KEK`) or `aws` (AWS KMS key `BRIO_AWS_KMS_KEY_ID`, with standard AWS credentials). |
| `BRIO_VAULT_LOCAL_KEK` | — | 32 bytes, base64. Wraps every stored vendor key. Rotate by putting the new key first and keeping the old ones, comma-separated. |
| `BRIO_AWS_KMS_KEY_ID` | — | KMS key id or ARN when `BRIO_KMS_PROVIDER=aws`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google sign-in. |
| `RESEND_API_KEY`, `BRIO_EMAIL_FROM` | — / `Brio <onboarding@resend.dev>` | Email: sign-in links, invitations, notifications. Without a key, emails are only logged. |
| `BRIO_VAPID_PUBLIC_KEY`, `BRIO_VAPID_PRIVATE_KEY`, `BRIO_VAPID_SUBJECT` | — / `mailto:admin@example.com` | Browser push. Generate with `npx web-push generate-vapid-keys`. |
| `BRIO_ALLOW_PRIVATE_URLS` | `false` in production | Lets connectors call private-network URLs (local models, your own proxy). Cloud metadata addresses are always refused. |
| `BRIO_ALLOW_LOCAL_REPOS` | `false` in production | Lets projects point at paths on the runner's disk. |
| `BRIO_GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3`. |
| `BRIO_PRICING_REFRESH_HOURS` | `24` | Live price refresh from public lists; `0` turns it off. |
| `BRIO_FX_USD_PER` | — | Exchange rates for vendors billing in other currencies, e.g. `INR=0.0114`. |
| `BRIO_SSE_MAX_CONNECTION_MS` | `300000` | Event streams are rotated after this long (browsers resume from the last event). |
| `BRIO_SLACK_API_URL` | `https://slack.com/api` | Slack Web API base. |
| `BRIO_API_ROLE` | `all` | `all`: one process. At scale, `web` processes (as many as you like) serve requests, live events, MCP, A2A and runners' sockets, and exactly one `worker` runs missions (D-99). The Helm chart runs it that way. |
| `DATABASE_POOL_MAX` | `20` | Postgres connections per API process. |
| `BRIO_TRUST_PROXY_HOPS` | `1` | Proxies in front of the API whose `X-Forwarded-For` is believed: Caddy, an ingress, or the web app is 1. Use `0` when clients reach the API directly. Sign-in rate limits key on the address this yields. |
| `BRIO_RATE_LIMIT_PER_MINUTE` | `1200` | Requests per client address per minute (the health check, live event streams and runners' sockets are exempt); `0` turns it off. |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | |

Each workspace connects Slack and Mandate itself, under **Settings** and **Governance**.

### Runner (`apps/runner`)

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL`, `BRIO_KMS_PROVIDER`, `BRIO_VAULT_LOCAL_KEK`, `BRIO_AWS_KMS_KEY_ID`, `BRIO_ALLOW_PRIVATE_URLS`, `BRIO_GITHUB_API_URL` | as the API | Must match the API's. |
| `BRIO_RUNNER_DIR` | `~/.brio/runner` | Worktrees and repository caches. A runner in a container needs the same path on the Docker host. |
| `BRIO_RUNNER_CONCURRENCY` | `2` | Attempts at once. Each sandbox takes up to its profile's CPU and memory. |
| `BRIO_RUNNER_MAILBOX_PORT` | `0` (any free port) | Where CLI agents reach the mailbox through their sandbox's proxy. |
| `BRIO_RUNNER_MAILBOX_HOST`, `BRIO_RUNNER_NETWORK` | — | A runner in a container: its name and Docker network, which sandbox proxies join to reach it. Compose sets both. |
| `BRIO_RUNNER_HEALTH_PORT`, `BRIO_RUNNER_HEALTH_HOST` | —, `127.0.0.1` | `GET /health` for probes. |
| `BRIO_IMAGE_BASE`, `_CLI`, `_PROXY`, `_WEB`, `_BROWSER` | built locally | Pin pre-built sandbox images instead of building them on first use. |
| `DOCKER_HOST` | the local socket | Which Docker engine runs the sandboxes (Helm: the pod's own engine). |

### Web (`apps/web`)

| Variable | When | What it does |
|---|---|---|
| `API_URL` | build time | Where the web app proxies API paths when nothing in front routes them (Caddy and the Helm ingress do). |
| `PORT` | run time | Default `3000`. |

## 5. Backup and restore

**What to keep:**
- The database.
- `BRIO_VAULT_LOCAL_KEK` (or access to the KMS key).
- `BETTER_AUTH_SECRET`.

Without the key-encryption key, every stored vendor key is unreadable. That is the point of the vault, so keep the key somewhere other than the database backup.

```sh
# Compose: a consistent dump while Brio runs
docker compose exec -T postgres pg_dump -U brio -d brio -Fc > brio-$(date +%F).dump
cp .env brio-env-$(date +%F).bak        # holds the keys; store it encrypted, apart from the dump
```

**To restore** onto a fresh install, using the same `.env`:

```sh
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U brio -d brio --clean --if-exists < brio-2026-10-24.dump
docker compose up -d
```

On Kubernetes, use your database's own backups (point-in-time recovery where you have it) and back up the secret.

**What doesn't need a backup:**
- Worktrees and repository caches in `BRIO_RUNNER_DIR`: they are rebuilt.
- Sandbox images.
- Caddy's certificates: they are re-issued.

**Checking a restore:** owners can verify the restored ledger's hash chain under **Governance → Ledger → Verify the chain**.

## 6. Upgrades

```sh
git pull
docker compose up -d --build     # migrations run before the new API starts
```

With Helm, build and push the new tag, then `helm upgrade brio deploy/helm/brio --reuse-values --set image.tag=<new>`.

Migrations only move forward. Take a backup first. An attempt running during the restart is marked failed once its heartbeat lapses (about a minute), and the orchestrator tries its task again. Queued attempts are simply picked up. The board shows both.

## 7. Operating notes

- **Logs** are JSON on stdout. Secrets are redacted before anything is written (`SECURITY_GOVERNANCE.md` §2).
- **Health:**
  - the API's `GET /health` returns `{"ok":true,"db":"up"}`;
  - the runner's `GET /health` is on `BRIO_RUNNER_HEALTH_PORT`.
- **Disk.** Sandbox images are about 1–3 GB. Old worktrees are removed when their attempts end.
- **Local runners.** People can still run `brio runner` on their own machines against a self-hosted Brio. They connect out to `BRIO_APP_URL` over a WebSocket.
