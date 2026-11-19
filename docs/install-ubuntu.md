# Installing MercerAlertService on Ubuntu

This guide installs MercerAlertService (MAS) on one Ubuntu Server VM. It covers Docker,
HTTPS through nginx with the internal certificate, the firewall, backups to a NAS, upgrades,
and recovery. Once the containers are running, everything else is set up in the browser. No
MAS configuration file is needed.

**What was tested.** These were run on Ubuntu 24.04 LTS with Docker Engine 29, Compose v5 and
nginx 1.24:

- building and starting the stack;
- the nginx site (HTTPS, live updates, sign-in, uploads, client addresses);
- backup, restore, and rebuilding on a new VM from the master key;
- recovery after a Docker restart;
- the proxy and CA settings for MAS itself (§13).

These were not run, and are standard Ubuntu and Docker procedures: installing Docker on a bare
VM, the GitHub deploy key, `ufw`, the NAS mount, and the apt and Docker daemon proxy settings.

Expect about an hour of hands-on work. Waiting for the certificate, DNS, firewall changes and
the Orion account usually takes longer, so request those first (§0).

**Contents**

0. [Before you start](#0-before-you-start)
1. [Prepare Ubuntu](#1-prepare-ubuntu)
2. [Install Docker Engine](#2-install-docker-engine)
3. [Get the code](#3-get-the-code)
4. [Host settings (`.env`, optional)](#4-host-settings-env-optional)
5. [Build and start](#5-build-and-start)
6. [HTTPS with nginx](#6-https-with-nginx)
7. [Firewall](#7-firewall)
8. [Finish setup in the browser](#8-finish-setup-in-the-browser)
9. [Backups off the VM](#9-backups-off-the-vm)
10. [Day-to-day commands](#10-day-to-day-commands)
11. [Upgrades](#11-upgrades)
12. [Restore and disaster recovery](#12-restore-and-disaster-recovery)
13. [If the VM must use a web proxy](#13-if-the-vm-must-use-a-web-proxy)
14. [Troubleshooting](#14-troubleshooting)

---

## 0. Before you start

**The VM**

| What        | Recommended                                          | Why                                                                                                                                           |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| OS          | Ubuntu Server **24.04 LTS** (26.04 LTS also OK)      | Docker's repository supports 22.04, 24.04 and 26.04.                                                                                          |
| CPU and RAM | 2 vCPU, 4 GB                                         | The running stack uses about 400 MB. Building the images (install and upgrades) needs the rest.                                               |
| Disk        | 40 GB                                                | Images take about 1.4 GB and the build cache up to 8 GB (it can be pruned). The database grows with history: watch it in the first few weeks. |
| Network     | Static IP and a DNS name, e.g. `netmon.mercer.local` | People, the wall TVs and Teams links use the name.                                                                                            |

**Ask for these early**

- **A TLS certificate for the DNS name** from the internal CA, as PEM files: the certificate
  with its intermediates, and the private key. Microsoft sign-in requires HTTPS.
- **The read-only Orion account** (see
  [Create the read-only Orion account](../README.md#create-the-read-only-orion-account-in-orion)).
- **Firewall rules:**

  | Direction | From → to                          | Port             | For                                                                                                                                                                                                                                           |
  | --------- | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Inbound   | IT and user subnets, wall TVs → VM | TCP 443 (and 80) | The dashboard. Port 80 only redirects to 443.                                                                                                                                                                                                 |
  | Inbound   | IT admin workstations → VM         | TCP 22           | SSH                                                                                                                                                                                                                                           |
  | Outbound  | VM → Orion server                  | TCP 17774        | SWIS                                                                                                                                                                                                                                          |
  | Outbound  | VM → internet                      | TCP 443          | **At run time:** `login.microsoftonline.com`, the Teams Workflows host (`*.logic.azure.com` / `*.powerplatform.com`), `api.pushover.net`, `api.twilio.com`, `api.anthropic.com` (optional AI).                                                |
  | Outbound  | VM → internet                      | TCP 443          | **To install and upgrade:** Ubuntu mirrors (`archive.ubuntu.com`, `security.ubuntu.com`), `download.docker.com`, Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`), `registry.npmjs.org`, and GitHub. |
  | Outbound  | VM → GitHub                        | TCP 22           | `git clone` / `git pull` over SSH (or use port 443, see §3)                                                                                                                                                                                   |
  | Outbound  | VM → NAS                           | TCP 445          | Backups (§9)                                                                                                                                                                                                                                  |

  People's browsers, not the VM, load map tiles from `tile.openstreetmap.org`, unless you use an
  offline map image (Settings → Map & wall). If the VM can reach the internet only through a
  web proxy, read §13 before §2.

- **Someone who can add a deploy key** to the GitHub repository,
  [farmera2005/MercerAlertService](https://github.com/farmera2005/MercerAlertService) (§3).

---

## 1. Prepare Ubuntu

Install Ubuntu Server with **OpenSSH server** and nothing else. Then sign in as your admin
account and update:

```bash
sudo apt-get update && sudo apt-get -y full-upgrade
```

```bash
sudo reboot
```

**Time.** TLS, Microsoft sign-in and alert timestamps all need an accurate clock. Check that
the clock is synchronized:

```bash
timedatectl
```

It should say `System clock synchronized: yes`. If the VM can't reach public NTP, point it at
the domain controllers: set `NTP=dc1.mercer.local dc2.mercer.local` under `[Time]` in
`/etc/systemd/timesyncd.conf`, then restart the time service:

```bash
sudo systemctl restart systemd-timesyncd
```

Optionally set the VM's own time zone so its logs read in local time. MAS itself uses the time
zone chosen in its settings, not the VM's.

```bash
sudo timedatectl set-timezone America/New_York
```

**Check that Orion is reachable** before installing anything:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://orion.mercer.local:17774/SolarWinds/InformationService/v3/Json/Query
```

Any HTTP status, typically `401`, means the port is open. `000` after a long wait means a
firewall is in the way. An immediate `000` means the name doesn't resolve or the port is closed.

---

## 2. Install Docker Engine

Use Docker's own repository. Ubuntu's `docker.io` packages can be too old for this Compose file,
which needs Compose 2.24 or newer.

Remove any conflicting packages. It's fine if none are installed.

```bash
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do sudo apt-get remove -y $pkg; done
```

Add Docker's signing key:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

```bash
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Add the repository:

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Install Docker Engine, Buildx and the Compose plugin:

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Check the installation. Compose must report v2.24 or newer, and Docker must be enabled at boot:

```bash
sudo docker run --rm hello-world
```

```bash
docker compose version
```

```bash
systemctl is-enabled docker
```

**Who may run Docker.** Membership in the `docker` group is equivalent to root on this VM. Add
only the IT admins who run MAS:

```bash
sudo usermod -aG docker $USER
```

Sign out and back in for the group to take effect. The rest of this guide assumes you can run
`docker` without `sudo`.

---

## 3. Get the code

The code is in the private GitHub repository
**[farmera2005/MercerAlertService](https://github.com/farmera2005/MercerAlertService)**:

| What           | Value                                               |
| -------------- | --------------------------------------------------- |
| Web page       | `https://github.com/farmera2005/MercerAlertService` |
| Clone over SSH | `git@github.com:farmera2005/MercerAlertService.git` |
| Default branch | `claude/solarwinds-alert-correlation-90rlgx`        |

Because the repository is private, the VM uses a read-only **deploy key**. Run every command
in this section as your own admin account, **without `sudo`**. Root has its own `~/.ssh`
without the key, so `sudo git clone` fails with `Permission denied (publickey)`.

Create the key on the VM:

```bash
ssh-keygen -t ed25519 -N '' -C 'mas-vm deploy key' -f ~/.ssh/mas_deploy
```

```bash
cat ~/.ssh/mas_deploy.pub
```

Add it in GitHub under the repository's
[Settings → Deploy keys](https://github.com/farmera2005/MercerAlertService/settings/keys) →
**Add deploy key**. This needs admin rights on the repository. Paste the public key, name it
after the VM, and leave **Allow write access** unchecked.

Then tell SSH to use that key for GitHub. SSH only tries `~/.ssh/id_*` on its own, so without
this, GitHub never sees the deploy key:

```bash
printf 'Host github.com\n  User git\n  IdentityFile ~/.ssh/mas_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
```

If outbound port 22 is blocked, use GitHub's SSH-over-HTTPS endpoint instead: add
`HostName ssh.github.com` and `Port 443` to that block in `~/.ssh/config`.

Check that the key works:

```bash
ssh -T git@github.com
```

The first time, SSH asks you to confirm GitHub's host key. Compare the fingerprint with
[GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
before answering `yes`. Its ED25519 fingerprint is
`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`. A working key gets the answer
`Hi farmera2005/MercerAlertService! You've successfully authenticated, but GitHub does not
provide shell access.`

If it says `Permission denied (publickey)` instead:

1. Make sure you ran it without `sudo`.
2. Check that SSH offers the deploy key. The output should mention `mas_deploy`:

   ```bash
   ssh -vT git@github.com 2>&1 | grep -E 'Offering public key|Authenticated'
   ```

3. Check that GitHub has this same key. Compare the fingerprint below with the one shown under
   **Settings → Deploy keys** on GitHub:

   ```bash
   ssh-keygen -lf ~/.ssh/mas_deploy.pub
   ```

Clone into `/opt/mercer-alert-service`:

```bash
sudo install -d -o $USER -g $USER /opt/mercer-alert-service
```

```bash
git clone git@github.com:farmera2005/MercerAlertService.git /opt/mercer-alert-service
```

The clone checks out the default branch, which holds the current version; there are no release
tags yet. Once releases are tagged, pin production to one, for example:

```bash
cd /opt/mercer-alert-service && git checkout v1.0.0
```

The rest of this guide runs commands from `/opt/mercer-alert-service`.

---

## 4. Host settings (`.env`, optional)

MAS needs no configuration file. The setup wizard stores everything in the database, and
secrets are encrypted. A `.env` file in the project directory is only for a few things about
the VM itself.

With nginx on the same VM (§6), publish the dashboard on localhost only, so it can't be
reached around nginx:

```bash
printf 'WEB_PORT=127.0.0.1:3000\n' > .env && chmod 600 .env
```

This matters because Docker's published ports bypass `ufw` (§7), so a firewall rule alone
would not protect port 3000. The database port is always bound to `127.0.0.1`.

Other host-side variables you might add later:

| Variable          | Default     | When to change                                  |
| ----------------- | ----------- | ----------------------------------------------- |
| `DB_PORT`         | `5432`      | Another Postgres already uses 5432 on this VM.  |
| `BACKUP_HOST_DIR` | `./backups` | Backups should go straight to a NAS share (§9). |
| `BACKUP_TIME`     | `02:30`     | Nightly backup time, local time.                |
| `BUILD_CA_FILE`   | (empty)     | Builds go through a TLS-inspecting proxy (§13). |

[.env.example](../.env.example) lists every variable. Any **MAS setting** you put in `.env`
overrides the web UI and shows as locked there, so leave those out unless you manage the VM as
code. `.env` is in `.gitignore`: never commit it.

---

## 5. Build and start

```bash
APP_VERSION=$(git describe --always) docker compose up -d --build
```

The first build takes about 5–10 minutes. Then check the state:

```bash
docker compose ps -a
```

Expected:

| Service   | State                           |
| --------- | ------------------------------- |
| `init`    | Exited (0): created the secrets |
| `migrate` | Exited (0): created the tables  |
| `db`      | Up (healthy)                    |
| `worker`  | Up (healthy)                    |
| `web`     | Up (healthy)                    |
| `backup`  | Up                              |

Get the one-time **setup code**:

```bash
docker compose logs web | grep -i "setup code"
```

The line reads `SETUP REQUIRED — open the dashboard in a browser and enter setup code XXXX-XXXX`.

Check health from the VM. The response should be HTTP 200 with `"status":"setup_required"`:

```bash
curl -sS http://127.0.0.1:3000/api/health
```

Don't open the wizard yet if you're about to set up nginx. Doing §6 first means the wizard
already runs under the final HTTPS address.

---

## 6. HTTPS with nginx

Install nginx and put the certificate in place:

```bash
sudo apt-get install -y nginx
```

```bash
sudo install -d -m 755 /etc/ssl/mas
```

Copy the certificate to `/etc/ssl/mas/netmon.crt` (the server certificate first, then the
intermediates) and the key to `/etc/ssl/mas/netmon.key`. Make the key readable by root only:

```bash
sudo chmod 600 /etc/ssl/mas/netmon.key
```

Create `/etc/nginx/sites-available/mas` (for example with `sudo nano`) and replace
`netmon.mercer.local` with your DNS name:

```nginx
# MercerAlertService behind nginx with the internal TLS certificate.
server {
    listen 80;
    listen [::]:80;
    server_name netmon.mercer.local;
    return 301 https://$host$request_uri;
}

server {
    # nginx 1.25.1+ (Ubuntu 26.04): write "listen 443 ssl;" and add "http2 on;".
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name netmon.mercer.local;

    ssl_certificate     /etc/ssl/mas/netmon.crt;   # server certificate + intermediates
    ssl_certificate_key /etc/ssl/mas/netmon.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;

    # Offline map images (Settings → Map & wall) are up to 5 MB.
    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Replace, never append: MAS must not see an address the browser made up.
        proxy_set_header X-Forwarded-For $remote_addr;
        # Live updates are a long-lived stream (MAS sends a keep-alive every 15 s and
        # X-Accel-Buffering: no, so nginx passes events through at once).
        proxy_read_timeout 1h;
    }
}
```

Why these lines matter:

- **`Host`** must be passed through. Without it, sign-in and every button fail, because the
  browser's origin no longer matches.
- **`client_max_body_size`**: nginx's default of 1 MB would reject map image uploads.
- **HTTP/2** lets many open dashboard tabs share one connection. Each tab keeps a live-update
  stream open.

Enable the site, replace nginx's default site, and test:

```bash
sudo ln -s /etc/nginx/sites-available/mas /etc/nginx/sites-enabled/mas && sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If `nginx -t` fails with `socket() [::]:80 failed (97: Address family not supported by
protocol)`, IPv6 is disabled on this VM: delete the two `listen [::]` lines and test again.

Check from your workstation. You should get `200`, and `http://` should redirect to `https://`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://netmon.mercer.local/api/health
```

---

## 7. Firewall

Allow SSH and nginx, then turn `ufw` on:

```bash
sudo ufw allow OpenSSH
```

```bash
sudo ufw allow 'Nginx Full'
```

```bash
sudo ufw enable && sudo ufw status verbose
```

To limit the dashboard to certain subnets, replace `'Nginx Full'` with one rule per subnet,
for example `sudo ufw allow from 10.20.0.0/16 to any port 443 proto tcp`.

**Docker and ufw.** Ports that Docker publishes bypass `ufw` rules. That's why §4 publishes
the dashboard on `127.0.0.1` only, and why the Compose file binds Postgres to `127.0.0.1`.
From another machine, `http://netmon.mercer.local:3000` must **not** answer. From the VM,
`curl http://127.0.0.1:3000/api/health` should.

---

## 8. Finish setup in the browser

Open `https://netmon.mercer.local` and follow the wizard (described step by step in the
[README](../README.md#install-on-the-linux-vm-no-config-files)). Points specific to this
install:

- **Step 2, SolarWinds.** Use the Orion server's DNS name and compare the certificate thumbprint
  as described in [The Orion certificate](../README.md#the-orion-certificate).
- **Step 5, General.** Make these three changes:
  - set **Dashboard URL** to `https://netmon.mercer.local`. Teams links, SMS links and the
    Microsoft sign-in redirect use it.
  - turn on **Behind a reverse proxy**, with **Number of proxies in front of MAS** = `1`.
    Without this, the audit log records every person as the Docker gateway address (such as
    `172.18.0.1`), and wall links limited to an address range don't work.
  - leave the time zone as `America/New_York` unless you have a reason to change it.

After **Start monitoring**:

- **Settings → Overview** lists what is still missing before go-live: Teams webhooks,
  on-call people, Microsoft sign-in, the AI key, and so on.
- **Microsoft sign-in.** Follow the README section
  [Microsoft sign-in (Entra ID)](../README.md#microsoft-sign-in-entra-id). The redirect URI it
  shows is `https://netmon.mercer.local/api/auth/callback/microsoft-entra-id`. Entra only
  accepts `https://` redirect URIs, which is why nginx comes first.
- **Wall TVs** must trust the internal CA, or they'll show a certificate warning. Many smart-TV
  browsers can't import a CA. A small domain-joined PC or stick in kiosk mode is usually easier.
- **Monitor MAS from Orion.** Add an Orion SAM HTTP(S) monitor on
  `https://netmon.mercer.local/api/health`. It returns 503 if the worker or database stops, so
  SolarWinds watches the watcher.

---

## 9. Backups off the VM

Every night at `BACKUP_TIME` (02:30 local time), the `backup` container writes
`mas-<timestamp>.dump` to `./backups`. It keeps 14 days of dumps, and files are readable by
root only. Take one now to check:

```bash
docker compose exec backup /backup.sh now
```

```bash
sudo ls -l backups/
```

**Keep the master key separately.** Saved passwords, webhook URLs and API keys are encrypted
with a key that is **not** in the dumps. Export it once and store it in the IT password vault,
not next to the dumps:

```bash
docker compose run --rm --no-deps -T --entrypoint cat worker /bootstrap/master_key > mas-master-key.txt
```

After storing it, delete the local copy:

```bash
shred -u mas-master-key.txt
```

**Sending the dumps to a NAS (SMB share).** Install the SMB client:

```bash
sudo apt-get install -y cifs-utils
```

Create `/etc/mas-nas.cred` with `sudo nano`, owned by root and mode 600 (`sudo chmod 600
/etc/mas-nas.cred`), containing:

```
username=svc-mas-backup
password=<the password>
domain=MERCER
```

Create the mount point:

```bash
sudo install -d -m 700 /mnt/mas-backups
```

Add this line to `/etc/fstab`, adjusting the share path:

```
//nas01.mercer.local/it-backups/mas  /mnt/mas-backups  cifs  credentials=/etc/mas-nas.cred,uid=0,gid=0,dir_mode=0700,file_mode=0600,vers=3.0,_netdev,nofail  0  0
```

Mount it and check:

```bash
sudo systemctl daemon-reload && sudo mount /mnt/mas-backups && mount | grep mas-backups
```

Docker starts early at boot, possibly before the share is mounted. In that case the first dumps
would land on the local disk under `/mnt/mas-backups`. To make Docker start after network
mounts (it still starts if the NAS is down), open an override for the Docker service:

```bash
sudo systemctl edit docker
```

Add these two lines, then save:

```
[Unit]
After=remote-fs.target
```

Point MAS at the share, recreate the backup container, and take a test backup:

```bash
printf 'BACKUP_HOST_DIR=/mnt/mas-backups\n' >> .env
```

```bash
docker compose up -d backup && docker compose exec backup /backup.sh now
```

`BACKUP_KEEP_DAYS` (14) applies to the share as well. Keep longer history with the NAS's own
snapshots.

---

## 10. Day-to-day commands

Run these from `/opt/mercer-alert-service`.

| Task                             | Command                                        |
| -------------------------------- | ---------------------------------------------- |
| Status of every service          | `docker compose ps -a`                         |
| Health                           | `curl -sS http://127.0.0.1:3000/api/health`    |
| Follow the worker log (raw JSON) | `docker compose logs -f worker`                |
| Restart one service              | `docker compose restart worker`                |
| Stop everything / start it again | `docker compose stop` / `docker compose up -d` |
| Backup now                       | `docker compose exec backup /backup.sh now`    |
| Disk used by Docker              | `docker system df`                             |
| `psql` into the database         | `docker compose exec db psql -U mas mas`       |

For readable logs, install `jq` (`sudo apt-get install -y jq`) and run:

```bash
docker compose logs -f --no-log-prefix worker | jq -rR 'fromjson? | "\(.time) \(.level) [\(.component)] \(.msg)"'
```

**After a reboot** everything comes back by itself: Docker starts at boot, and the services
use `restart: unless-stopped`. The exception is a service stopped with `docker compose stop`,
which stays stopped until you run `docker compose up -d`.

**Never run `docker compose down -v`** on the production VM. The `-v` deletes the database
**and** the master key. `docker compose down` without `-v` is safe.

---

## 11. Upgrades

1. Take a backup:

   ```bash
   docker compose exec backup /backup.sh now
   ```

2. Get the new version. While production follows the default branch (the setup in §3):

   ```bash
   git pull --ff-only
   ```

   Once production is pinned to release tags, check out the new tag instead:

   ```bash
   git fetch --tags && git checkout v1.1.0
   ```

3. Rebuild and restart. This also applies database migrations:

   ```bash
   APP_VERSION=$(git describe --always) docker compose up -d --build
   ```

4. Check that everything is up:

   ```bash
   docker compose ps -a && curl -fsS http://127.0.0.1:3000/api/health
   ```

5. Reclaim disk from old images and the build cache:

   ```bash
   docker image prune -f && docker builder prune -f
   ```

Migrations only move forward. To roll back, check out the previous version and restore the
backup from step 1 (§12).

**Ubuntu and Docker updates.** `unattended-upgrades` installs Ubuntu security updates but not
Docker packages, which come from Docker's repository. Upgrade Docker during a maintenance
window with `sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli
containerd.io docker-buildx-plugin docker-compose-plugin`. The containers restart
automatically, about a minute of downtime.

---

## 12. Restore and disaster recovery

**Restore a dump on the same VM.** Restore into a freshly created database: restoring over the
live one fails on the job queue's partitioned tables.

1. Stop the services that write to the database:

   ```bash
   docker compose stop worker web
   ```

2. Drop and recreate the database:

   ```bash
   docker compose exec -T db dropdb -U mas --force mas && docker compose exec -T db createdb -U mas mas
   ```

3. Restore the dump:

   ```bash
   docker compose exec -T db pg_restore -U mas -d mas --no-owner --exit-on-error < backups/mas-YYYYMMDDTHHMMSSZ.dump
   ```

4. Start everything. This also applies migrations, in case the dump came from an older version:

   ```bash
   docker compose up -d
   ```

**Rebuild on a new VM.**

1. Do §1–§4 on the new VM, but don't start MAS yet.
2. Build the images:

   ```bash
   APP_VERSION=$(git describe --always) docker compose build
   ```

3. Put the saved master key in place **before** the first start. The `init` container keeps an
   existing key and only generates what is missing:

   ```bash
   docker compose run --rm --no-deps -T --user root --entrypoint sh init -c 'cat > /bootstrap/master_key && chown 1000:1000 /bootstrap/master_key && chmod 400 /bootstrap/master_key' < mas-master-key.txt
   ```

4. Start the database alone:

   ```bash
   docker compose up -d init db
   ```

5. Restore the latest dump as above: the `dropdb`/`createdb` and `pg_restore` steps.
6. Start everything:

   ```bash
   docker compose up -d
   ```

7. Do §6 and §7. The settings, including the saved Orion password and webhooks, come back with
   the dump.

Without the master key, everything except the secrets is restored. Re-enter the Orion password,
webhook URLs and API keys in Settings.

---

## 13. If the VM must use a web proxy

Skip this section if the firewall allows the VM out directly (§0).

**Ubuntu packages.** Create `/etc/apt/apt.conf.d/95proxy` containing:

```
Acquire::http::Proxy "http://proxy.mercer.local:8080";
Acquire::https::Proxy "http://proxy.mercer.local:8080";
```

**Docker image pulls.** Create `/etc/docker/daemon.json` (the Docker daemon's configuration):

```json
{
  "proxies": {
    "http-proxy": "http://proxy.mercer.local:8080",
    "https-proxy": "http://proxy.mercer.local:8080",
    "no-proxy": "localhost,127.0.0.1,.mercer.local"
  }
}
```

Then restart Docker:

```bash
sudo systemctl restart docker
```

**Image builds.** In `~/.docker/config.json` of the user who runs `docker compose`, add the
following. Docker passes it to every build.

```json
{
  "proxies": {
    "default": {
      "httpProxy": "http://proxy.mercer.local:8080",
      "httpsProxy": "http://proxy.mercer.local:8080",
      "noProxy": "localhost,127.0.0.1,.mercer.local"
    }
  }
}
```

**MAS at run time** (Teams, Twilio, Pushover, Microsoft sign-in, Claude). Add these lines to
`.env`. `NODE_USE_ENV_PROXY=1` is what makes Node.js use the proxy. Keep `localhost` and
`127.0.0.1` in `NO_PROXY`: the containers' own health checks use them. The SolarWinds
connection never goes through the proxy.

```
HTTP_PROXY=http://proxy.mercer.local:8080
HTTPS_PROXY=http://proxy.mercer.local:8080
NO_PROXY=localhost,127.0.0.1,.mercer.local
NODE_USE_ENV_PROXY=1
```

**If the proxy inspects TLS** (it presents its own certificates), everything must also trust its
CA:

1. Save the CA certificate as `secrets/corp-ca.pem` in the project directory. `secrets/` is in
   `.gitignore`. Then make the file readable by the containers:

   ```bash
   chmod 644 secrets/corp-ca.pem
   ```

2. **For Ubuntu and Docker pulls**, install the CA into the system store and restart Docker:

   ```bash
   sudo cp secrets/corp-ca.pem /usr/local/share/ca-certificates/corp-ca.crt && sudo update-ca-certificates
   ```

   ```bash
   sudo systemctl restart docker
   ```

3. **For builds**, add `BUILD_CA_FILE=./secrets/corp-ca.pem` to `.env`.
4. **At run time**, create `docker-compose.override.yml` next to `docker-compose.yml`. Compose
   loads it automatically, and it is in `.gitignore`.

   ```yaml
   # Site-specific: trust the TLS-inspecting proxy's CA.
   services:
     migrate: &corp-ca
       environment:
         NODE_EXTRA_CA_CERTS: /run/secrets/corp-ca.pem
       volumes:
         - ./secrets/corp-ca.pem:/run/secrets/corp-ca.pem:ro
     worker: *corp-ca
     web: *corp-ca
   ```

5. Apply it:

   ```bash
   docker compose up -d
   ```

---

## 14. Troubleshooting

| Symptom                                                                                      | Cause and fix                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git clone` fails with `Permission denied (publickey)`                                       | The command ran with `sudo`, the `Host github.com` block is missing from `~/.ssh/config`, or the deploy key isn't on the repository. §3 has the checks.              |
| `docker compose` isn't found, or rejects the `required` key under `env_file`                 | Compose is missing or older than 2.24. Install it from Docker's repository (§2).                                                                                     |
| `permission denied while trying to connect to the Docker daemon socket`                      | Your account isn't in the `docker` group yet: sign out and back in after `usermod` (§2), or use `sudo`.                                                              |
| `failed to bind host port … address already in use`                                          | Something else uses that port. For 5432 (a local Postgres), set `DB_PORT=55432` in `.env`. For 3000, set `WEB_PORT=127.0.0.1:3001` and change `proxy_pass` to match. |
| The build fails with `SELF_SIGNED_CERT_IN_CHAIN` or `unable to get local issuer certificate` | A TLS-inspecting proxy: §13, `BUILD_CA_FILE`.                                                                                                                        |
| No setup code in the log                                                                     | Setup is already complete (sign in instead), or `web` hasn't started: `docker compose ps -a`, `docker compose logs web`.                                             |
| nginx: `socket() [::]:80 failed (97: …)`                                                     | IPv6 is disabled: remove the `listen [::]` lines (§6).                                                                                                               |
| `502 Bad Gateway` from nginx                                                                 | `web` isn't running or listens elsewhere: `docker compose ps -a`, then check that `proxy_pass` matches `WEB_PORT`.                                                   |
| `413 Request Entity Too Large` when uploading a map image                                    | `client_max_body_size` is missing from the nginx site (§6).                                                                                                          |
| The audit log shows `172.x.x.x` for everyone                                                 | Turn on **Behind a reverse proxy** in Settings → General (§8).                                                                                                       |
| The dot next to your name says **Reconnecting** all the time                                 | Something between the browser and MAS buffers or cuts long requests. Use the nginx site as given; check any other proxy or load balancer in the path.                |
| **Test connection** to Orion times out                                                       | Firewall between the VM and Orion on 17774 (check with the `curl` in §1).                                                                                            |
| Orion fails with a certificate error                                                         | Fetch and trust the certificate again in Settings → SolarWinds, and check **Certificate name** ([The Orion certificate](../README.md#the-orion-certificate)).        |
| The VM's disk is filling up                                                                  | `docker system df`, then `docker builder prune -f`. Check `BACKUP_KEEP_DAYS` and the retention settings in Settings → General.                                       |
| Teams, SMS or AI calls fail behind a web proxy                                               | `NODE_USE_ENV_PROXY=1` and the proxy variables in `.env` (§13), plus the CA override if the proxy inspects TLS.                                                      |
