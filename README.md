# MercerAlertService

An internal tool for Mercer Landmark IT that sits on top of SolarWinds Orion/NPM. Orion
keeps polling the devices. MercerAlertService (MAS) does the following:

1. Reads alerts, status and topology over the **SWIS REST API**.
2. Turns raw alert storms into a few prioritized **incidents**. Correlation is
   deterministic. Claude only adds enrichment.
3. Posts incidents to **Microsoft Teams**, and pages on-call by **SMS or Pushover** for urgent ones.
4. Serves a live **dashboard** and a **NOC wall display**.

Design docs: [architecture](docs/architecture.md) · [database schema](docs/schema.md) ·
[SWQL queries](docs/swql-queries.md) · [open questions](docs/open-questions.md) ·
[project conventions](CLAUDE.md)

## Status

| Milestone        | Scope                                                                                                                              | State    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. Foundation    | Repo, Docker Compose, schema and migrations, SWIS client, discovery and recorder scripts, mock SWIS, polling into Postgres, health | **Done** |
| 1b. Online setup | Browser setup wizard and Settings: no config files, encrypted secrets, live reload                                                 | **Done** |
| 2. Correlation   | Dedupe, topology suppression, flap detection, incident lifecycle, simulator                                                        | Next     |
| 3. Dashboard v1  | Entra SSO, overview, incidents, site and node pages, SSE, wall display                                                             |          |
| 4. Notifications | Teams cards, Twilio/Pushover, on-call and escalation, shadow mode                                                                  |          |
| 5. AI            | Summaries, severity suggestion with guardrails, digests, budget, fallbacks                                                         |          |
| 6. Polish        | Ask the network, trends, admin, hardening                                                                                          |          |

---

## Install on the Linux VM (no config files)

Requirements:

- Docker Engine with the Compose plugin v2.24 or newer.
- Outbound TCP **17774** to the Orion server.
- Outbound HTTPS to the hosts listed in [architecture §11](docs/architecture.md#11-security--operations).
  Those hosts are needed from Milestone 4 on.

```bash
git clone <repo> /opt/mercer-alert-service && cd /opt/mercer-alert-service
docker compose up -d --build
docker compose logs web | grep -i "setup code"
```

Then open `http://<vm>:3000` in a browser. The **setup wizard** asks for:

1. **The setup code and an administrator account.** The one-time code only appears in the
   server log, so someone who can merely reach port 3000 can't claim the installation. The
   account is a local break-glass admin. Entra ID sign-in arrives in Milestone 3.
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
- **Testing first.** To try MAS without Orion, run
  `docker compose --profile dev up -d --build`. In the wizard, expand _Advanced_, set the base
  URL to `http://mock-swis:17774`, and use user `mas` / password `mas`.
- **Building behind a TLS-inspecting proxy.** Use
  `BUILD_CA_FILE=./secrets/corp-ca.pem docker compose build`. The file must be inside the
  project directory, and it is only used during the build.

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

**Write-back (optional, off by default).** To acknowledge alerts in Orion when an incident
is acknowledged in MAS, create a **second** account. Give it the same settings, except
_Allow alert management rights_ = **Yes**. Then enter it on the SolarWinds page under
_Orion write-back_.

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

### Teams, Twilio/Pushover, Entra ID

These are configured in the same Settings UI when their milestones land:

- Entra ID sign-in: Milestone 3
- Teams Workflows webhooks, Twilio (start A2P 10DLC registration early), Pushover and
  shadow mode: Milestone 4

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
worker records a **source down** transition. From Milestone 2 on, this raises a P1
"Monitoring source down" incident.

### Logs

Logs are structured JSON (pino). Use `docker compose logs -f worker | npx pino-pretty` for
readable output. Secrets and authorization headers are redacted.

### Backups and restore

The `backup` sidecar runs `pg_dump -Fc` daily at `BACKUP_TIME` (local time) into
`BACKUP_HOST_DIR` (default `./backups`) and keeps `BACKUP_KEEP_DAYS` days of dumps. Copy
that directory off the VM, for example to a NAS (open question D6).

```bash
docker compose exec backup /backup.sh now           # immediate backup
# restore (stops writers first)
docker compose stop worker web
docker compose exec -T db pg_restore -U mas -d mas --clean --if-exists < backups/mas-YYYYMMDDTHHMMSSZ.dump
docker compose start worker web
```

**Also keep a copy of the master key.** Secrets saved in the web UI (the Orion password and,
later, webhook URLs and API keys) are encrypted with it. A database dump alone is useless
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
- The audit log after 2 years

Incidents are kept for 2 years (from Milestone 2).

### Upgrades

```bash
cd /opt/mercer-alert-service
docker compose exec backup /backup.sh now
git pull
APP_VERSION=$(git describe --always) docker compose up -d --build
docker compose ps && curl -fsS localhost:3000/api/health
```

Migrations run automatically through the `migrate` service before `worker` and `web` start.
Migrations only move forward. To roll back, check out the previous version and restore the
backup you took before the upgrade.

---

## Development reference

```bash
pnpm lint && pnpm typecheck && pnpm test      # unit tests (no DB)
DATABASE_URL_TEST=postgres://mas:mas@localhost:5432/mas_test pnpm test:integration
pnpm db:generate     # after editing packages/db/src/schema/*; commit the generated SQL
pnpm swis:record --rows 200 --hash-hostnames  # capture sanitized real fixtures
pnpm dev:mock-swis -- --replay fixtures/swis/recorded
# End-to-end (browser) test of the setup wizard against a FRESH stack:
docker compose --profile dev up -d --build
E2E_SETUP_CODE=$(docker compose logs web | grep -o '"setupCode":"[^"]*"' | tail -1 | cut -d'"' -f4) pnpm test:e2e
```

Repository layout:

```
apps/web          Next.js (App Router): setup wizard, Settings, dashboard, API, SSE, /wall
apps/worker       pg-boss scheduler, SWIS pollers, setup jobs, health server (+ init/migrate/discover)
packages/core     config + settings registry, encryption, logger, Orion vocabulary, mapping, diffing
packages/db       Drizzle schema, migrations, repositories, seed data
packages/swis     SWIS client, SWQL catalog, schema probe, discovery, fixture sanitizer
tools/mock-swis   mock SWIS server, synthetic Mercer-like world, storm scenarios
scripts/          swis-discover.ts, swis-record.ts
docker/           Dockerfile, backup sidecar
```

Conventions are in [CLAUDE.md](CLAUDE.md).
