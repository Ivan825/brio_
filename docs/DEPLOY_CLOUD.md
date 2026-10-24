# Deploy Brio on a cloud server

Brio is self-hosted: it runs on a machine you control. This guide puts it on a rented Linux server, so it is online all the time, with real HTTPS and **no domain to buy**. It is the same Docker Compose bundle as on a laptop ([Self-hosting](SELF_HOST.md)); only the machine and the address change.

**Which machine?**

| Option | Cost | Address | Use it when |
|---|---|---|---|
| **A. Azure for Students** | free: a small server is included (750 hours a month), plus $100 of credit a year; no card | free `yourname.<region>.cloudapp.azure.com` | you are a student |
| **B. Any Ubuntu server** (Hetzner, DigitalOcean, Linode, AWS Lightsail, your own box) | from about €5–25 a month | free `yourname.duckdns.org` | everyone else |
| Your own laptop | free | Tailscale Funnel | trying it out: [Owner setup](OWNER_SETUP.md) |
| Kubernetes | your cluster | your ingress | teams with a cluster: [Self-hosting §2](SELF_HOST.md#2-kubernetes-with-helm-about-25-minutes) |

**What the server needs:**
- **Smallest (one person):** 1–2 CPUs, **1 GB RAM** with 4 GB of swap, and a 64 GB disk. The server downloads Brio's ready-made images (`./setup.sh --prebuilt`) instead of building them, and runs one task at a time. Measured: Brio's five containers use about 510 MB idle and 560 MB at their peak while a mission plans, runs a sandboxed task and checks it; Ubuntu itself needs roughly 300 MB more, and swap absorbs the rest. Chat and agents reached through vendors' APIs (Gemini, Groq, OpenAI, Claude) fit comfortably; coding agents that run inside sandboxes on the server (Claude Code, Codex) are slow on 1 GB.
- **Building the images on the server instead:** 2 CPUs, 4 GB RAM with 4 GB of swap, and a 64 GB disk.
- **Comfortable for a small team:** 4 CPUs, 8 GB RAM and 80–100 GB of disk.
- **What uses the disk:** Brio's three images, the sandbox images (the browser sandbox, which carries Chromium, is only built the first time a task needs it), Docker's build cache, one git worktree per running attempt, and the database. [Disk](#disk) below says how to keep it in check.

---

## A. Azure for Students (free for students)

### A1. Get the student offer (10 min)
1. Open <https://azure.microsoft.com/free/students> and click **Start free**.
2. Sign in with a Microsoft account, then verify with your **school email** (for example `you@iiitb.ac.in`).
   - Microsoft includes some services for free, among them 750 hours a month of a small server (enough to run one all month), and gives $100 of credit for 12 months for everything else. No card. It renews each year while you are a student.
   - Optional: the GitHub Student Developer Pack (<https://education.github.com/pack>) lists more student offers. Check what it currently includes.

### A2. Create the server (10 min)
1. In <https://portal.azure.com>, search **Virtual machines** → **Create** → **Azure virtual machine**.
2. **Basics** tab:
   - **Subscription:** *Azure for Students*.
   - **Resource group:** **Create new** → `brio`.
   - **Virtual machine name:** `brio`.
   - **Region:** the one nearest you (for example *Central India*).
   - **Image:** *Ubuntu Server 24.04 LTS – x64 Gen2*.
   - **Size:** click **See all sizes** and pick **Standard_B2ats_v2** (2 vCPUs, 1 GiB), one of the sizes included for free (750 hours a month).
     - The portal shows its normal monthly price; the free hours are taken off your bill. After a day, **Cost Management** shows what you were actually charged.
     - Not offered in your region? Try another region (*South India*, *East US*), or **Standard_B1s** (1 vCPU, 1 GiB), also free. **Standard_B2pts_v2** is free too, but needs the image *Ubuntu Server 24.04 LTS – Arm64*.
     - For more room, *Standard_B2s* (4 GB) costs roughly $30–40 a month from your credit, and can build the images itself.
   - **Authentication type:** *SSH public key*; **Username:** `brio`.
   - **SSH public key source:** *Generate new key pair*; **Key pair name:** `brio-key`.
   - **Public inbound ports:** *Allow selected ports* → tick **SSH (22)**, **HTTP (80)** and **HTTPS (443)**.
3. **Disks** tab:
   - **OS disk size:** **64 GiB**.
   - **OS disk type:** **Premium SSD**. A 64 GiB Premium SSD (P6) is included for free for 12 months; a bigger disk is paid from your credit.
4. **Review + create** → **Create** → **Download private key and create resource**. Keep `brio-key.pem` safe: it is your only way in.
5. When it finishes, click **Go to resource**.

### A3. A free, permanent address (3 min)
1. On the VM's page, click the **Public IP address** link.
2. In the left menu, open **Configuration**:
   - **Assignment:** **Static**, so the address survives restarts.
   - **DNS name label:** a unique name, for example `brio-ivan`.
   - **Save**.
3. Your address is now `brio-ivan.<region>.cloudapp.azure.com` (for example `brio-ivan.centralindia.cloudapp.azure.com`). Copy it.

### A4. Connect (2 min)
On your Mac:
```sh
chmod 600 ~/Downloads/brio-key.pem
ssh -i ~/Downloads/brio-key.pem brio@brio-ivan.centralindia.cloudapp.azure.com
```
Type `yes` the first time. Continue with **[Install Brio on the server](#install-brio-on-the-server)**, using your `cloudapp.azure.com` address.

**Spending:** in the portal, **Cost Management → Budgets**, set a budget of $5 a month with an email alert, so you hear about anything that is not free (the public IP address can cost a little). On a paid size, **Stop** the VM from its page when you are not using Brio: a stopped (deallocated) VM costs only its disk.

---

## B. Any Ubuntu server, with a free DuckDNS address

### B1. Rent a server
Any provider works:
- **Image:** Ubuntu 24.04.
- **Size:** at least 1 GB RAM with ready-made images, or 2 CPUs and 4 GB to build them on the server; 64 GB of disk (see the top of this page).
- **Firewall:** open ports 22, 80 and 443.
- **Address:** the server's public IPv4 address must not change. Most providers keep it for as long as the server exists.

Copy the server's **public IPv4 address**, then SSH in as your provider describes: `ssh root@<ip>`, or with their key.

### B2. A free address (3 min)
1. Open <https://www.duckdns.org> and sign in with GitHub or Google.
2. Under **domains**, type a name, for example `brio-yourname`, and click **add domain**.
3. In the **current ip** box next to it, paste your **server's** IP address (not your home one) and click **update ip**.
4. Your address is `brio-yourname.duckdns.org`. Check it from your laptop: `ping brio-yourname.duckdns.org` should show the server's IP.

Continue below, using your `duckdns.org` address.

---

## Install Brio on the server

Everything below runs on the server, over SSH. `ADDRESS` means your address from A3 or B2, without `https://`.

**1. Swap**, so Brio never runs out of memory on a small machine (1 min):
```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**2. Docker** (2 min):
```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```
Then SSH in again, so the group change applies, and check with `docker version`.

**3. Brio's code and settings** (2 min):
```sh
git clone https://github.com/Ivan825/brio_.git brio
cd brio/deploy/compose
./setup.sh https://ADDRESS --prebuilt
nano .env
```

`--prebuilt` makes the server download Brio's images, which GitHub builds for every commit that passes its checks. Leave it out to build them on the server instead (4 GB of memory needed).

In `.env`, change these lines:

```
BRIO_SITE_ADDRESS=ADDRESS
BRIO_HTTP_PORT=80
BRIO_HTTPS_PORT=443
BRIO_SIGNUP_ALLOW=you@example.com
BRIO_RUNNER_CONCURRENCY=1
```

- `BRIO_SITE_ADDRESS` is your address, without `https://`.
- `BRIO_SIGNUP_ALLOW` is your email address. Only you, and the people you invite from inside Brio, can create accounts.
- `BRIO_RUNNER_CONCURRENCY=1` runs one task at a time, which a 1 GB server needs. Keep `2` or more on a bigger server.

Optionally, fill in the email lines too (Gmail with an app password: [Owner setup, Part 3](OWNER_SETUP.md#3-email-from-your-gmail)). Without them, sign-in links appear in the log instead of being emailed.

Save with **Ctrl-O**, **Enter**, then **Ctrl-X**.

**Back up `.env` now.** Copy it to your laptop with `scp`: without `BRIO_VAULT_LOCAL_KEK`, the keys stored in Brio can never be decrypted. On your laptop:

```sh
scp -i ~/Downloads/brio-key.pem brio@ADDRESS:brio/deploy/compose/.env ~/brio-server.env
```

For option B, use your own SSH login instead.

**4. Start it.** With ready-made images (2–5 min, while they download):
```sh
docker compose pull
docker compose up -d --no-build
docker compose ps
```
Building on the server instead (10–20 min the first time): `docker compose up -d`, then `docker compose ps`.

Repeat `docker compose ps` until `api`, `runner` and `web` show `healthy`. Caddy fetches the HTTPS certificate on its own within a minute; ports 80 and 443 must be open for that.

**5. Sign in.** Open `https://ADDRESS` in your browser and enter your email. Without email set up, get the link with:
```sh
docker compose logs api | grep "Sign in to Brio" | tail -1
```
Open it once: each link works only once, for 15 minutes. Create your workspace, then follow [Getting started](GETTING_STARTED.md) to connect agents.

**Done when:** `https://ADDRESS` shows a padlock and Brio's missions page.

---

## Automatic updates

To have the server follow GitHub, so every new commit on `main` goes live by itself within about 5 minutes, run this once on the server:

```sh
cd ~/brio/deploy/compose/autoupdate
sudo ./install.sh
```

Every 5 minutes, a systemd timer runs `brio-update.sh`. When the branch has moved, it:
1. with ready-made images, waits until GitHub has published the new commit's images (about 15 minutes after a push; never, if its checks failed, so a broken commit is not installed);
2. pulls the new commits;
3. adds any new settings to `.env` (it never changes your values, except `BRIO_VERSION`, which it moves to the new commit's images);
4. downloads the new images and restarts Brio, or, without ready-made images, rebuilds and restarts;
5. removes the previous images and build layers, so updates don't fill the disk.

Your data stays in the database volume.

| To | Run |
|---|---|
| See what it did | `journalctl -u brio-update --since today` |
| Update right now | `~/brio/deploy/compose/autoupdate/brio-update.sh` |
| Only check whether an update is waiting | `~/brio/deploy/compose/autoupdate/brio-update.sh --check` |
| Turn it off | `sudo ./install.sh --remove` |

While an update downloads or builds, Brio keeps serving: the new containers replace the old ones once they are ready. Pages may blank for a few seconds during the swap.

## Running it

| To | Run (in `~/brio/deploy/compose`) |
|---|---|
| See what is running | `docker compose ps` |
| Read errors | `docker compose logs api --tail 100` (or `runner`, `web`, `caddy`) |
| Update Brio by hand | `autoupdate/brio-update.sh` (or turn on [automatic updates](#automatic-updates)) |
| Back up the database | `docker compose exec -T postgres pg_dump -U brio -d brio -Fc > ~/brio-$(date +%F).dump` |
| Stop / start | `docker compose stop` / `docker compose up -d --no-build` (without ready-made images: `docker compose up -d`) |

Brio restarts on its own after the server reboots.

### Disk
See what Docker uses with `docker system df`. The parts that grow:
- **Build cache** (only when building on the server): every update builds new images; the old layers stay in the cache.
- **Old images:** each update leaves the previous version's images behind.
- **The runner's worktrees:** one per running attempt, under `deploy/compose/data/runner`.

**Safe to clear at any time:**
```sh
docker builder prune -f      # build cache; the next update rebuilds a little slower
docker image prune -f        # untagged, unused images left by updates
```

Never run `docker system prune --volumes` or `docker compose down -v`: those delete Brio's database.

Check free space with `df -h /`. Keep at least 10 GB free; Postgres and Docker both stop working on a full disk.

### Troubleshooting

| Symptom | Fix |
|---|---|
| The browser says the connection is not private, or there is no certificate | Ports 80 and 443 must be open in the provider's firewall. `BRIO_SITE_ADDRESS` must be exactly your address, and the address must point to this server. Then check `docker compose logs caddy`. |
| A sign-in link says "already used or expired" | Each link works once, for 15 minutes. Ask for a new one. |
| "Too many requests" | Sign-in is limited to 5 tries a minute. Wait a minute. |
| The build stops with "killed" | Not enough memory: add the swap from step 1, or use ready-made images (`--prebuilt`). |
| `docker compose pull` says "denied" or "not found" | The images are not published under that name. Check `BRIO_IMAGE_PREFIX` (for this repository: `ghcr.io/ivan825/brio`); right after a push, wait about 15 minutes for GitHub to publish them. |
| The updater says a commit "is waiting for its images" | GitHub is still building them, or that commit's checks failed. It retries every 5 minutes; nothing is installed meanwhile. |
| "no space left on device" | See [Disk](#disk). |
