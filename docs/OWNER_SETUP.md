# Owner setup: from zero to everything, with no domain

This guide is for the person who owns a Brio install and has **no domain name and no budget**. Every step uses free accounts. Do the parts in order; each one ends with a way to check that it worked. Parts 1–3 are the core. The rest are optional extras.

| Part | What you get | Cost | Needs a domain? |
|---|---|---|---|
| [1. Run Brio on your Mac](#1-run-brio-on-your-mac) | Brio at `http://localhost:8080` | free | no |
| [2. Connect agents](#2-connect-agents) | Real missions with real models | free (Gemini, Groq) or pay-as-you-go | no |
| [3. Email from your Gmail](#3-email-from-your-gmail) | Sign-in links and invitations by email | free | no |
| [4. A public HTTPS address](#4-a-public-https-address-tailscale-funnel) | `https://<your-mac>.<tailnet>.ts.net` for other people, phones, Slack, remote MCP | free | no |
| [5. Browser notifications](#5-browser-notifications) | Push notifications | free | no |
| [6. Slack](#6-slack) | Approvals and questions in Slack | free | no (needs Part 4) |
| [7. Use Brio from Claude Code (MCP)](#7-use-brio-from-claude-code-mcp) | `delegate` a goal from your coding agent | free | no |
| [8. The local runner](#8-the-local-runner-your-own-cli-sign-ins) | Tasks run on your Mac under your own `claude` / `agy` sign-in | free | no |
| [9. A real GitHub pull request](#9-a-real-github-pull-request) | Brio opens a PR on a test repository | free | no |
| [10. Live vendor tests](#10-live-vendor-tests) | Proof each adapter works against the real vendor | free (Gemini) | no |
| [11. Publish the product website](#11-publish-the-product-website) | `https://<name>.vercel.app` | free | no |
| [12. Kubernetes (Helm) on your Mac](#12-kubernetes-helm-on-your-mac) | The Helm chart running on a local cluster | free | no |
| [13. GitHub repository page](#13-github-repository-page) | Description, website and topics | free | no |
| [14. Google sign-in](#14-google-sign-in-optional--skip-it) | A "Sign in with Google" button | free | **skip it** |

> **Why no domain is fine.** A domain does three things: a public address (Part 4 gets you one free from Tailscale), email from your own name (Part 3 sends from your Gmail instead), and Google sign-in (Part 14: not needed, because email links already sign you in).

---

## 1. Run Brio on your Mac

**You need:** a Mac with 16 GB of memory (8 GB works for light use), Docker Desktop, `git`, and about 20 GB of free disk.

1. **Install Docker Desktop** from <https://www.docker.com/products/docker-desktop/> (Apple chip or Intel, whichever your Mac is: Apple menu → About This Mac). Open it once and accept the terms.
2. **Give Docker enough memory.** Docker Desktop → **Settings** (gear icon) → **Resources** → set **Memory** to at least **6 GB** (8 GB if you have 16 GB) and **CPUs** to 4 or more → **Apply & restart**.
3. **Get the code** in Terminal:
   ```sh
   cd ~/projects                      # or wherever you keep code
   git clone https://github.com/Ivan825/brio_.git brio
   cd brio/deploy/compose
   ```
   (If you already have the repository at `~/projects/brio_`, use `cd ~/projects/brio_/deploy/compose` and `git pull` instead.)
4. **Create the settings file:**
   ```sh
   ./setup.sh
   ```
   This writes `deploy/compose/.env` with fresh secret keys. **Back this file up somewhere private** (a password manager is ideal): without `BRIO_VAULT_LOCAL_KEK` in it, the API keys you store in Brio can never be decrypted.
5. **Allow only yourself to sign up.** Open `.env` in any editor (`open -e .env` opens TextEdit) and set your own address:
   ```sh
   BRIO_SIGNUP_ALLOW=you@gmail.com
   ```
   People you invite from inside Brio can always join. This matters from Part 4 on, when Brio is reachable from the internet.
6. **Start Brio:**
   ```sh
   docker compose up -d
   ```
   The first time it builds three images: 5–10 minutes. Later starts take seconds.
7. **Wait until it is healthy:**
   ```sh
   docker compose ps
   ```
   Repeat until `api`, `runner` and `web` say `healthy`.
8. **Open <http://localhost:8080>** and type your email on the sign-in page. Until Part 3, the sign-in link is written to the log instead of emailed. Get it with:
   ```sh
   docker compose logs api | grep "Sign in to Brio" | tail -1
   ```
   Copy the `link` value (it starts with `http://localhost:8080/api/auth/magic-link/verify?token=`) into the browser. Links last 15 minutes.
9. **Create your workspace** when Brio asks. You are its owner.

**Check:** you see the Missions page with "No missions yet".

**Everyday commands** (run them in `deploy/compose`):

| To | Run |
|---|---|
| Stop Brio (keeps all data) | `docker compose stop` |
| Start it again | `docker compose up -d` |
| Apply a change to `.env` | `docker compose up -d` |
| Update to the newest code | `git pull && docker compose up -d --build` |
| See what went wrong | `docker compose logs api --tail 100` (or `runner`, `web`) |
| Back up the database | `docker compose exec -T postgres pg_dump -U brio -d brio -Fc > brio-$(date +%F).dump` |

---

## 2. Connect agents

Brio does nothing until it has at least one agent. With one, everything runs on it. With **two from different vendors**, Brio routes each task to whichever is better and has the other vendor review the work. That is the setup to aim for, and it can be free.

### 2a. Free keys

| Vendor | Where | Notes |
|---|---|---|
| **Google Gemini** (recommended first) | <https://aistudio.google.com/apikey> → **Create API key** | Free tier with a Google account, no card. Rate-limited, which is fine for trying Brio. |
| **Groq** (a second, different vendor) | <https://console.groq.com/keys> → **Create API Key** | Free tier, fast open models. |
| **OpenRouter** | <https://openrouter.ai/keys> | Some models are free (their ids end in `:free`). |
| **Local models with Ollama** | <https://ollama.com/download> | Runs on your Mac, costs nothing. See 2c. |

**Paid, pay-as-you-go** (only if you want them; each needs about $5 of prepaid credit):
- OpenAI: <https://platform.openai.com/api-keys>
- Anthropic (Claude): <https://console.anthropic.com/settings/keys>
- xAI (Grok): <https://console.x.ai>

Set a monthly spending limit in each vendor's billing page as well as in Brio.

### 2b. Add a key and make an agent

1. In Brio, open **Connectors**. Find the vendor (for example **Gemini API**) and click **Add key**.
2. Paste the key and click **Add …**. Brio checks the key; the connector should show **healthy**. Brio never shows the key again, not even to you.
3. Open **Models** → **List models** on that connector to see the vendor's current models.
4. Open **Agents**:
   - **Name:** for example `gemini`.
   - **Connector:** the one you just added.
   - **Model:** one id from the list in step 3.
   - Save the agent.
5. Repeat for a second vendor (for example **Groq · Cerebras** with your Groq key).
6. Open **Governance** and set a **monthly budget**, for example $5. Brio checks it before every dispatch.

**Check:** on **Missions**, type *"Write a short README for a to-do app"* and click **Plan mission**. Brio shows a plan; click **Approve plan**. The board fills in live, and the mission ends **done**.

### 2c. Local models (optional)

1. Install Ollama and pull a model, for example one from <https://ollama.com/library>: `ollama pull <model>`.
2. Brio runs in Docker, so it reaches your Mac at `host.docker.internal`. In `deploy/compose/.env` set:
   ```sh
   BRIO_ALLOW_PRIVATE_URLS=true
   ```
   then run `docker compose up -d`.
3. **Connectors** → **Local models** → **Add key** → base URL `http://host.docker.internal:11434/v1`, any text as the key.

---

## 3. Email from your Gmail

Brio sends sign-in links, invitations and notifications through your own Gmail account, using a Gmail **app password**. You don't need a domain.

1. **Turn on 2-Step Verification** (required for app passwords): <https://myaccount.google.com/signinoptions/twosv>. Follow Google's steps.
2. **Create an app password:** <https://myaccount.google.com/apppasswords>.
   - App name: `Brio`.
   - Click **Create**.
   - Google shows 16 letters in four groups, like `abcd efgh ijkl mnop`. Copy them now, because Google shows them only once.
3. **Put them in `deploy/compose/.env`.** Remove the spaces from the password:
   ```sh
   BRIO_SMTP_HOST=smtp.gmail.com
   BRIO_SMTP_PORT=465
   BRIO_SMTP_USER=you@gmail.com
   BRIO_SMTP_PASSWORD=abcdefghijklmnop
   ```
   Leave `BRIO_EMAIL_FROM` empty: emails then come from `Brio <you@gmail.com>`.
4. **Apply:** `docker compose up -d`.

**Check:**
1. Sign out (top right).
2. Sign in again with your address. The email arrives within a minute; look in Spam the first time and mark it "Not spam".
3. In **Settings → Notifications** the chip says **email via your SMTP server**.

**Notes:**
- A personal Gmail account sends at most about 500 emails a day, far more than one Brio needs.
- If you change your Google password, the app password stops working: make a new one.
- Outlook, Zoho and other providers work the same way. Use their SMTP host and port; for port 587, also set `BRIO_SMTP_TLS=starttls`.
- **If it fails:** `docker compose logs api | grep -i smtp`.
  - `535` means a wrong address or app password.
  - A timeout means your network blocks port 465. Try `BRIO_SMTP_PORT=587` with `BRIO_SMTP_TLS=starttls`.

---

## 4. A public HTTPS address (Tailscale Funnel)

`localhost` only works on your Mac. Other people, your phone, Slack, and coding agents on other machines need a public `https://` address. **Tailscale Funnel** gives your Mac one for free: `https://<mac-name>.<tailnet-name>.ts.net`, with a real certificate. The address stays the same across restarts.

> **Before you start:** make sure `BRIO_SIGNUP_ALLOW` is set (Part 1, step 5). Otherwise anyone who finds the address can create an account and run sandboxes on your Mac.

1. **Create a free Tailscale account:** <https://login.tailscale.com/start>. Sign in with Google or GitHub; the free Personal plan includes Funnel.
2. **Install Tailscale on the Mac** from <https://tailscale.com/download/mac>. Open it and log in. It lives in the menu bar.
3. **Install its command-line tool:** menu-bar icon → **Settings** → **CLI integration** → **Install**. If you don't see that option, add this line to `~/.zshrc`:
   ```sh
   alias tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
   ```
   Then open a new Terminal window. Check it with `tailscale status`.
4. **Publish Brio:**
   ```sh
   tailscale funnel --bg 8080
   ```
   The first time, it prints a link to turn on **HTTPS** and **Funnel** for your tailnet. Open the link, approve, then run the command again.

   It then prints your address, for example:
   ```
   Available on the internet:
   https://ivans-macbook.tail1a2b3c.ts.net/
   |-- proxy http://127.0.0.1:8080
   ```
5. **Tell Brio its address.** In `deploy/compose/.env`, using your own address with no slash at the end:
   ```sh
   BRIO_APP_URL=https://ivans-macbook.tail1a2b3c.ts.net
   ```
   Then run `docker compose up -d`. Sign-in cookies, email links and OAuth for MCP clients all use this address. From now on, open Brio at this address rather than at `localhost:8080`.
6. **Keep the Mac awake** while others use Brio. Either:
   - **System Settings → Battery → Options** → turn on **Prevent automatic sleeping on power adapter when the display is off**; or
   - run `caffeinate -dims` in a Terminal tab.

**Check:** on your phone, **with Wi-Fi off** so it goes over the internet, open the address. You see Brio's sign-in page with a padlock.

**Notes:**
- Turn it off with `tailscale funnel --https=443 off`; turn it on again with `tailscale funnel --bg 8080`. It also resumes after a reboot.
- Tailscale limits Funnel's bandwidth. That is plenty for a team's Brio, not for a public service.

**No-account alternative (for a quick test):** `brew install cloudflared`, then `cloudflared tunnel --url http://localhost:8080` prints a `https://….trycloudflare.com` address. It changes every time you restart it, so you would update `BRIO_APP_URL` (and Slack) each time. Use Tailscale for anything lasting.

---

## 5. Browser notifications

1. Generate a key pair (Node.js 22 is installed with the repository's tools):
   ```sh
   npx web-push generate-vapid-keys
   ```
2. Copy the two keys into `deploy/compose/.env`:
   ```sh
   BRIO_VAPID_PUBLIC_KEY=<Public Key>
   BRIO_VAPID_PRIVATE_KEY=<Private Key>
   BRIO_VAPID_SUBJECT=mailto:you@gmail.com
   ```
3. Run `docker compose up -d`.
4. In Brio: **Settings → Notifications** → **Turn on notifications in this browser**, and allow notifications when the browser asks.

**Check:** the chip says **1 browser(s) subscribed**. The next plan waiting for your approval pops up as a notification.

Push works on `localhost` and on your `ts.net` address (it needs HTTPS anywhere else). Never change these keys once people have subscribed: that silently breaks their subscriptions.

---

## 6. Slack

Brio posts approvals and agents' questions to a Slack channel, with **Approve** and **Deny** buttons. Slack needs the public address from Part 4.

1. **A Slack workspace:** use yours, or create a free one at <https://slack.com/get-started>.
2. **Create the app:** <https://api.slack.com/apps> → **Create New App** → **From scratch** → name `Brio`, pick your workspace → **Create App**.
3. **Permissions:** left menu **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope** → add `chat:write`, then add `users:read.email`.
4. **Buttons:** left menu **Interactivity & Shortcuts** → switch **On** → **Request URL**:
   ```
   https://ivans-macbook.tail1a2b3c.ts.net/v1/integrations/slack/interactions
   ```
   (your address from Part 4) → **Save Changes**.
5. **Install it:** left menu **Install App** → **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token** (starts with `xoxb-`).
6. **Signing secret:** left menu **Basic Information** → **App Credentials** → **Signing Secret** → **Show** → copy.
7. **Pick a channel**, for example `#brio`. In it, type `/invite @Brio`. Then get its id: click the channel name → the id (starts with `C`) is at the bottom of the window.
8. **Connect it in Brio:** **Settings → Notifications → Slack** → paste the **Bot token**, **Signing secret** and **Channel id** → connect.

**Check:** the chip says **posting to C…**. The next approval appears in the channel; clicking **Approve** there decides it as the person whose Slack email matches their Brio email.

---

## 7. Use Brio from Claude Code (MCP)

On the same Mac:

```sh
claude mcp add --transport http brio http://localhost:8080/mcp
```

Then type `/mcp` in Claude Code, choose **brio**, and sign in. A browser opens Brio's consent page; approve it.

**Check:** ask Claude Code *"use brio to delegate: add a /health endpoint with a test"*. The mission appears on Brio's Missions page, and the verified report comes back to Claude Code.

From another machine (or Cursor, Codex, any MCP client), use your Part 4 address: `https://<…>.ts.net/mcp`.

---

## 8. The local runner (your own CLI sign-ins)

The local runner runs tasks on your Mac with the coding CLIs **you** are signed in to (Claude Code's `claude`, Antigravity's `agy`, Codex and others). It uses your own subscriptions, with no API key. It connects out to Brio, so nothing extra is exposed.

1. **Install and sign in to a CLI**, as its vendor documents. For example, Claude Code: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in. Check that `claude --version` works.
2. **Install the `brio` command** from the repository:
   ```sh
   cd ~/projects/brio_                 # the repository root
   pnpm install
   pnpm setup && source ~/.zshrc       # only once, so pnpm can link commands
   cd apps/cli && pnpm link --global
   brio --help
   ```
3. **Sign in:**
   ```sh
   brio login --url http://localhost:8080
   ```
   It prints a link and a code. Open the link, check the code matches, and approve.
4. **Register this Mac:**
   ```sh
   brio runner register --name laptop
   ```
   Tasks then run in Docker sandboxes on your Mac. `--host` runs them directly on the Mac instead; it asks for your explicit consent first. Use Docker.
5. **Start it** and leave the Terminal tab open:
   ```sh
   brio runner start
   ```
   It lists the CLIs it found and says **laptop is connected**.
6. **In Brio:**
   - **Connectors** → **Claude Code** (or **Google Antigravity**) → **Add key** → tick **Use my own … sign-in** → add it.
   - **Agents** → new agent on that connector, **Runs on: laptop**.
   - **Projects** → new project whose repository is a folder on your Mac, for example `/Users/you/code/my-app`, on runner **laptop**.
7. Run a mission on that project.

**Check:** the board shows the task running on **laptop**, and the branch lands in your local repository.

To run the live CLI test (Part 10) for `agy` as well, install Antigravity's CLI and sign in to it the same way.

---

## 9. A real GitHub pull request

Use a **throwaway test repository**, never `brio_` itself: a pull request from Brio is opened with your token, as you.

1. **Create a test repository:** <https://github.com/new>. Name it `brio-sandbox`, make it Private, tick **Add a README** → **Create repository**.
2. **Create a fine-grained token:** <https://github.com/settings/personal-access-tokens/new>.
   - **Token name:** `brio-sandbox`.
   - **Expiration:** 30 days.
   - **Repository access:** **Only select repositories** → `brio-sandbox`.
   - **Permissions → Repository permissions:** **Contents: Read and write**, **Pull requests: Read and write**. Metadata: Read is added on its own.
   - **Generate token**, and copy it.
3. **In Brio:** **Projects** → new project:
   - **Repository:** `https://github.com/Ivan825/brio-sandbox.git`
   - **Git token:** paste the token.
4. **Run a mission** on the project, for example *"Add a CONTRIBUTING.md with a short guide"*. Approve the plan.
5. **Approve the pull request:** when the mission is done, **Inbox** shows **open a pull request**. Approve it.

**Check:** <https://github.com/Ivan825/brio-sandbox/pulls> shows the pull request, opened by **Ivan825**. Delete the token when you are done: <https://github.com/settings/personal-access-tokens>.

---

## 10. Live vendor tests

These tests call real vendors with your keys, to prove each adapter works today. They never run in CI. Run them from the repository root (`~/projects/brio_`). The CLI and golden-mission tests also need the development database: `docker compose up -d` in the repository root starts it, and `cp .env.example .env` (once) gives the settings. Load them into the Terminal first:

```sh
cd ~/projects/brio_
set -a; . ./.env; set +a
```

**Gemini (free key):**
```sh
LIVE_GEMINI=1 GEMINI_API_KEY=<key> LIVE_GEMINI_MODEL=<a model id from Brio's model list> \
  pnpm --filter @brio/adapters test:live
```

The same pattern works for every vendor in `packages/adapters/test/live.test.ts`:
- `LIVE_GROQ` + `GROQ_API_KEY`;
- `LIVE_OPENAI` + `OPENAI_API_KEY`;
- `LIVE_ANTHROPIC` + `ANTHROPIC_API_KEY`;
- `LIVE_OPENROUTER`, `LIVE_XAI`, `LIVE_MISTRAL`, `LIVE_DEEPSEEK`, `LIVE_OLLAMA` (+ `OLLAMA_BASE_URL`);
- and the rest listed in that file.

**A coding CLI** (needs the CLI installed; see `apps/runner/test/live-cli.test.ts`):
```sh
LIVE_CLI_ANTIGRAVITY=1 GEMINI_API_KEY=<key> LIVE_CLI_ANTIGRAVITY_MODEL=<id> pnpm --filter @brio/runner test:live
LIVE_CLI_CLAUDE_CODE=1 ANTHROPIC_API_KEY=<key> LIVE_CLI_CLAUDE_CODE_MODEL=<id> pnpm --filter @brio/runner test:live
```

**The golden mission** (a full mission across two paid vendors, about $1):
```sh
LIVE_GOLDEN=1 OPENAI_API_KEY=<key> ANTHROPIC_API_KEY=<key> \
  LIVE_GOLDEN_OPENAI_MODEL=<id> LIVE_GOLDEN_ANTHROPIC_MODEL=<id> pnpm --filter @brio/api test:live
```

**Check:** each prints `✓` per test. Send me the output if anything fails.

Pick model ids from each vendor's list (Brio's **Models** button, or the vendor's docs). Model names change often, so Brio never hard-codes them.

---

## 11. Publish the product website

The website (`apps/site`) is a static page. Vercel hosts it for free at `https://<name>.vercel.app`. It is deployed straight from your Mac, so Vercel never gets access to the GitHub repository and no bot touches it.

1. **Create a Vercel account:** <https://vercel.com/signup> → **Hobby** (free). Sign up with your email; you don't have to connect GitHub.
2. **Log in from the Terminal:**
   ```sh
   npx vercel@62.7.0 login
   ```
   Choose **Continue with Email** and click the link Vercel emails you.
3. **Deploy:**
   ```sh
   cd ~/projects/brio_/apps/site
   pnpm run deploy
   ```
   The first time, Vercel asks a few questions:
   - **Set up and deploy?** → yes.
   - **Which scope?** → your account.
   - **Link to existing project?** → no.
   - **Project name?** → for example `brio-orchestrator`.
   - **In which directory is your code located?** → `./` (press Enter).

   It prints the address, for example `https://brio-orchestrator.vercel.app`.
4. **Fix the social-card links:** deploy once more with the address you got, so link previews on X, Slack and LinkedIn show the Brio card:
   ```sh
   NEXT_PUBLIC_SITE_URL=https://brio-orchestrator.vercel.app pnpm run deploy
   ```

**Check:** open the address on your phone.

To update the site later, run the same command again.

---

## 12. Kubernetes (Helm) on your Mac

Optional. It proves the Helm chart on a real cluster, at no cost, using `kind` (Kubernetes inside Docker). Give Docker Desktop **8 GB** of memory first (Part 1, step 2).

1. **Install the tools:**
   ```sh
   brew install kind kubectl helm
   ```
2. **Create a cluster:**
   ```sh
   kind create cluster --name brio
   ```
3. **Build the images and load them into the cluster:**
   ```sh
   cd ~/projects/brio_
   docker build --target api    -t brio-api:dev .
   docker build --target runner -t brio-runner:dev .
   docker build --target web    -t brio-web:dev --build-arg API_URL=http://brio-api:4000 .
   for t in api runner web; do kind load docker-image brio-$t:dev --name brio; done
   ```
4. **Start a Postgres with pgvector in the cluster:**
   ```sh
   kubectl create deployment db --image=pgvector/pgvector:pg17
   kubectl set env deployment/db POSTGRES_PASSWORD=brio POSTGRES_USER=brio POSTGRES_DB=brio
   kubectl expose deployment db --port 5432
   ```
5. **Install the chart:**
   ```sh
   helm install brio deploy/helm/brio \
     --set image.registry="" --set image.tag=dev --set image.pullPolicy=Never \
     --set secrets.DATABASE_URL=postgres://brio:brio@db:5432/brio \
     --set secrets.BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
     --set secrets.BRIO_VAULT_LOCAL_KEK="$(openssl rand -base64 32)" \
     --set appUrl=http://localhost:8090 --set ingress.enabled=false
   kubectl get pods -w                  # wait until all are Running (Ctrl-C to stop watching)
   ```
6. **Open it:**
   ```sh
   kubectl port-forward svc/brio-web 8090:3000
   ```
   Then open <http://localhost:8090>.
7. **Remove it all afterwards:** `kind delete cluster --name brio`.

If a step fails, send me the output of `kubectl get pods` and `kubectl describe pod <the failing one>`. I validated the chart with `helm lint` and by rendering every template, but haven't run it on a cluster; the image names and values above may need a small fix that I can make.

---

## 13. GitHub repository page

On <https://github.com/Ivan825/brio_>, click the gear next to **About** (top right of the file list):

- **Description:**
  ```
  Brio: one goal, every AI. Plans a goal into tasks, routes each to the best agent across vendors (Claude Code, Codex, Cursor, Gemini, any A2A agent), verifies results cross-vendor, and learns who wins. BYOK, self-hosted.
  ```
- **Website:** your Part 11 address, for example `https://brio-orchestrator.vercel.app`.
- **Topics:** `ai-agents`, `multi-agent`, `orchestration`, `llm`, `mcp`, `a2a`, `claude-code`, `codex`, `typescript`, `byok`.
- **Save changes.**

---

## 14. Google sign-in (optional — skip it)

Email links (Part 3) already sign everyone in, so you don't need Google sign-in.

Google only accepts sign-in addresses on domains it can verify. `localhost` works for you alone. A `ts.net` address may be refused, and you can't verify a domain you don't own.

If you want it on your own Mac anyway:
1. <https://console.cloud.google.com/> → create a project → **APIs & Services → OAuth consent screen**:
   - **External**;
   - app name `Brio`;
   - your email;
   - add yourself under **Test users**.
2. **Credentials → Create credentials → OAuth client ID**:
   - **Web application**;
   - **Authorized redirect URI:** `http://localhost:8080/api/auth/callback/google`.
3. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then run `docker compose up -d`.

This only works while you open Brio at `http://localhost:8080`, not at the `ts.net` address.

---

## What you can't do without paying (and don't need to)

- **Email from `@yourname.com`** needs a domain. Gmail's own address works fine.
- **Brio online while your Mac is off** needs a server that is always on. If you later want one:
  - Oracle Cloud's Always Free tier has a 4-core, 24 GB machine; it asks for a card to verify you, but doesn't charge.
  - Follow Parts 1, 3 and 4 there, the same way.
