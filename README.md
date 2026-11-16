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
| 2. Correlation   | Dedupe, topology suppression, flap detection, incident lifecycle, simulator                                                        | Next     |
| 3. Dashboard v1  | Entra SSO, overview, incidents, site and node pages, SSE, wall display                                                             |          |
| 4. Notifications | Teams cards, Twilio/Pushover, on-call and escalation, shadow mode                                                                  |          |
| 5. AI            | Summaries, severity suggestion with guardrails, digests, budget, fallbacks                                                         |          |
| 6. Polish        | Ask the network, trends, admin, hardening                                                                                          |          |

---

## Quick start (local development, no Orion needed)

Prerequisites: Node ≥ 22.19 (24 LTS recommended), pnpm 10 (`corepack enable`), and Docker.

```bash
pnpm install
cp .env.example .env
# For local dev, edit .env:
#   POSTGRES_PASSWORD=devpass   SWIS_BASE_URL=http://127.0.0.1:17774
#   SWIS_USERNAME=mas  SWIS_PASSWORD=mas  SWIS_CA_CERT_PATH=   (blank)
#   DATABASE_URL=postgres://mas:devpass@localhost:5432/mas
pnpm dev:db              # Postgres in Docker on 127.0.0.1:5432
pnpm db:migrate && pnpm db:seed
pnpm dev:mock-swis       # fake Orion on :17774 (about 80 nodes across 13 placeholder sites)
pnpm dev:worker          # polls the mock into Postgres
pnpm dev:web             # http://localhost:3000 (status page) and /api/health
```

The whole stack can also run in Docker against the mock:

```bash
# in .env: SWIS_BASE_URL=http://mock-swis:17774, SWIS_USERNAME=mas, SWIS_PASSWORD=mas, SWIS_CA_CERT_PATH=
docker compose --profile dev up -d --build
```

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

## Deploying on the Linux VM

Requirements:

- Docker Engine with the Compose plugin.
- Outbound TCP **17774** to the Orion server.
- Outbound HTTPS to the hosts listed in [architecture §11](docs/architecture.md#11-security--operations).
  Those hosts are needed from Milestone 4 on.

```bash
git clone <repo> /opt/mercer-alert-service && cd /opt/mercer-alert-service
cp .env.example .env && chmod 600 .env     # fill in; see the sections below
mkdir -p secrets backups
# put Orion's certificate in secrets/orion-ca.pem (see "Orion certificate" below)
docker compose build
docker compose run --rm --no-deps worker node dist/discover.js --check-queries   # see step 3
docker compose up -d --build
docker compose ps        # db healthy, migrate exited 0, worker/web healthy
```

| Service   | What it does                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `db`      | PostgreSQL 16. Data is in the `pgdata` volume.                                                                           |
| `migrate` | One-shot. Applies migrations and seeds placeholder sites on a brand-new database.                                        |
| `worker`  | Polls SWIS and writes to Postgres. Health check at `:9090/healthz`.                                                      |
| `web`     | Dashboard and API on `WEB_PORT` (default 3000). Put your reverse proxy with the internal TLS certificate in front of it. |
| `backup`  | Nightly `pg_dump` to `./backups`.                                                                                        |

If the build runs behind a TLS-inspecting proxy, point `BUILD_CA_FILE` at your corporate CA
(the file must be inside the project directory):
`BUILD_CA_FILE=./secrets/corp-ca.pem docker compose build`. The CA is only used during the
build and never ends up in a runtime image.

### 1. Create the read-only Orion account

Use a dedicated account so its access can be audited and revoked. Menu names differ slightly
between Orion versions.

1. In the Orion Web Console, go to **Settings → All Settings → User Accounts → Manage Accounts → Add New Account**.
2. Choose **Orion individual account**. You can also use a Windows/AD service account; in
   that case use `DOMAIN\user` as `SWIS_USERNAME`. Name it, for example, `svc-mas-ro`, and give it a long
   random password that does not expire.
3. On the account settings page:
   - Allow administrator rights: **No**
   - Allow node management rights: **No**
   - Allow alert management rights: **No**
   - Allow account to customize views / disable actions: **No**
   - **Do not add account limitations.** MAS needs to see every node, or correlation will have gaps.
4. Test it from the VM:

   ```bash
   curl -sS --cacert secrets/orion-ca.pem -u 'svc-mas-ro:PASSWORD' \
     -H 'content-type: application/json' \
     -d '{"query":"SELECT TOP 1 n.NodeID AS NodeID, n.Caption AS Caption FROM Orion.Nodes n"}' \
     https://orion.mercer.local:17774/SolarWinds/InformationService/v3/Json/Query
   ```

5. Put the account in `.env` as `SWIS_USERNAME` / `SWIS_PASSWORD`. Alternatively, store the
   password in `secrets/swis_password` and set `SWIS_PASSWORD_FILE=/run/mas-secrets/swis_password`.

**Write-back (optional, off by default).** To acknowledge alerts in Orion when an incident
is acknowledged in MAS, create a **second** account. Give it the same settings, except
_Allow alert management rights_ = **Yes**. Then set `SWIS_WRITEBACK_ENABLED=true`,
`SWIS_WRITE_USERNAME` and `SWIS_WRITE_PASSWORD`. The read-only poller never uses this account.

### 2. Orion certificate (CA bundle)

SWIS on port 17774 normally presents Orion's self-signed certificate. MAS **verifies TLS by
default**, so give it that certificate:

```bash
# On the VM. Shows the certificate SWIS presents.
openssl s_client -connect orion.mercer.local:17774 -servername orion.mercer.local -showcerts </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > secrets/orion-ca.pem
openssl x509 -in secrets/orion-ca.pem -noout -subject -issuer -enddate -fingerprint -sha256
```

- **Check the SHA-256 fingerprint** against the certificate on the Orion server itself
  (`certlm.msc` → Personal → Certificates). The point is to avoid trusting an interception proxy.
- If the subject/CN isn't the hostname you connect to (self-signed Orion certificates often
  say `CN=SolarWinds-Orion`), set `SWIS_TLS_SERVERNAME` to the CN on the certificate.
- If an internal CA issued Orion's certificate, put that **CA** certificate in
  `secrets/orion-ca.pem` instead. It is added to the normal trust store.
- `SWIS_CA_CERT_PATH=/run/mas-secrets/orion-ca.pem` (the default in `.env.example`).
- `SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY=true` turns verification off. Use it for
  development only. It is logged at error level every 10 minutes and shown in `/api/health`.

### 3. Confirm field names (discovery)

Run this before the first real deployment, and again after Orion upgrades:

```bash
docker compose run --rm --no-deps worker node dist/discover.js --check-queries
# or, with Node on any machine that can reach Orion:  pnpm swis:discover --check-queries --json report.json
```

The report lists:

- The entities MAS uses, and any **missing fields**. Optional fields are dropped
  automatically; a missing required field stops that poller with a clear error.
- Every **node custom property**, with its most common values. Use this to set
  `CP_SITE_FIELD`, `CP_DIVISION_FIELD` and `CP_CITY_FIELD`.
- Vendors and machine types (for device-role rules), counts of dependencies, topology
  links and groups, alert definitions, the `Acknowledge` verb signature, and SWIS server
  UTC/local time. If timestamps come back without a `Z` and match local time, set
  `SWIS_NAIVE_TIMEZONE`.

Send the output (it contains hostnames, so share it internally only) to whoever answers
[open questions](docs/open-questions.md) A4–A10.

### 4. Sites and divisions

- Nodes map to sites in this order: admin override → the `Site` custom property (matched
  against site code, name or aliases, ignoring case and punctuation) → hostname prefix
  (`SITE_FROM_CAPTION_REGEX`, e.g. `ROCK-FW01` → `ROCK`) → unmapped.
- A `Site` value that doesn't match any site creates a site profile automatically
  (`profile_status=auto`). Complete it later in Admin (Milestone 6).
- Twelve **placeholder** sites and the seven divisions are seeded on first install. See
  `packages/db/src/seed-data.ts`. Replace them with the real list (open question B1).

### 5. Teams, Twilio/Pushover, Entra ID

Covered when those milestones land:

- Entra app registration and the security group restriction: Milestone 3
- Teams Workflows webhooks, Twilio (including A2P 10DLC registration), Pushover and shadow mode: Milestone 4

The placeholders are already in `.env.example`.

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

## Development

```bash
pnpm lint && pnpm typecheck && pnpm test      # unit tests (no DB)
DATABASE_URL_TEST=postgres://mas:mas@localhost:5432/mas_test pnpm test:integration
pnpm db:generate     # after editing packages/db/src/schema/*; commit the generated SQL
pnpm swis:record --rows 200 --hash-hostnames  # capture sanitized real fixtures
pnpm dev:mock-swis -- --replay fixtures/swis/recorded
```

Repository layout:

```
apps/web          Next.js (App Router): dashboard, API, SSE, /wall
apps/worker       pg-boss scheduler, SWIS pollers, health server (+ migrate/discover entrypoints)
packages/core     config, logger, Orion vocabulary, site/role mapping, diffing (pure)
packages/db       Drizzle schema, migrations, repositories, seed data
packages/swis     SWIS client, SWQL catalog, schema probe, discovery, fixture sanitizer
tools/mock-swis   mock SWIS server, synthetic Mercer-like world, storm scenarios
scripts/          swis-discover.ts, swis-record.ts
docker/           Dockerfile, backup sidecar
```

Conventions are in [CLAUDE.md](CLAUDE.md).
