# MercerAlertService

An internal tool for Mercer Landmark IT that sits on top of SolarWinds Orion/NPM. Orion
keeps polling the devices. MercerAlertService (MAS) does the following:

1. Reads alerts, status and topology over the **SWIS REST API**.
2. Turns raw alert storms into a few prioritized **incidents**. Correlation is
   deterministic. Claude only adds enrichment.
3. Posts incidents to **Microsoft Teams**, and pages on-call by **SMS or Pushover** for urgent ones.
4. Serves a live **dashboard** and a **NOC wall display**.

**Installing on Ubuntu:** [step-by-step guide](docs/install-ubuntu.md) (Docker, HTTPS with nginx,
firewall, NAS backups, upgrades, recovery).

Design docs: [architecture](docs/architecture.md) · [database schema](docs/schema.md) ·
[SWQL queries](docs/swql-queries.md) · [open questions](docs/open-questions.md) ·
[project conventions](CLAUDE.md)

## Status

| Milestone        | Scope                                                                                                                              | State    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. Foundation    | Repo, Docker Compose, schema and migrations, SWIS client, discovery and recorder scripts, mock SWIS, polling into Postgres, health | **Done** |
| 1b. Online setup | Browser setup wizard and Settings: no config files, encrypted secrets, live reload                                                 | **Done** |
| 2. Correlation   | Dedupe, topology suppression, flap detection, incident lifecycle, priority scoring, seasons, maintenance, simulator                | **Done** |
| 3. Dashboard v1  | Entra SSO, overview, incidents, site and node pages, SSE, wall display                                                             | **Done** |
| 4. Notifications | Teams cards, Twilio/Pushover, on-call and escalation, shadow mode                                                                  | **Done** |
| 5. AI            | Summaries, severity suggestion with guardrails, digests, budget, fallbacks                                                         | **Done** |
| 6. Polish        | Ask the network, trends, admin, hardening                                                                                          | **Done** |

---

## Install on the Linux VM (no config files)

This is the short version. For a production VM, follow the
**[Ubuntu install guide](docs/install-ubuntu.md)**. It also covers installing Docker, HTTPS
through nginx with the internal certificate (needed for Microsoft sign-in), the firewall, a web
proxy, backups to a NAS, upgrades and disaster recovery.

Requirements:

- Docker Engine with the Compose plugin v2.24 or newer.
- Outbound TCP **17774** to the Orion server.
- Outbound HTTPS to the hosts listed in [architecture §11](docs/architecture.md#11-security--operations):
  `login.microsoftonline.com` for Microsoft sign-in, `tile.openstreetmap.org` for the map
  (unless you use an offline map image), `nominatim.openstreetmap.org` to place sites from their
  address, the Teams Workflows host (`*.environment.api.powerplatform.com`), `api.pushover.net` and `api.twilio.com` for notifications, and
  `api.anthropic.com` for AI summaries and digests (optional).

The code is in the public repository
[farmera2005/MercerAlertService](https://github.com/farmera2005/MercerAlertService). Clone it
over HTTPS, as your own account rather than with `sudo`; no GitHub account or key is needed.

```bash
sudo install -d -o $USER -g $USER /opt/mercer-alert-service
git clone https://github.com/farmera2005/MercerAlertService.git /opt/mercer-alert-service && cd /opt/mercer-alert-service
docker compose pull && docker compose up -d
docker compose logs web | grep -i "setup code"
```

Then open `http://<vm>:3000` in a browser. The **setup wizard** asks for:

1. **The setup code and an administrator account.** The one-time code only appears in the
   server log, so someone who can merely reach port 3000 can't claim the installation. The
   account is a local break-glass admin; the IT team signs in with Microsoft once Entra ID is
   set up (below).
2. **SolarWinds.** Enter the Orion server, the read-only account and its password. Click
   **Fetch certificate** and compare the thumbprint with the one on the Orion server. Click
   **Trust this certificate**, then **Test connection**, then **Save connection**.
3. **Mapping.** Click **Run discovery**. The dropdowns then list your real Orion custom
   properties. Pick the ones for site, division and city. The page also shows how each Site
   value maps to a site profile.
4. **Sites.** Resolve each Orion site value that has no profile: create a new site, or mark
   it as another name for an existing one. Then set each site's tier, the harvest-critical
   flag and coordinates.
5. **General.** Time zone, dashboard URL, poll intervals and retention. The defaults are fine.
6. **Finish.** A checklist confirms the worker, the connection, discovery and sites. Click
   **Start monitoring** and polling begins within seconds.

### Using the dashboard

Everything updates by itself (Server-Sent Events); the dot next to your name says **Live**.

- **Overview:** open incidents by priority, the **noise-reduction ratio** (raw Orion alerts per
  incident), SolarWinds status and poll ages, every site as a green / amber / red tile grouped
  by division (the reason is under each tile), and the map. A site can have several divisions,
  such as a grain elevator with an agronomy center (Settings → Sites). It then appears under
  each one, and its incidents follow the routing rules and seasons of all of them.
- **Incidents:** filter by status, time, priority, division, site and kind, or search a title
  or `INC-123`. Each incident shows its summary, the alerts it grouped, a timeline merging
  Orion and MAS, why it has its priority, its recovery target, and buttons to **Acknowledge**,
  **Snooze**, **Resolve** and add **notes**. Every action is in Settings → Audit log.
- **Sites** and **devices:** Site Profile, devices (scale systems, servers and UPSes listed
  separately), problem interfaces, and response time / loss / CPU / memory / utilisation
  charts over 24 hours, 7 or 30 days.
- **Trends:** over 24 hours, 7 or 30 days: raw Orion alerts and the incidents they became,
  the noise ratio, **flapping devices**, **top talkers** (busiest interfaces by peak
  utilisation), and **recurring problems** (the same kind of incident at the same place, again
  and again). Each chart has a **Show table** button.
- **Digests:** the archive of morning digests and Monday trend reports (with AI on).
- **Ask:** questions about the network in plain English (with AI on; see below).
- A red **DATA STALE** bar appears if the worker stops reporting or SolarWinds has not been
  polled successfully for a while.

**Settings** (admins) opens on an **Overview** checklist: what is configured, what is missing,
and a link to each. The tabs cover SolarWinds, mapping, sites, **Devices**, correlation and
priority (with live examples), the **season calendar** (harvest Sept 1 – Dec 15, plus optional
wheat-harvest and spring application periods), **maintenance windows** (one-off or weekly),
notifications, routing, on-call, AI, digests, **Sign-in**, **Map & wall**, General and the
**Audit log**.

**Settings → Devices** lists the nodes MAS could not place at a site (no or unknown Site
custom property) and counts those that got the role _other_. Pin a node to a site and/or role
there, with a reason. The override wins over Orion's custom properties from the next node poll
on, and can be cleared at any time.

### Microsoft sign-in (Entra ID)

Settings → **Sign-in** shows the exact redirect URI and walks through the registration:

1. In the Entra admin center, **App registrations → New registration**: single tenant, platform
   **Web**, redirect URI `https://<dashboard address>/api/auth/callback/microsoft-entra-id`
   (set the dashboard address in Settings → General first).
2. **Certificates & secrets → New client secret**; note its expiry date.
3. **Token configuration → Add groups claim**: security groups, _Group ID_ in the ID token.
   Under Enterprise applications → the app, set **Assignment required** to Yes and assign the
   IT group (and an admin group). This keeps the group list small (no "group overage").
4. Paste the tenant ID, client ID, secret value and the group Object IDs into Settings →
   Sign-in. The sign-in page then offers **Sign in with Microsoft**.

Members of the allowed group can view everything and acknowledge, snooze, resolve and add
notes. Settings is limited to the admin group (or the addresses in "Admin e-mail addresses").
The local administrator from setup keeps working under "Local administrator sign-in".

Settings → Sign-in also manages **local administrator accounts**: add a second break-glass
account, reset a password (which signs that account out everywhere), or disable one. MAS
refuses to disable the last active local account.

**Two-step sign-in for local accounts.** After the password, a local account can confirm with an
authenticator app (Microsoft Authenticator, Google Authenticator, 1Password …) or a passkey
(Windows Hello, Touch ID, a phone, a YubiKey). Each person sets it up by clicking their name at
the top right (**Account security**), and gets ten one-time recovery codes with the first one.

- **Require it** for every local account under Settings → Sign-in → _Two-step sign-in_. An
  account without one then sets it up at its next sign-in, before it can do anything else, and
  can't remove its last authenticator or passkey.
- **Lost phone or key:** use a recovery code, or have another admin click **Reset two-step
  sign-in** next to the account. If nobody can sign in, run this on the VM:
  `docker compose exec worker node dist/account.js reset-2fa <username>`.
- **Passkeys** are tied to the address they were made on (the internal name or the Cloudflare
  hostname) and need that name over HTTPS, not an IP address. The authenticator app works on any
  address.
- **Microsoft sign-ins** get their MFA from Entra ID: require it for the MAS app with a
  Conditional Access policy (or security defaults).

### NOC wall display

Settings → **Map & wall → New wall link** creates a link like `https://<dashboard>/wall/<token>`
for one screen, shown once. Open it in the TV's browser in kiosk / full-screen mode: no
sign-in. Optionally limit it to the screen's address range (the page shows your address as
MAS sees it), give it an expiry, and **Rotate** or **Revoke** it at any time. The wall rotates
between open incidents, the sites and the map with large text, and never shows buttons, links
or IP addresses. Under **What it shows**, a link can show NOC boards instead (below).

### NOC dashboard

**NOC** in the menu shows the NOC boards: several panels on one screen, updating live. Four are
built in:

| Board               | What it shows                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission control** | Status bar (clock, SolarWinds feed, harvest, who is on call), P1–P4 counts, open incidents with age, acknowledgement and time left to the recovery target, the map, health per division, key figures and recent activity. |
| **Site matrix**     | Every site as a tile, grouped by division. Problem sites show why, with a marker per kind of device (FW, SW, AP, SCALE, UPS, …).                                                                                          |
| **WAN & circuits**  | One row per site, worst first: firewall state, latency and packet loss with 24-hour sparklines, and WAN in/out utilization (90 % and up is flagged).                                                                      |
| **Shift overview**  | The last 24 hours: noise reduction, incidents opened and resolved, median time to acknowledge and to fix, alerts and incidents per hour, flapping devices, busiest interfaces, pages sent.                                |

- **Your own boards.** Settings → **NOC boards** composes boards from the same widgets. Start
  from a built-in board or a blank one, drag widgets on the 12 × 8 grid, and limit the board to
  divisions, harvest-critical sites or chosen sites (a Grain harvest board, for example).
- **On a TV.** Settings → Map & wall → a wall link → **What it shows** → **NOC boards**. Tick
  one or more boards and the seconds per board. While a P1 is open, the screen stays on a board
  with the incident list. TV boards use large text and show no links, device names or addresses.
- **On a desktop,** incidents, sites and devices on the boards are links, and **Full screen**
  fills a monitor.
- **WAN links** are the firewall interfaces named like `wan`, `internet`, `isp`, `mpls` or `lte`
  (Settings → Map & wall → Advanced, _WAN interface names_). When none matches, the busiest
  interface is used.

### Remote access (Cloudflare Zero Trust)

To reach MAS from outside the office without opening a port, create a Cloudflare Tunnel whose
public hostname points at `web:3000`. Protect the hostname with a Cloudflare Access application,
then paste the tunnel's token in **Settings → General → Remote access**. The worker runs
Cloudflare's connector (`cloudflared`, included in the image) and shows whether it is connected.
People still sign in to MAS as usual. The steps are in
[install guide §15](docs/install-ubuntu.md#15-remote-access-with-cloudflare-zero-trust-optional).

### The map

The overview and wall map is a live OpenStreetMap map: no image to prepare, no key. To put a site
on it, type its **Address** in Settings → Sites and save. The worker looks the address up with
OpenStreetMap's Nominatim, one address per second as OpenStreetMap asks. Saving shows the place
it matched, and the site appears on the map. If a site has no address, its city is used.

- **Typed coordinates win.** Type the latitude and longitude yourself if the lookup picks the
  wrong place. To look the address up again, clear them and save.
- **Existing sites.** **Place N sites on the map** (Settings → Sites) looks up every site that has
  an address or city but no coordinates. Sites not yet on the map show _not on map_.
- **Settings.** Settings → Map & wall can turn the lookup off. Its Advanced section can point it
  at your own Nominatim or another country.

For browsers without internet access, upload a map image under **Offline map image**, switch the
map background to _Offline image_, and give each site a Map X/Y (pixels) in Settings → Sites.

If MAS sits behind a reverse proxy (nginx, IIS), turn on **Behind a reverse proxy** in Settings
→ General so audit rows and wall IP limits see real client addresses.

Everything can be changed later under **Settings**. Changes reach the worker within a
second, with no restart.

### What happens behind the scenes

| Service     | What it does                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`      | One-shot. Generates the database password, the database URL and the **master key** into the `bootstrap` volume. Existing files are never overwritten.                                 |
| `db`        | PostgreSQL 16. Data is in the `pgdata` volume.                                                                                                                                        |
| `migrate`   | One-shot. Applies migrations and seeds placeholder sites on a brand-new database.                                                                                                     |
| `worker`    | Waits in "awaiting setup" until the wizard is finished, then polls SWIS. It also runs the wizard's connection test, certificate fetch and discovery. Health check at `:9090/healthz`. |
| `web`       | The wizard, Settings, status page and API on `WEB_PORT` (default 3000). Put your reverse proxy with the internal TLS certificate in front of it.                                      |
| `backup`    | Nightly `pg_dump` to `./backups`.                                                                                                                                                     |
| `mock-swis` | Only with `--profile dev`: a fake Orion for trying things out.                                                                                                                        |

- **Where settings live.** Settings entered in the web UI are stored in Postgres. Passwords
  and other secrets are **encrypted** (AES-256-GCM) with the master key from the `bootstrap`
  volume. Secrets are never sent back to the browser, and every change is written to the
  audit log with secrets redacted.
- **Optional `.env` override.** Anything set in a `.env` file or the environment wins over
  the web UI, and the UI shows that field as locked. This suits infrastructure-as-code;
  [.env.example](.env.example) lists every variable. Docker secrets work too, as
  `X_FILE=/run/secrets/x`.
- **Testing first.** To try MAS without Orion, run `docker compose --profile dev up -d`. In
  the wizard, expand _Advanced_, set the base URL to `http://mock-swis:17774`, and use user
  `mas` / password `mas`.
- **Ready-made images.** CI builds and tests the images, then publishes them to
  `ghcr.io/farmera2005/mercer-alert-service-*`, so the VM only downloads them. `MAS_VERSION`
  in `.env` pins a version. To build from the checkout instead (for local changes, or without
  access to `ghcr.io`), run `docker compose build`. Behind a TLS-inspecting proxy, building
  also needs `BUILD_CA_FILE=./secrets/corp-ca.pem`. That file must be inside the project
  directory, and it is only used during the build.

### Create the read-only Orion account (in Orion)

This is the one step done outside MAS. Use a dedicated account, so its access can be audited
and revoked. Menu names differ slightly between Orion versions.

1. In the Orion Web Console, open **Settings → All Settings → User Accounts → Manage
   Accounts → Add New Account**.
2. Choose **Orion individual account**. You can also use a Windows/AD service account; enter
   it as `DOMAIN\user` in the wizard. Name it, for example, `svc-mas-ro`, and give it a long
   random password that does not expire.
3. Set administrator, node management, alert management and view customization rights all to
   **No**. **Do not add account limitations.** MAS needs to see every node, or correlation
   will have gaps.

**Write-back (optional, off by default).** MAS can write three things back to Orion:

- acknowledge alerts when an incident is acknowledged in MAS;
- add incident notes to the alerts;
- save site notes to the site's SolarWinds group.

For this, create a **second** account with the same settings, except _Allow alert management
rights_ = **Yes**, and, for site notes, _Allow node management rights_ = **Yes** (groups are
edited under node management). Then enter it on the SolarWinds page under _Orion write-back_.

### The Orion certificate

SWIS normally presents Orion's self-signed certificate, and MAS **verifies TLS by default**.
The wizard's **Fetch certificate** button shows the certificate the server presents, without
sending any credentials. It shows the subject, the validity dates and both thumbprints.

On the Orion server, run `certlm.msc` → Personal → Certificates and open the certificate.
Compare its _Thumbprint_ (SHA-1) on the Details tab. Only trust it if they match. If the
name on the certificate isn't the server name (self-signed Orion certificates usually say
`SolarWinds-Orion`), the wizard fills in _Certificate name_ for you. If an internal CA
issued Orion's certificate, the wizard recommends trusting that CA's certificate instead.

_Skip certificate verification_ exists for development only. When it is on, an error is
logged every 10 minutes and the finish checklist flags it.

### Command-line discovery (optional)

The wizard's discovery covers this. For a full text report, including the alert definitions
list:

```bash
docker compose run --rm --no-deps -e SWIS_HOST=orion.mercer.local -e SWIS_USERNAME=svc-mas-ro \
  -e SWIS_PASSWORD='…' worker node dist/discover.js --check-queries
```

### Notifications: Teams, SMS and push

MAS starts in **shadow mode**: every message goes to one Teams channel (`#mas-shadow`) marked
[SHADOW], saying where it would have gone and who would have been paged, and nobody is paged.
Run it next to the existing SolarWinds e-mails for 2–4 weeks, then turn shadow mode off in
Settings → Notifications.

1. **Teams.** Create one webhook per channel: `net-critical` (P1–P2), `net-alerts` (P3–P4) and
   `mas-shadow`. Do it in the Teams app with **Workflows**, about two minutes each:
   1. Point at the channel's name (a _standard_ channel: workflows can't post to private ones)
      and select **⋯ More options → Workflows**. Without that entry, open the **Workflows** app
      from the apps bar and choose **Create**.
   2. Pick the template **Send webhook alerts to a channel**, name it (e.g. "MAS net-critical"),
      check that the Teams connection has a green tick, and select **Next**.
   3. Choose the team and channel, then **Add workflow** (or **Save**).
   4. Copy the URL it shows (`https://…environment.api.powerplatform.com/powerautomate/…`).
      Paste it in Settings → Notifications → the channel → Edit, save, and click **Send test**.
      The URL is stored encrypted and never shown again.

   Keep the workflow's **Who can trigger the flow?** set to **Anyone**: MAS can't sign in to
   Microsoft, so anything else fails with HTTP 401. A workflow stops when its creator's account
   is disabled: use a shared IT account, or add a second owner in Power Automate. URLs on
   `logic.azure.com` stopped working after 30 November 2025. To copy a current one, open the
   Workflows app → the workflow → **Edit** → expand the first step. Settings → Notifications has
   the same steps, and a failed **Send test** says what to fix.

2. **Pushover** (recommended for the pilot): create an application at pushover.net, paste its
   API token in Settings → Notifications → Pushover, and give each person their user key in
   Settings → On-call.
3. **Twilio SMS** (optional): US application SMS needs **A2P 10DLC registration or a verified
   toll-free number**, which can take days to weeks, so start early. Enter the Account SID,
   auth token and sender number (or Messaging Service SID), and each person's mobile number.
4. **On-call:** replace the placeholder people in Settings → On-call, set the rotation order
   and the IT lead, and use **Test SMS / Test Pushover** on each person.
5. **Routing:** the defaults post P1–P2 to `#net-critical`, P3–P4 to `#net-alerts`, page the
   on-call person for every P1 and for P2 after business hours, and escalate to the next
   person after 15 minutes, then to the IT lead. Change them in Settings → Routing; the page
   shows what the rules would do with the incidents open right now.

Every message, including the ones deliberately not sent (maintenance, quiet hours, shadow mode,
no number on file…), is listed on the incident page. A channel or provider that keeps failing
shows a red banner on every page and a self-alert in another channel.

### AI summaries and digests (Claude, optional)

Everything works without AI: incidents, priorities and notifications come from deterministic
code and templates. With an Anthropic API key, Claude adds the following:

- **A plain-English title and summary** for each incident: what is affected for the business,
  the likely cause with a confidence level, first troubleshooting steps for our equipment, and
  what changed since the last summary. The first summary is posted to Teams as one follow-up
  card under the original alert. It never pages anyone.
- **A second opinion on priority.** It may move an incident one level up or down, but code
  stops it from lowering a site outage, a firewall down, or a harvest-critical site in harvest
  below P2. The reason is shown on the incident. Set it to "show only" if you prefer.
- **A morning digest** (07:00) and a **Monday trends report** in `#net-digest`, also kept under
  **Digests**. Trends cover repeat offenders, sites getting worse, links running hot, and Orion
  alert rules that look misconfigured.

Set it up in **Settings → AI**: paste the key (console.anthropic.com → API keys), press **Test
the connection**, and optionally describe your network in "Notes about our network" (circuits,
backup links, scale systems). Before anything is sent, IP addresses, MAC addresses and serial
numbers are replaced with placeholders such as `[IP-1]`; hostnames and site names are sent.

Costs are controlled in three ways:

- One summary per incident change, not one per alert: a 30-alert storm costs one or two.
- The shared part of every prompt is cached.
- A **daily budget** (US$5 by default). At 80 % a banner and a Teams notice appear; at 100 % MAS
  uses templates until midnight.

Settings → AI lists every call with its tokens, time and estimated cost. If the API is slow or
down, nothing waits for it: the template stays and the summary is added when Claude answers.

Digests use `#net-digest`: give that channel a Teams webhook in Settings → Notifications. Change
the times or send one now in **Settings → Digests**.

### Ask the network

**Ask** in the menu is a chat about the network, for example "What's wrong at Rockford right
now?", "Which devices flapped most this week?", or "Is the Celina WAN link running hot?".
Claude answers from MAS's own database through a fixed set of read-only lookups:

- current status;
- incident search and incident details;
- sites and their devices;
- device history;
- interface utilisation;
- flapping devices.

It cannot run SQL, cannot reach SolarWinds or any device, and cannot change anything. You see
each lookup as it happens, and the answer streams in.

Every answer cites what it relied on, such as **INC-42**, **NODE-1234** or **SITE-ROCKFORD**.
Each citation is a link, and the sources are listed under the answer. A citation that the
lookups did not actually return is shown in amber as _unverified_.

- **Privacy.** Conversations are private to the person who asked and are deleted after 90
  days without activity (`RETENTION_CHAT_DAYS`). Addresses are redacted before anything is
  sent, as for summaries.
- **Limits.** Questions count against the daily AI budget. Each person can ask 30 questions
  an hour (`AI_CHAT_PER_HOUR`).
- **Turning it off.** Use the switch in Settings → AI.

### Orion write-back (optional)

With a second, write-capable Orion account (see above), turn on write-back in Settings →
SolarWinds and enter that account. MAS then writes back three things:

- **Acknowledge** in MAS also acknowledges the incident's alerts in Orion.
- **Incident notes** are appended to those alerts (`AppendNote`), signed with the person's
  name and the incident number.
- **Site notes**, for sites that come from SolarWinds groups (below), are saved to the group's
  description. If someone changed it in SolarWinds in the meantime, MAS doesn't overwrite it;
  it shows the current text and asks you to make the change again.

Every write appears on the incident timeline or next to the site notes, and in the audit log.

### Sites from SolarWinds groups

If each site is a group in SolarWinds, MAS finds those groups by itself. Nothing needs to be set
up. A group counts as a site when most of its devices share a location and it holds several kinds
of device or is named after a site. A location can be the same Site property, Location field,
hostname prefix or subnet, or a hostname that matches the group's name. Small groups may have one
device that doesn't match, such as a firewall with a WAN address. That
rules out groups like "All FortiGates" (devices at every site), "Critical servers" (one kind of
device), regions that contain several site groups, and groups inside a site group (such as
"Rockford Scales").

- **One site per group.** Each site group becomes a site, named after the group ("Site -
  Rockford" → "Rockford"). An existing site is matched by name or other name; otherwise one is
  created. When a group is renamed, the site follows and keeps its old name as an other name.
- **Devices** belong to the site whose group contains them, including through nested groups.
  Custom properties and hostname prefixes are only the fallback.
- **Notes.** The group's **description** is the site's notes. They show on the site page, and
  can be edited in Settings → Sites when write-back is on.
- **Stable.** Groups are re-read every 5 minutes (`SWIS_POLL_GROUPS_SEC`). Once a group is a
  site, it stays one while it exists, so devices don't move back and forth.

Settings → Mapping → **Sites from SolarWinds groups** lists what MAS found, why, and why the other
groups are not sites. To correct a single group, use its button:

- **Use as a site** (under "Groups that are not sites") makes that group a site.
- **Not a site** stops using a group that was found.
- **Undo** returns the group to the automatic choice.

Each choice is kept, audited and applied within seconds. If most of the choices are wrong, open
**Choose the groups yourself**. There you can name the group that holds the site groups, or give a
name pattern such as `^Site - (.+)$`; either one replaces the automatic choice. The per-group
choices still apply. Unchecking **Find the site groups automatically** stops using groups
altogether.

---

## Local development

Prerequisites: Node ≥ 22.19 (24 LTS recommended), pnpm 10 (`corepack enable`), and Docker.
Outside production, `DATABASE_URL` defaults to `postgres://mas:mas@localhost:5432/mas`, which
is the database `pnpm dev:db` starts. Secrets are encrypted with a key that is created
automatically in `~/.mas/master.key`.

```bash
pnpm install
pnpm dev:db                      # Postgres 16 in Docker on 127.0.0.1:5432
pnpm db:migrate && pnpm db:seed
pnpm dev:mock-swis               # fake Orion on :17774 (about 80 nodes across 13 placeholder sites)
pnpm dev:worker                  # waits for setup, then polls
pnpm dev:web                     # http://localhost:3000 → setup wizard (code is in this terminal)
```

In the wizard, set the base URL to `http://127.0.0.1:17774` with user `mas` / password `mas`.
To try the AI features without an Anthropic key, enter any key in Settings → AI and set
**API base URL** (under Advanced) to `http://127.0.0.1:17774/__mock/anthropic`. The mock answers
like Claude would, with canned text. **Ask** works against the mock as well: it calls the real
lookups, then answers by citing the first incident, device or site they returned.

### Simulating problems with the mock

The mock has a control API (dev only) for replaying synthetic storms:

```bash
curl -s localhost:17774/__mock/state
curl -s -XPOST localhost:17774/__mock/scenario -H 'content-type: application/json' \
  -d '{"name":"site-wan-down","params":{"site":"ROCK","childAlerts":30,"recoverAfterSec":600}}'
curl -s -XPOST localhost:17774/__mock/scenario -H 'content-type: application/json' \
  -d '{"name":"flapping-ap","params":{"node":"ROCK-AP01","flaps":6,"periodSec":60}}'
curl -s -XPOST localhost:17774/__mock/scenario -H 'content-type: application/json' \
  -d '{"name":"ups-on-battery","params":{"site":"COLD"}}'
curl -s -XPOST localhost:17774/__mock/scenario -H 'content-type: application/json' \
  -d '{"name":"interface-saturation","params":{"node":"CEL-FW01","iface":"wan1","durationSec":1800}}'
curl -s -XPOST localhost:17774/__mock/outage -H 'content-type: application/json' -d '{"mode":"503"}'   # or timeout|auth|none
curl -s -XPOST localhost:17774/__mock/reset
```

Add `"immediate": true` to apply every step at once. Start the mock with `--speed 10` to run
scenarios ten times faster. Use `--drop-field Orion.Nodes.PercentMemoryUsed` to imitate an
older Orion version.

---

## Operations

### Health

- `GET /api/health` (web): **readiness**. Returns 503 when the DB is down or the worker
  heartbeat is older than `HEALTH_WORKER_STALE_SEC`. A body with `"status":"degraded"`
  means SolarWinds itself is unavailable. We recommend an **Orion SAM HTTP monitor** on
  this URL, so SolarWinds watches the watcher.
- `GET /api/health?liveness`: the web container's own healthcheck (process and DB only).
- `GET :9090/healthz` (worker, inside the Docker network): the worker container's healthcheck.
- Optionally set `DEADMAN_PING_URL` to an external dead-man's-switch service. The worker
  pings it on every heartbeat.

If SWIS stops answering, the circuit breaker opens after `SWIS_BREAKER_THRESHOLD`
consecutive failures, or no alert poll succeeds for `SWIS_STALE_AFTER_SEC`. Either way the
worker records a **source down** transition, and this raises a P1 "Monitoring source down"
incident.

**MAS alerts on itself.** Every minute the worker checks itself. For each problem it posts a
self-alert to Teams, at most hourly, in a channel other than the one failing. It checks for:

- a notification channel or provider that keeps failing;
- messages stuck in the outbox;
- a correlation backlog;
- a SolarWinds poller that keeps failing while the others work.

Failing channels and pollers also show a banner on every page. A dead worker can't report
itself, but `/api/health` returns 503 for it, so the Orion HTTP monitor above (or
`DEADMAN_PING_URL`) catches that case.

### Logs

Logs are structured JSON (pino). See [Day-to-day commands](docs/install-ubuntu.md#10-day-to-day-commands)
for a readable view with `jq`. Secrets and authorization headers are redacted.

### Backups and restore

The `backup` sidecar runs `pg_dump -Fc` daily at `BACKUP_TIME` (local time) into
`BACKUP_HOST_DIR` (default `./backups`) and keeps `BACKUP_KEEP_DAYS` days of dumps. Copy
that directory off the VM, for example to a NAS (open question D6).

Take an immediate backup:

```bash
docker compose exec backup /backup.sh now
```

To restore, stop the writers, recreate the database, restore into it, and start again. `up -d`
also applies migrations if the dump is from an older version. Don't restore over the live
database with `--clean`: the job queue's partitioned tables make that fail.

```bash
docker compose stop worker web
```

```bash
docker compose exec -T db dropdb -U mas --force mas && docker compose exec -T db createdb -U mas mas
```

```bash
docker compose exec -T db pg_restore -U mas -d mas --no-owner --exit-on-error < backups/mas-YYYYMMDDTHHMMSSZ.dump
```

```bash
docker compose up -d
```

**Also keep a copy of the master key.** Secrets saved in the web UI (the Orion password,
webhook URLs and API keys) are encrypted with it. A database dump alone is useless
for them without it, which is deliberate, so store the key somewhere separate from the dumps.

```bash
docker compose run --rm --no-deps -T --entrypoint cat worker /bootstrap/master_key > mas-master-key.txt
```

To restore onto a new VM, put the key back **before** the first `docker compose up`. If you
don't, re-enter the passwords in Settings after the restore.

```bash
docker compose run --rm --no-deps -T --user root --entrypoint sh init \
  -c 'cat > /bootstrap/master_key && chown 1000:1000 /bootstrap/master_key && chmod 400 /bootstrap/master_key' < mas-master-key.txt
```

If you prefer host cron over the sidecar:

```
30 2 * * * cd /opt/mercer-alert-service && docker compose exec -T db pg_dump -U mas -Fc mas > backups/mas-$(date -u +\%Y\%m\%dT\%H\%M\%SZ).dump
```

### Retention

A nightly job (`RETENTION_CRON`, in ET) purges:

- Raw transitions, metric rollups, Orion events and alert history after `RETENTION_RAW_DAYS` (90)
- Poll runs after 30 days
- Incidents (with their notifications), digests and AI call logs after `RETENTION_INCIDENT_DAYS` (2 years)
- "Ask the network" conversations after `RETENTION_CHAT_DAYS` (90) without activity
- The audit log after 2 years

All of these can be changed in Settings → General.

### Security

- **Read-only towards the network.** MAS never polls or logs in to devices. Everything comes
  from SWIS, with a read-only Orion account. Write-back (acknowledging in Orion) is optional and
  uses a separate account.
- **TLS to Orion is verified.** The development-only skip flag logs an error every 10 minutes
  and shows a red banner on every page.
- **Secrets** are sealed with AES-256-GCM in the database. The master key lives in the
  `bootstrap` volume. Secrets are never sent to the browser, never logged, and redacted in the
  audit log.
- **Every action is audited** in the same database transaction as the change. This covers
  acknowledgements, notes, every setting, wall links, overrides, local accounts and chat
  questions.
- **Sign-in.** People sign in with Entra ID and group checks. Local accounts are for
  break-glass only: passwords are hashed with scrypt, failed sign-ins are rate-limited, and a password
  change revokes the account's sessions. Local accounts can add two-step sign-in (authenticator
  app or passkey, with recovery codes), and Settings can require it. Wall links are single-screen tokens, stored only as a
  hash, with an optional address range and expiry.
- **Browser hardening.** Every response carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and a restrictive
  `Permissions-Policy`. In production, a Content-Security-Policy keeps scripts, styles and
  connections on the app's own origin and forbids framing. Images may come from any host,
  because the map tile server is configurable. Map tiles send the dashboard's origin (no path)
  as `Referer`, which OpenStreetMap's tile policy requires. Put TLS (and HSTS) on your reverse
  proxy.
- **Containers** run as the unprivileged `node` user with all Linux capabilities dropped and
  `no-new-privileges`. Only the web port is published; the database listens on localhost.
- **AI.** Claude only adds text and suggestions. IP addresses, MAC addresses and serial numbers
  are replaced before anything is sent. The chat has read-only lookups and no SQL.

### Upgrades

```bash
cd /opt/mercer-alert-service
docker compose exec backup /backup.sh now
git pull --ff-only
docker compose pull && docker compose up -d
docker compose ps && curl -fsS localhost:3000/api/health
```

Migrations run automatically through the `migrate` service before `worker` and `web` start.
Migrations only move forward. To roll back, check out the previous version and restore the
backup you took before the upgrade. The [install guide](docs/install-ubuntu.md#11-upgrades)
covers upgrading to a tag and reclaiming disk space afterwards.

---

## Development reference

```bash
pnpm lint && pnpm typecheck && pnpm test      # unit tests (no DB)
DATABASE_URL_TEST=postgres://mas:mas@localhost:5432/mas_test pnpm test:integration   # includes the storm scenarios
SIMULATOR_DATABASE_URL=postgres://mas:mas@localhost:5432/mas_sim pnpm simulate     # readable report; wipes that DB
pnpm simulate wan-down-harvest flapping-ap                                          # selected scenarios
pnpm db:generate     # after editing packages/db/src/schema/*; commit the generated SQL
pnpm swis:record --rows 200 --hash-hostnames  # capture sanitized real fixtures
pnpm dev:mock-swis -- --replay fixtures/swis/recorded
# End-to-end (browser) tests against a FRESH stack: setup wizard, overview (live update),
# incident acknowledgement, the wall, notifications, AI, Ask the network, trends and admin.
# They drive mock-swis (and its fake Claude) through its control API on :17774.
docker compose --profile dev up -d --build
E2E_SETUP_CODE=$(docker compose logs web | grep -o '"setupCode":"[^"]*"' | tail -1 | cut -d'"' -f4) pnpm test:e2e
```

Repository layout:

```
apps/web          Next.js (App Router): setup wizard, Settings, dashboard, Entra sign-in, SSE, /wall
apps/worker       pg-boss scheduler, SWIS pollers, setup jobs, health server (+ init/migrate/discover)
packages/core     config + settings registry, encryption, logger, Orion vocabulary, mapping, diffing,
                  correlation engine, priority scoring + AI guardrail, site health, incident
                  actions, timeline, sign-in rules, notification routing, on-call and
                  dispatch planning (all pure, unit-tested)
packages/db       Drizzle schema, migrations, repositories, seed data
packages/swis     SWIS client, SWQL catalog, schema probe, discovery, fixture sanitizer
packages/notify   Teams Workflows, Twilio and Pushover providers behind one Notifier interface
packages/ai       AiRunner: the only code that calls Claude (budget, redaction, caching, retry, call
                  log) and the "Ask the network" tool loop
tools/mock-swis   mock SWIS server, synthetic Mercer-like world, storm scenarios, and
                  Teams/Twilio/Pushover sinks (GET /__mock/sink lists what was "sent")
tools/simulator   replays storms through the real pipeline on a virtual clock and checks the incidents
scripts/          swis-discover.ts, swis-record.ts
docker/           Dockerfile, backup sidecar
```

Conventions are in [CLAUDE.md](CLAUDE.md).
