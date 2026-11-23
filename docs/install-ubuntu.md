# Installing MercerAlertService on Ubuntu

This guide installs MercerAlertService (MAS) on one Ubuntu Server VM. It covers Docker,
HTTPS through nginx with the internal certificate, the firewall, backups to a NAS, upgrades,
and recovery. Once the containers are running, everything else is set up in the browser. No
MAS configuration file is needed.

**What was tested.** These were run on Ubuntu 24.04 LTS with Docker Engine 29, Compose v5 and
nginx 1.24:

- cloning the public repository over HTTPS without credentials;
- downloading the images from a registry and starting the stack (no build on the VM). The
  published images on `ghcr.io` are readable anonymously. The full download was tested from a
  local mirror, because the test environment blocks GitHub's download host;
- the nginx site (HTTPS, live updates, sign-in, uploads, client addresses);
- backup, restore, and rebuilding on a new VM from the master key;
- recovery after a Docker restart;
- the proxy and CA settings for MAS itself (§13).

These were not run, and are standard Ubuntu and Docker procedures: installing Docker on a bare
VM, the GitHub deploy key (needed only if the repository is private), `ufw`, the NAS mount, and the apt and Docker daemon proxy settings.

Expect about an hour of hands-on work. Waiting for the certificate, DNS, firewall changes and
the Orion account usually takes longer, so request those first (§0).

**Contents**

0. [Before you start](#0-before-you-start)
1. [Prepare Ubuntu](#1-prepare-ubuntu)
2. [Install Docker Engine](#2-install-docker-engine)
3. [Get the code](#3-get-the-code)
4. [Host settings (`.env`, optional)](#4-host-settings-env-optional)
5. [Download and start](#5-download-and-start)
6. [HTTPS with nginx](#6-https-with-nginx)
7. [Firewall](#7-firewall)
8. [Finish setup in the browser](#8-finish-setup-in-the-browser)
9. [Backups off the VM](#9-backups-off-the-vm)
10. [Day-to-day commands](#10-day-to-day-commands)
11. [Upgrades](#11-upgrades)
12. [Restore and disaster recovery](#12-restore-and-disaster-recovery)
13. [If the VM must use a web proxy](#13-if-the-vm-must-use-a-web-proxy)
14. [Troubleshooting](#14-troubleshooting)
15. [Remote access with Cloudflare Zero Trust (optional)](#15-remote-access-with-cloudflare-zero-trust-optional)

---

## 0. Before you start

**The VM**

| What        | Recommended                                          | Why                                                                                                                                            |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OS          | Ubuntu Server **24.04 LTS** (26.04 LTS also OK)      | Docker's repository supports 22.04, 24.04 and 26.04.                                                                                           |
| CPU and RAM | 2 vCPU, 4 GB                                         | The running stack uses about 400 MB; the rest is headroom for the database. Building the images yourself (optional, §11) also fits.            |
| Disk        | 30 GB                                                | Images take about 1.2 GB. The database grows with history: watch it in the first few weeks. Building images yourself adds up to 8 GB of cache. |
| Network     | Static IP and a DNS name, e.g. `netmon.mercer.local` | People, the wall TVs and Teams links use the name.                                                                                             |

**Ask for these early**

- **A TLS certificate for the DNS name** from the internal CA, as PEM files: the certificate
  with its intermediates, and the private key. Microsoft sign-in requires HTTPS.
- **The read-only Orion account** (see
  [Create the read-only Orion account](../README.md#create-the-read-only-orion-account-in-orion)).
- **Firewall rules:**

  | Direction | From → to                          | Port             | For                                                                                                                                                                                                                                                                                                                                                                                            |
  | --------- | ---------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Inbound   | IT and user subnets, wall TVs → VM | TCP 443 (and 80) | The dashboard. Port 80 only redirects to 443.                                                                                                                                                                                                                                                                                                                                                  |
  | Inbound   | IT admin workstations → VM         | TCP 22           | SSH                                                                                                                                                                                                                                                                                                                                                                                            |
  | Outbound  | VM → Orion server                  | TCP 17774        | SWIS                                                                                                                                                                                                                                                                                                                                                                                           |
  | Outbound  | VM → internet                      | TCP 443          | **At run time:** `login.microsoftonline.com`, the Teams Workflows host (`*.environment.api.powerplatform.com`), `api.pushover.net`, `api.twilio.com`, `api.anthropic.com` (optional AI), `nominatim.openstreetmap.org` (placing sites from their address).                                                                                                                                     |
  | Outbound  | VM → Cloudflare                    | TCP + UDP 7844   | Only with remote access through a Cloudflare Tunnel (§15).                                                                                                                                                                                                                                                                                                                                     |
  | Outbound  | VM → internet                      | TCP 443          | **To install and upgrade:** Ubuntu mirrors (`archive.ubuntu.com`, `security.ubuntu.com`), `download.docker.com`, GitHub (`github.com`) and its container registry (`ghcr.io`, `pkg-containers.githubusercontent.com`), and Docker Hub for Postgres (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`). `registry.npmjs.org` only if you build the images yourself. |
  | Outbound  | VM → NAS                           | TCP 445          | Backups (§9)                                                                                                                                                                                                                                                                                                                                                                                   |

  People's browsers, not the VM, load map tiles from `tile.openstreetmap.org`, unless you use an
  offline map image (Settings → Map & wall). If the VM can reach the internet only through a
  web proxy, read §13 before §2.

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

**Sign out and SSH back in.** Group membership only applies to new login sessions, so the
shell you ran `usermod` in still can't reach Docker. Then check that `docker` appears in your
groups:

```bash
id -nG
```

Check that Docker works **without** `sudo`:

```bash
docker run --rm hello-world
```

If this prints `permission denied while trying to connect to the docker API at
unix:///var/run/docker.sock`, this session doesn't have the group yet: sign out and back in
again. `newgrp docker` also works, for the current shell only. The rest of this guide runs
`docker` without `sudo`.

---

## 3. Get the code

The code is in the public GitHub repository
**[farmera2005/MercerAlertService](https://github.com/farmera2005/MercerAlertService)**. Clone
it over HTTPS. That needs no GitHub account, key or SSH setup, only outbound HTTPS to
`github.com`.

| What           | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Web page       | `https://github.com/farmera2005/MercerAlertService`     |
| Clone (HTTPS)  | `https://github.com/farmera2005/MercerAlertService.git` |
| Default branch | `claude/solarwinds-alert-correlation-90rlgx`            |

Create the directory, owned by your own admin account:

```bash
sudo install -d -o $USER -g $USER /opt/mercer-alert-service
```

Clone without `sudo`, so the files belong to you and `git pull` works later:

```bash
git clone https://github.com/farmera2005/MercerAlertService.git /opt/mercer-alert-service
```

Use the HTTPS address, not `git@github.com:…`. Over SSH, GitHub asks for a key it knows even
when the repository is public, and the clone fails with `Permission denied (publickey)`.

The clone checks out the default branch, which holds the current version; there are no release
tags yet. Once releases are tagged, pin production to one, for example:

```bash
cd /opt/mercer-alert-service && git checkout v1.0.0
```

The rest of this guide runs commands from `/opt/mercer-alert-service`.

### If the repository is made private again

An HTTPS clone then needs credentials. A read-only **deploy key** over SSH is the simplest way
to give the VM access. Run these as your own admin account, **without `sudo`**: root has its
own `~/.ssh` without the key.

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

Then point the existing clone at the SSH address. For a new install, clone from
`git@github.com:farmera2005/MercerAlertService.git` instead.

```bash
git -C /opt/mercer-alert-service remote set-url origin git@github.com:farmera2005/MercerAlertService.git
```

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
| `MAS_VERSION`     | `latest`    | Pin a published version, e.g. `v1.0.0` (§11).   |

[.env.example](../.env.example) lists every variable. Any **MAS setting** you put in `.env`
overrides the web UI and shows as locked there, so leave those out unless you manage the VM as
code. `.env` is in `.gitignore`: never commit it.

---

## 5. Download and start

MAS comes as ready-made images. CI builds and tests them, then publishes them at
`ghcr.io/farmera2005/mercer-alert-service-*`. The VM only downloads them: nothing is built on
it, so the install needs no npm access, build CA or build time.

```bash
docker compose pull && docker compose up -d
```

The download is about 300 MB. The `&&` matters: if the download fails, Compose stops instead of
falling back to building the images on the VM. In that case it prints `failed to copy …`,
`Forbidden` or a timeout, and suggests `docker compose build`. **Don't build.** Fix the access
instead: see the `docker compose pull` row in §14.

Then check the state:

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

MAS also calls out to the internet: Microsoft sign-in, Teams, SMS and push, and Claude. Check
that the containers can get out. A VM can have internet access while its containers don't.

```bash
docker compose exec web node -e "fetch('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAILED:',e.cause?.code||e.cause?.message||e.message))"
```

It should print `OK 200`. If it prints `FAILED: …`, see
[Containers can't reach the internet](#containers-cant-reach-the-internet).

Don't open the wizard yet if you're about to set up nginx. Doing §6 first means the wizard
already runs under the final HTTPS address.

---

## 6. HTTPS with nginx

To reach MAS from outside the office without opening ports, see §15 (Cloudflare Tunnel). It
complements HTTPS on the internal address; it doesn't replace it.

**Can this wait?** For a first trial, yes. Skip §6, open `http://netmon.mercer.local:3000` and
sign in with the local administrator. Docker publishes port 3000 itself, so no firewall rule is
needed for it (§7). Add HTTPS before go-live, for two reasons:

- **Microsoft sign-in** only accepts `https://` addresses.
- **Without HTTPS**, passwords and sign-in cookies cross the network unencrypted.

When you add it later:

- set `WEB_PORT=127.0.0.1:3000` (§4);
- run `docker compose up -d`;
- change the **Dashboard URL** to `https://…` (§8).

The certificate is the one thing to request. If IT already runs a reverse proxy or a firewall
that terminates HTTPS for internal sites, it can do this job instead of nginx. Point it at port
3000 of this VM and keep the forwarded-header settings shown below.

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

2. Update the checkout, for any changes to `docker-compose.yml` and the backup script:

   ```bash
   git pull --ff-only
   ```

3. Download the new images and restart. This also applies database migrations:

   ```bash
   docker compose pull && docker compose up -d
   ```

   If only `postgres:16-alpine` fails to download (Docker Hub) and the MAS images show
   **Pulled**, run `docker compose up -d` on its own. Postgres is already on the VM, so the
   update still applies. See §14 for why Docker Hub failed.

4. Check that everything is up:

   ```bash
   docker compose ps -a && curl -fsS http://127.0.0.1:3000/api/health
   ```

5. Reclaim the disk space used by the old images:

   ```bash
   docker image prune -f
   ```

`latest` follows the default branch. CI publishes it only after the tests and browser tests
pass, about 20 minutes after a change lands. To control when production changes, pin a version
in `.env`. Choose `v1.0.0` style tags once releases are tagged, or a `sha-xxxxxxx` tag from the
repository's **Packages** page. Then run steps 3–5:

```bash
printf 'MAS_VERSION=v1.0.0\n' >> .env
```

Migrations only move forward. To roll back, set `MAS_VERSION` back to the previous version and
restore the backup from step 1 (§12).

**Building the images yourself (optional).** This is for a VM without access to `ghcr.io`, or
to run local changes. It needs `registry.npmjs.org`, and behind a TLS-inspecting firewall also
`BUILD_CA_FILE` (§13). It takes 5–10 minutes. A later `docker compose pull` replaces the local
build with the published images.

```bash
APP_VERSION=$(git describe --always) docker compose build && docker compose up -d
```

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
2. Download the images (the same version as before, if you pinned `MAS_VERSION`):

   ```bash
   docker compose pull
   ```

   It must finish without errors before you continue (see §5 if it doesn't).

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

**Image builds** (only if you build the images yourself, §11). In `~/.docker/config.json` of
the user who runs `docker compose`, add the following. Docker passes it to every build.

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

**If the proxy or firewall inspects TLS** (it presents its own certificates), the simplest fix
needs no certificate work: ask for **this VM's address to be exempt from TLS inspection** (on a
FortiGate, a firewall policy for the VM with no SSL deep inspection). MAS only talks to the
services in §0, so exempting the VM is a narrow change.

If an exemption isn't possible, everything on the VM must trust the inspecting CA:

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

3. **For builds** (only if you build the images yourself), add
   `BUILD_CA_FILE=./secrets/corp-ca.pem` to `.env`.
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

| Symptom                                                                                                                                                   | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git clone` fails with `Permission denied (publickey)`                                                                                                    | You used the SSH address `git@github.com:…`: use the HTTPS address in §3, which needs no key. If the repository is private, §3's deploy-key steps include the checks.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docker compose` isn't found, or rejects the `required` key under `env_file`                                                                              | Compose is missing or older than 2.24. Install it from Docker's repository (§2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (older Docker: `…the Docker daemon socket`)                  | Your session isn't in the `docker` group. Run `id -nG`: if `docker` is missing, run `sudo usermod -aG docker $USER`, then sign out and SSH back in (§2).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `failed to bind host port … address already in use`                                                                                                       | Something else uses that port. For 5432 (a local Postgres), set `DB_PORT=55432` in `.env`. For 3000, set `WEB_PORT=127.0.0.1:3001` and change `proxy_pass` to match.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docker compose pull` fails with `failed to copy`, `Forbidden`, a timeout, `denied` or `manifest unknown`, and suggests `docker compose build`            | The VM can't reach GitHub's registry, or the tag doesn't exist. Allow **both** `ghcr.io` and `pkg-containers.githubusercontent.com` (layers download from the second), or use the web proxy (§13). Check `MAS_VERSION` / `MAS_REGISTRY` in `.env`. Ignore the suggestion to build.                                                                                                                                                                                                                                                                                                           |
| `docker compose pull` fails only for `postgres:16-alpine` with `auth.docker.io` … `network is unreachable` (an IPv6 address) or a timeout                 | The VM can't reach Docker Hub. Run `docker compose up -d` anyway: Postgres is already downloaded, so the MAS update applies. The IPv6 address is only the first one Docker tried: the message doesn't show the IPv4 attempt. Check IPv4 with `curl -4 -sS -o /dev/null -w '%{http_code}\n' 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull'`. `200` means Docker Hub works again: run the pull again. Anything else: allow `registry-1.docker.io`, `auth.docker.io` and `production.cloudflare.docker.com` (§0), or use the web proxy (§13). |
| The §5 check prints `FAILED: …`, or Teams, SMS or AI calls fail                                                                                           | See [Containers can't reach the internet](#containers-cant-reach-the-internet) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Building the images yourself fails at `corepack prepare pnpm…` or `pnpm install` with `Error when performing the request to https://registry.npmjs.org/…` | The same causes as below, for the npm registry. Run the build check under [Containers can't reach the internet](#containers-cant-reach-the-internet).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| No setup code in the log                                                                                                                                  | Setup is already complete (sign in instead), or `web` hasn't started: `docker compose ps -a`, `docker compose logs web`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| nginx: `socket() [::]:80 failed (97: …)`                                                                                                                  | IPv6 is disabled: remove the `listen [::]` lines (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `502 Bad Gateway` from nginx                                                                                                                              | `web` isn't running or listens elsewhere: `docker compose ps -a`, then check that `proxy_pass` matches `WEB_PORT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `413 Request Entity Too Large` when uploading a map image                                                                                                 | `client_max_body_size` is missing from the nginx site (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The audit log shows `172.x.x.x` for everyone                                                                                                              | Turn on **Behind a reverse proxy** in Settings → General (§8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The dot next to your name says **Reconnecting** all the time                                                                                              | Something between the browser and MAS buffers or cuts long requests. Use the nginx site as given; check any other proxy or load balancer in the path.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Test connection** to Orion times out                                                                                                                    | Firewall between the VM and Orion on 17774 (check with the `curl` in §1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Orion fails with a certificate error                                                                                                                      | Fetch and trust the certificate again in Settings → SolarWinds, and check **Certificate name** ([The Orion certificate](../README.md#the-orion-certificate)).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The VM's disk is filling up                                                                                                                               | `docker system df`, then `docker builder prune -f`. Check `BACKUP_KEEP_DAYS` and the retention settings in Settings → General.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Teams, SMS or AI calls fail behind a web proxy                                                                                                            | `NODE_USE_ENV_PROXY=1` and the proxy variables in `.env` (§13), plus the CA override if the proxy inspects TLS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Containers can't reach the internet

A VM can reach the internet while its containers can't: they get their own DNS settings and
network. Run the check from §5 inside MAS:

```bash
docker compose exec web node -e "fetch('https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAILED:',e.cause?.code||e.cause?.message||e.message))"
```

Compare with the VM itself:

```bash
curl -sSI -o /dev/null -w '%{http_code}\n' https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration
```

When building the images yourself, check the npm registry the same way:

```bash
docker run --rm node:24-bookworm-slim node -e "fetch('https://registry.npmjs.org/pnpm',{method:'HEAD'}).then(r=>console.log('OK',r.status)).catch(e=>console.log('FAILED:',e.cause?.code||e.cause?.message||e.message))"
```

| The check prints                                                                                                       | Cause                                                                                                                                                                        | Fix                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `FAILED: EAI_AGAIN` or `FAILED: ENOTFOUND`, and `curl` prints `200`                                                    | Containers can't resolve names. When Docker finds no usable DNS server on the VM, it gives containers Google's `8.8.8.8` / `8.8.4.4`, which corporate firewalls often block. | Give Docker your DNS servers (below).                                                                             |
| `FAILED: SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`          | A firewall or proxy inspects TLS (for example FortiGate SSL deep inspection) and presents its own certificate.                                                               | Ask for the VM to be exempt from TLS inspection (no certificates to handle), or trust the inspecting CA (§13).    |
| `FAILED: UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`, `ECONNREFUSED` or `ECONNRESET`, and `curl` fails too (or prints `000`) | The firewall doesn't let the VM reach that host.                                                                                                                             | Allow the hosts in §0, or use the web proxy (§13).                                                                |
| The same errors, but `curl` prints `200`                                                                               | Only container traffic is affected, often because the network's MTU is below 1500 and large TLS packets are dropped.                                                         | Check `ip link` for the VM's interface MTU. If it is below 1500, set Docker's MTU to that value or lower (below). |
| `OK 200`                                                                                                               | The host was briefly unreachable.                                                                                                                                            | Run the build again.                                                                                              |

**Give Docker your DNS servers.** First see which servers the VM uses:

```bash
resolvectl dns
```

Then put them in Docker's configuration file. Replace the example addresses with yours:

```bash
echo '{ "dns": ["10.20.0.10", "10.20.0.11"] }' | sudo tee /etc/docker/daemon.json
```

If `/etc/docker/daemon.json` already exists (for example with the proxy settings from §13), add
the `"dns"` entry to it instead of overwriting it. Then restart Docker:

```bash
sudo systemctl restart docker
```

Check which servers containers now get, then run the check again:

```bash
docker run --rm node:24-bookworm-slim grep nameserver /etc/resolv.conf
```

**Set Docker's MTU.** Put `"mtu"` in `/etc/docker/daemon.json` with the VM's MTU, for example
`{ "mtu": 1400 }` (merge it with any existing entries), then restart Docker:

```bash
sudo systemctl restart docker
```

Both settings apply to the running MAS containers and to build containers.

---

## 15. Remote access with Cloudflare Zero Trust (optional)

A Cloudflare Tunnel makes MAS reachable at a public hostname, such as
`netmon.mercerlandmark.com`, without opening any inbound port.

- **The connector.** MAS's worker runs Cloudflare's connector (`cloudflared`). It is included in
  the worker image, so nothing needs installing.
- **Who gets in.** Cloudflare Access decides who may reach the hostname. People then sign in to
  MAS as usual (Microsoft or local accounts), and admin rights still come from the Entra admin
  group.

**1. Create the tunnel.** In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels →
Create a tunnel**, choose **Cloudflared** and name it, for example `mas`. The next page shows
install commands. Copy the **token**: the long string after `--token` in any of them. Don't run
the commands; MAS runs the connector.

**2. Add the public hostname.** On the tunnel's **Public hostname** tab (or **Published
application routes**), add:

| Field            | Value                                         |
| ---------------- | --------------------------------------------- |
| Hostname         | `netmon` . `mercerlandmark.com`               |
| Service          | `HTTP` → `web:3000`                           |
| HTTP Host Header | leave empty (MAS needs the original hostname) |

`web:3000` is the web container's address inside the Docker network, where the connector runs.

**3. Protect it with Cloudflare Access.** Do this before step 4. Without an Access application,
anyone on the internet can reach the MAS sign-in page.

1. Open **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Enter the same hostname.
3. Add a policy that allows your IT team, for example your Entra ID group, with Entra ID as the
   login method.

Wall screens on the office network keep using the internal address. A screen that has to use the
tunnel needs a second Access application for `netmon.mercerlandmark.com/wall`, with a **Bypass**
policy limited to that screen's public IP range. The wall link's own token and address range
still apply.

**4. Turn it on in MAS.** Open **Settings → General → Remote access (Cloudflare Tunnel)**. Tick
**Run the Cloudflare Tunnel connector**, paste the token and click **Save settings**. Within a
few seconds the box above the form shows **Connected to Cloudflare**, and the tunnel shows
_Healthy_ in the Cloudflare dashboard. The token is stored encrypted and never shown again.

**5. Use the public address.**

- **Links.** Set **Settings → General → Dashboard URL** to `https://netmon.mercerlandmark.com`,
  so links in Teams and SMS work from anywhere.
- **Microsoft sign-in.** Add
  `https://netmon.mercerlandmark.com/api/auth/callback/microsoft-entra-id` to the app
  registration's redirect URIs (Entra admin center → App registrations → MAS → Authentication).

**Network.** The VM needs outbound **TCP and UDP 7844** to Cloudflare
(`region1.v2.argotunnel.com` and `region2.v2.argotunnel.com`). Cloudflare's _Tunnel with
firewall_ page has the full list. The connector talks to Cloudflare directly, not through the web
proxy of §13.

**Client addresses.** Through the tunnel, MAS takes the visitor's address from Cloudflare's
`CF-Connecting-IP` header for audit rows and wall address ranges. It does this only on
connections that come from its own connector. Leave **Behind a reverse proxy** off for the
tunnel; it is only for nginx or IIS in front of MAS.

**If it doesn't connect,** the box in Settings → General shows the connector's last error. The
full log is here:

```bash
docker compose logs worker | grep cloudflared
```

**Turning it off.** Untick the setting and save; the connector stops. To revoke the token, delete
the tunnel in Cloudflare.
