# MercerAlertService — Architecture

Status: design baseline (Milestone 0). Owner: Mercer Landmark IT.

## 1. What this is

SolarWinds Orion/NPM keeps doing all device polling. MercerAlertService (MAS) reads
Orion through the SWIS REST API, turns the raw alert stream into a few clear,
prioritized incidents, and delivers them to Teams, SMS and push. It also gives the
IT team a live dashboard and a NOC wall display.

Design rules. Every later decision follows from these:

1. **SWIS is the only device data source.** MAS never polls a device directly.
2. **Deterministic first.** Code decides whether an incident exists, how alerts group,
   and whether a notification goes out. AI only enriches the result: summaries,
   suggestions and digests.
3. **AI is never on the critical path.** If the Anthropic API is slow, down or over
   budget, incidents still form and templated notifications still go out. The AI
   summary is attached when it arrives.
4. **Store transitions, not polls.** We store current snapshots, state changes and
   5-minute metric rollups. We don't keep every poll result.
5. **Fail loud.** If SWIS, the worker, a notifier or the AI budget fails, MAS raises
   its own visible signal: an incident, a banner, or the wall's "DATA STALE" banner.
6. **Shadow mode first.** A single flag sends every outbound message to one test
   Teams channel, so MAS can run alongside the existing SolarWinds emails before cutover.

## 2. Components

| Service (Compose) | Process                        | Responsibilities                                                                                                                                                                                    |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`            | one-shot (worker image, root)  | Generates the bootstrap secrets once into the `bootstrap` volume: DB password, `database_url` and the **master key** that encrypts secrets saved in the web UI. It never overwrites existing files. |
| `db`              | PostgreSQL 16                  | All state: SWIS mirror, transitions, incidents, config, audit, pg-boss queues (`pgboss` schema). Named volume `pgdata`.                                                                             |
| `migrate`         | one-shot (worker image)        | Applies Drizzle SQL migrations, then exits. `web` and `worker` wait for it to complete.                                                                                                             |
| `worker`          | Node (long-running)            | SWIS polling, correlation, scoring, AI calls, notifications, escalations, digests, retention, self-monitoring, heartbeat. Exposes `:9090/healthz` for the container healthcheck.                    |
| `web`             | Next.js (App Router)           | IT dashboard (Entra SSO), admin, "Ask the network" chat API, SSE streams, `/wall` kiosk, `/api/health`. **Does no polling.**                                                                        |
| `backup`          | postgres:16-alpine + cron loop | Nightly `pg_dump -Fc` to the `backups` volume, with rotation.                                                                                                                                       |
| `mock-swis`       | Node (dev/CI profile only)     | Fake SWIS that serves a synthetic Mercer-like world or recorded fixtures, with a control API for scenarios, plus Teams/Twilio/Pushover sinks for notification tests.                                |

Monorepo packages (pnpm workspaces, TypeScript everywhere):

```
apps/web          Next.js UI + API routes + SSE
apps/worker       pg-boss job handlers, pollers, scheduler, health server
packages/core     domain types, config (zod env), logger, status/role/site mapping,
                  correlation + scoring + guardrails (pure, heavily unit-tested)
packages/db       Drizzle schema, migrations, repositories, seed data
packages/swis     SWIS client (TLS/CA, retries, circuit breaker, WITH ROWS paging),
                  SWQL query catalog, row schemas, schema probe, discovery
packages/notify   (M4) Notifier interface; Teams Workflows, Twilio, Pushover providers
packages/ai       (M5) Anthropic client wrapper, prompts, schemas, budget, redaction
tools/mock-swis   mock SWIS server + synthetic world generator
tools/simulator   (M2) scenario CLI that replays storms and asserts outcomes
scripts/          swis-discover.ts, swis-record.ts, dev helpers
```

## 3. Data flow

```mermaid
flowchart LR
  subgraph Orion["SolarWinds Orion (on-prem)"]
    SWIS[("SWIS REST API\nTCP 17774")]
  end

  subgraph Worker["worker (Node)"]
    direction TB
    SCHED["Scheduler\n(interval ticks + pg-boss cron)"]
    CLIENT["SWIS client\nCA bundle · timeouts · retries\nWITH ROWS paging · circuit breaker"]
    POLL["Pollers\nalerts 30s · nodes 60s · interfaces 3m\nevents 5m · topology 1h"]
    DIFF["Snapshot diff\n→ state transitions"]
    CORR["Correlation engine (deterministic)\ndedupe → flap → topology/dependency\n→ time-window grouping → lifecycle"]
    SCORE["Priority scoring\nseverity × site tier × impact\n± season ± time of day"]
    AIQ["AI enrichment (async, debounced)\nsummary · severity suggestion\ndigest · weekly trends"]
    GUARD["Guardrails\n±1 level max, P2 floor rules"]
    NOTIFY["Notification dispatcher\nrouting · shadow mode · quiet hours\nmaintenance · rate limits · retries"]
    ESC["Escalation timers\non-call → next → IT lead"]
  end

  subgraph DB["PostgreSQL"]
    MIRROR[("SWIS mirror\nnodes · interfaces · active alerts\ntopology · dependencies · groups")]
    TRANS[("entity_transitions\n+ 5-min metric rollups\n+ events / alert history")]
    INC[("alert_records · incidents\nincident_events · notifications")]
    CFG[("site profiles · seasons · routing\non-call · maintenance · settings")]
    AUD[("audit_log · ai_calls")]
    BOSS[("pg-boss queues")]
  end

  subgraph Web["web (Next.js)"]
    UI["IT dashboard\n(Entra ID SSO)"]
    WALL["/wall kiosk\n(token + IP allowlist)"]
    CHAT["Ask the network\n(read-only DB tools)"]
    SSE["SSE streams\n(LISTEN mas_events)"]
  end

  ANTH["Anthropic API"]
  TEAMS["Teams Workflows\nwebhooks"]
  SMS["Twilio SMS /\nPushover"]

  SCHED --> POLL --> CLIENT --> SWIS
  POLL --> DIFF --> MIRROR & TRANS
  TRANS --> CORR --> INC
  CFG --> CORR & SCORE & NOTIFY
  CORR --> SCORE --> INC
  INC --> NOTIFY --> TEAMS & SMS
  NOTIFY --> ESC --> SMS
  INC -. "debounced job" .-> AIQ --> ANTH
  AIQ --> GUARD --> INC
  AIQ -. "summary ready → card update" .-> NOTIFY
  Worker -- "pg_notify(mas_events)" --> SSE
  SSE --> UI & WALL
  UI --> INC & CFG
  UI --> AUD
  CHAT --> ANTH
  CHAT --> INC & MIRROR
  Worker <--> BOSS
```

### Alert storm, end to end (target behavior)

```mermaid
sequenceDiagram
  participant O as Orion SWIS
  participant P as Pollers
  participant C as Correlation
  participant N as Notifier
  participant A as AI (async)
  participant T as Teams / SMS
  O->>P: Rockford FortiGate down + 30 child alerts (2 polls)
  P->>C: 31 "raised" transitions (one correlate job, stately queue)
  C->>C: FortiGate is the WAN edge for the site → root.<br/>Children are Unreachable/at same site → symptoms
  C->>N: 1 incident, P1 (harvest-critical grain site, October)
  N->>T: Templated card now (title, site, division, 31 alerts, Ack/Snooze/View)
  C-->>A: enqueue summary (debounced 45 s, singleton per incident)
  A->>A: Claude summary + severity suggestion → Zod validate → guardrails
  A->>N: summary ready
  N->>T: Follow-up card: "Scales at the Rockford elevator may be offline…"
  Note over N,T: Not acked in 15 min → escalate to the next on-call person, then the IT lead
```

## 4. Worker jobs

Pollers run on **interval ticks**, which support sub-minute periods such as 30 s, and
push into pg-boss queues that use the `stately` policy: at most one queued job and one
active job per queue. A slow SWIS therefore can never pile up overlapping polls, and
several worker replicas cannot double-poll. Wall-clock jobs use pg-boss cron with the
`America/New_York` time zone.

| Queue                  | Trigger                                                                                                                 | Policy    | Milestone |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- | --------- |
| `swis.poll.alerts`     | every 30 s                                                                                                              | stately   | M1        |
| `swis.poll.nodes`      | every 60 s                                                                                                              | stately   | M1        |
| `swis.poll.interfaces` | every 180 s                                                                                                             | stately   | M1        |
| `swis.poll.events`     | every 300 s                                                                                                             | stately   | M1        |
| `swis.poll.topology`   | every 3600 s, and at startup                                                                                            | stately   | M1        |
| `maint.retention`      | cron `15 3 * * *` ET                                                                                                    | singleton | M1        |
| `correlate.run`        | after any poll that produced transitions, plus every 30 s (lifecycle: hold-down, reopen/close, snooze, maintenance)     | stately   | M2 ✓      |
| `swis.writeback.ack`   | when someone acknowledges in MAS and `SWIS_WRITEBACK_ENABLED` is on (2 retries)                                         | standard  | M3 ✓      |
| `notify.run`           | after each correlation cycle, when the dashboard changes an incident, and every 15 s: dispatch, due escalations, outbox | stately   | M4 ✓      |
| `notify.test`          | Settings → Send test (the web request waits for the result)                                                             | standard  | M4 ✓      |
| `ai.incident.summary`  | debounced per incident (`singletonKey`, 45 s)                                                                           | standard  | M5        |
| `ai.digest.daily`      | cron `0 7 * * *` ET (configurable)                                                                                      | singleton | M5        |
| `ai.digest.weekly`     | cron `30 7 * * 1` ET                                                                                                    | singleton | M5        |
| `maint.selfcheck`      | every 60 s: failing notifiers, overdue outbox, correlation backlog                                                      | singleton | M4 ✓      |

## 5. SWIS integration

- Endpoint `https://<orion>:17774/SolarWinds/InformationService/v3/Json/Query`, using
  POST `{query, parameters}` and Basic auth with a dedicated **read-only** Orion account.
  Parameters are always bound (`@name`). We never interpolate strings. The only inlined
  values are validated integers in `WITH ROWS a TO b` and identifiers checked against
  `^[A-Za-z_][A-Za-z0-9_]*$` (custom property names).
- **TLS:** `SWIS_CA_CERT_PATH` points to a PEM bundle, which is how Orion's self-signed
  certificate is trusted. `SWIS_TLS_SERVERNAME` can override SNI and hostname
  verification, for example when connecting by IP to a certificate issued for the FQDN.
  `SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY=true` turns verification off. It logs at
  **error** level at startup and every 10 minutes, shows on `/api/health`, and is meant
  for development only.
- **Resilience:** per-request timeout (default 20 s). Up to 3 retries with exponential
  backoff and jitter on network errors, 408, 429 and 5xx. No retry on 400 (a SWQL
  error) or 401/403. A circuit breaker opens after 5 consecutive failures and moves to
  half-open after 30 s. While it is open, polls are recorded as `skipped_circuit_open`.
- **Paging:** `ORDER BY <key> WITH ROWS n TO m` (default page 1000) for snapshot
  queries. Event and alert-history queries are incremental: `WHERE ID > @cursor`, with
  `WITH ROWS 1 TO n` as the page limit.
- **Schema probe:** at startup and hourly, the worker reads `Metadata.Property` for every
  entity we query. Optional fields that are missing in this Orion version are dropped
  from the SELECT with a warning. A missing required field fails that poller with a clear
  error. Custom-property columns are discovered from `Metadata.Property` on
  `Orion.NodesCustomProperties`.
- **Monitoring source down:** if the breaker opens, or the last successful alert poll is
  older than `SWIS_STALE_AFTER_SEC` (default 120 s), the worker writes a `source down`
  transition. The correlation engine (M2) turns that into a fixed **P1 "Monitoring source
  down"** incident. Notifications don't depend on SWIS, so this incident still goes out.
- **Write-back (off by default):** when `SWIS_WRITEBACK_ENABLED=true` and the separate
  `SWIS_WRITE_USERNAME`/`SWIS_WRITE_PASSWORD` account is configured, acknowledging an
  incident in MAS invokes `Orion.AlertActive.Acknowledge` for the member alerts'
  AlertObjectIDs. The read-only client never gets these credentials.

The full query list is in [swql-queries.md](swql-queries.md).

## 6. Storage model

Three layers. Full schema: [schema.md](schema.md).

1. **Mirror (current state):** `orion_nodes`, `orion_interfaces`, `orion_active_alerts`,
   topology, dependencies and groups. These are upserted from each successful **complete**
   fetch. A failed or partial fetch never deletes rows and never "clears" alerts.
2. **History:** `entity_transitions` (alert raised, cleared, retriggered or acked; node and
   interface status changes; source up/down). There are also 5-minute rollups
   (`node_metrics_5m`, `interface_metrics_5m`, upserted with running avg and max) and the
   Orion `events` and `alert_history` streams. Retention is 90 days by default.
3. **Derived:** `alert_records` (deduped per alert rule + entity), `incidents`,
   `incident_members` and `incident_events`, plus notifications, digests and AI call logs.
   Incidents are kept for 2 years.

All timestamps are `timestamptz` stored in UTC. Business logic (business hours, harvest
season, digests) runs in `APP_TIMEZONE`, default `America/New_York`.

## 7. Correlation & priority (implemented in M2)

The engine (`packages/core/src/correlation`) is a pure function. The worker's
`correlate.run` job loads a snapshot from Postgres, runs the engine, and persists the result
in one transaction under an advisory lock. The snapshot holds pending transitions, the
mirror, the topology graph, open and recently resolved incidents, active alert records,
seasons, maintenance windows and recent flap history. The job runs after every poll that
recorded changes, and every 30 s as the lifecycle tick.

1. **Dedupe.** One `alert_record` per `(AlertID, EntityUri)`. A re-trigger increments
   `trigger_count`. Orion node status adds `status:node:<id>` records: _down_ is critical,
   and _unreachable_ is a symptom only. SWIS itself adds `internal:source:swis`.
2. **Flapping.** A device or interface with at least `FLAP_COUNT` state changes in
   `FLAP_WINDOW_MIN` becomes, or joins, one flapping incident. Consecutive changes in the same
   direction count once, so a status change plus its "Node is down" alert is one change. A
   flapping incident resolves after the device has been stable for the whole flap window.
3. **Grouping.** A new problem joins an open incident if any of these holds:
   - the incident is at the same site and was active within `CORRELATION_WINDOW_SEC`;
   - the problem's upstream root is the root of an ongoing outage, at any site; or
   - the problem has no site but is on the same node, within the window.

   Otherwise a new incident opens. An old standing alert on a device never pulls a new storm
   into its incident.

4. **Root cause.** Walk upstream through down or unreachable parents. Parents come from Orion
   dependencies (a parent group's members expanded) and from topology links, which are
   oriented by device role. If neither exists, fall back to the site's down WAN-edge firewall.
   A device with an active "node down" alert counts as down even before the next node poll.
5. **Classification.**
   - `site_outage`: the root is the site firewall, or every managed node at the site is down
     or unreachable.
   - `ups_power`: a UPS node is involved, or an alert name matches `UPS_ALERT_REGEX`.
   - `device_down`, `interface`, `service` and `generic` cover the rest.
   - `flapping` and `monitoring_source_down` are fixed by how the incident was formed.

   Members get the role root, symptom or member. Titles and summaries come from
   deterministic business-language templates, for example "Scales at Coldwater Elevator may be
   offline".

6. **Lifecycle.** `open → acknowledged → resolved → closed`.
   - Auto-resolve after all members have been clear for `RESOLVE_HOLDDOWN_SEC`.
   - Reopen if a member returns within `REOPEN_WINDOW_SEC`; close after that.
   - Snooze expiry is handled on the lifecycle tick.
   - A maintenance window that suppresses "notifications" sets `in_maintenance`. One that
     suppresses "incidents" holds alerts back until the window ends, then raises them if
     they are still active.
7. **Seeding and reconcile.** Alerts already active when MAS starts are marked `seeded`. They
   don't count towards the noise ratio, and M4 won't page for them. Once per monitoring
   start, after both alerts and nodes have been polled, records are reconciled against the
   mirror. This also covers upgrades, because backlog older than `CORRELATION_MAX_AGE_SEC` is
   skipped rather than replayed.
8. **Noise ratio.** Raw Orion alert raises (excluding initial sync) ÷ non-seeded incidents
   opened. The status page shows it for 24 h and 7 d.

**Priority** comes from a deterministic score, and every factor is stored in
`incidents.priority_factors`:

```
score = impact points × Orion severity × site tier × season × time of day
  impact:   whole site 70 · firewall / core switch / scale system 50 · router 45 · server 40
            · power/UPS 40 · interface on a core device 40 · switch 35 · AP 25 · other interface 20
            · several devices = worst + 10 (max 60)
  severity: critical 1.0 · serious 0.85 · warning 0.6 · notice 0.4 · informational 0.25
  tier:     critical 1.4 · high 1.2 · standard 1.0                        (Settings → Correlation)
  season:   harvest at a harvest-critical site → Harvest multiplier (1.5); harvest at other grain
            sites 1.2; other periods by division                         (Settings → Seasons)
  time:     outside the site's business hours (harvest hours in harvest) 0.8 — not applied to
            site outages / firewall down at harvest-critical sites during harvest
P1 ≥ 70 · P2 ≥ 50 · P3 ≥ 30 · else P4; "Monitoring source down" is always P1.
```

Settings → Correlation shows live examples computed from the saved settings. The simulator
(`pnpm simulate`) asserts these outcomes end to end, through the real pollers, correlation,
notification dispatcher and HTTP delivery to the mock's Teams and Twilio sinks:

| Scenario                                                    | Incident                                                                     | Routing (default rules, nobody acknowledges)      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| Rockford FortiGate down with 30 child alerts, October 10:00 | **1** site outage, **P1**, 31 alerts, resolved after recovery, 31:1          | #net-critical; on-call paged; escalated at 15 min |
| Same outage in March at 22:00                               | **1** site outage, **P2**                                                    | #net-critical; paged (P2 after hours); escalated  |
| Flapping AP (6 bounces in 6 min)                            | **1** flapping incident, **P3**                                              | #net-alerts; no page                              |
| UPS on battery at Coldwater in harvest                      | **1** power incident, **P2**                                                 | #net-critical; no page (business hours)           |
| HQ WAN link ramps to 98 %                                   | **1** interface incident, **P3**                                             | #net-alerts; no page                              |
| SWIS returns 503 for 5 min                                  | **1** "SolarWinds monitoring unavailable", **P1**, resolved after it returns | #net-critical; paged                              |

The **recovery target** is shown on each incident: 4 h for harvest-critical sites during
harvest, 8 h otherwise.

**AI severity guardrail** (`applyAiAdjustment`, already unit-tested). Claude can propose ±1
level, with a reason that is stored and displayed. AI can never lower a whole-site outage, a
firewall-down incident, or any harvest-critical site during harvest below **P2**. If such an
incident is already below P2, AI can't lower it at all. Monitoring-source-down is fixed.

## 8. AI layer (M5 design summary)

| Task                                 | Default model                         | Effort | Notes                                                       |
| ------------------------------------ | ------------------------------------- | ------ | ----------------------------------------------------------- |
| Severity suggestion / classification | `claude-haiku-5-5` (`AI_MODEL_FAST`)  | low    | Output shape: `{adjust: -1\|0\|1, reason}`, then guardrails |
| Incident summary                     | `claude-opus-5-5` (`AI_MODEL_STRONG`) | medium | On open and on material change, debounced                   |
| Daily / weekly digests               | `claude-opus-5-5`                     | medium | 07:00 ET daily, Monday weekly                               |
| Ask the network (chat)               | `claude-opus-5-5`                     | medium | Read-only tools that query the DB, never SQL, never SWIS    |

Each task's model can be overridden with `AI_MODEL_<TASK>`.

- **Structured output.** We use `client.messages.parse()` with `zodOutputFormat(schema)`,
  which gives JSON-schema-constrained output, and we re-validate with Zod. The current
  Opus and Sonnet models reject _forced_ `tool_choice`, so JSON-schema structured outputs
  is the supported way to get the "tool use with a JSON schema" guarantee. The chat uses
  real tools with `strict: true`. If the response is invalid, we retry once and then fall
  back to the templated summary.
- **Refusals and errors.** We check `stop_reason` before reading content. Opus calls
  enable server-side fallbacks (`fallbacks: "default"`). Any refusal, timeout or API
  error falls back to the template and is logged.
- **Prompt caching.** The environment description and site profiles (serialized as
  sorted JSON) form a stable system prefix with `cache_control`. Volatile incident data
  comes after the breakpoint.
- **Budget.** `ai_calls` logs purpose, model, tokens (including cache read/write),
  latency and estimated cost. `AI_DAILY_BUDGET_USD` shows a warning banner at 80%. At
  100%, summaries, digests and chat drop to templates or are disabled until midnight ET.
- **Debounce.** At most one summary job is queued per incident. A storm of 40 alerts
  produces one summary, and later updates fire only on _material_ change: priority, root
  cause, affected sites, or resolved.
- **Redaction.** When `AI_REDACT=true` (default), IPv4/IPv6, MAC and serial-like tokens
  are replaced with stable placeholders (`[IP-3]`) before the call and restored locally
  for display. Hostnames and site names are sent.

## 9. Notifications (implemented in M4)

**Decisions are pure.** `planDispatch(incident, whatWasAnnounced, context)` in
`packages/core/src/notify` decides every message (and `planEscalation` every escalation); the
worker only records and sends. The planner sees deterministic incident fields only, never AI
output, so AI cannot decide whether something is delivered.

**What triggers a message.** The dispatcher compares each incident with what was already
announced (`incident_notify_state`) and reacts to the difference:

| Change                                               | Teams                                 | SMS / push                                                             |
| ---------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| Opened (not pre-existing)                            | Card to the routed channels           | Page the on-call primary if a rule says so                             |
| Pre-existing incident becomes real (new alerts join) | Treated as opened                     | As opened                                                              |
| Priority or kind changed                             | `INC-12 · Update n: Priority P3 → P1` | Page if it just became page-worthy                                     |
| Acknowledged / un-acknowledged                       | Update                                | Pending escalations cancelled                                          |
| Snoozed                                              | Update                                | Escalations cancelled; when the snooze ends unacknowledged, page again |
| Resolved                                             | Resolved card                         | Short "RESOLVED … after 42 min" to everyone who was paged              |
| Reopened                                             | Update                                | Page again                                                             |

Running the planner twice with nothing new produces nothing, so a missed trigger is caught by
the next tick. Pre-existing incidents found at startup are never announced.

**Routing** (Settings → Routing) is an ordered rule list: match priorities, kinds, divisions,
sites and business/after hours (the site's hours, harvest hours in harvest); post to a Teams
channel and/or page on-call with an escalation delay; optionally stop. The defaults: P1–P2 to
`#net-critical`, P3–P4 to `#net-alerts`, page for every P1 and for P2 after business hours.

**On-call** (Settings → On-call): people in rotation order hand off weekly (Monday 08:00 ET by
default); any week can be assigned explicitly; time-boxed cover replaces the primary. Escalation
goes primary → secondary → IT lead(s), each after the rule's delay (15 min default), skipping
empty levels and nobody twice.

**Suppression** is recorded, not silent. A message is stored with `status = suppressed` and a
reason: maintenance window, quiet hours (`NOTIFY_QUIET_HOURS`, below `NOTIFY_QUIET_MIN_PRIORITY`),
shadow mode, the per-person rate limit (`PAGE_RATE_LIMIT_PER_15MIN`), no contact details, or a
channel or provider that is not set up. The incident page lists every notification and why it
was or was not sent.

**Shadow mode** (`NOTIFY_SHADOW_MODE`, **on** by default) posts one card per event to the shadow
channel (`#mas-shadow`), marked `[SHADOW]` with the channels it would have reached and who would
have been paged; no SMS or push goes out unless `SHADOW_ALLOW_PAGING`. Test-sends always go to
the chosen target.

**Delivery: the outbox.** `notifications` is also the queue. The sender claims due `queued`
rows (`FOR UPDATE SKIP LOCKED`, with a 2-minute lease so a crashed sender's rows are retried),
sends them, and marks them `sent`, requeues with backoff (30 s, 1, 2, 5, 10 min) or marks them
`failed` for permanent errors (a 4xx, a refused Pushover key). Contacts are read at send time, so
a corrected number takes effect for queued pages. Escalations are rows with a due time, fired by
the same pass. One pass (`notify.run`) runs after every correlation cycle, whenever the
dashboard changes an incident (`pg_notify`), and every 15 s.

**Providers** (`packages/notify`, behind a `Notifier` interface): Teams Workflows webhooks
(Adaptive Card 1.4 posted to "When a Teams webhook request is received"; not the retired
Office 365 connectors), Twilio SMS (number or Messaging Service), Pushover (high priority for
pages). Buttons are `Action.OpenUrl` links to the dashboard (`?do=ack`, `?do=snooze`), which ask
for confirmation: a link preview cannot ack anything. Workflows cannot edit a posted card, so
updates are follow-up cards; the interface has `updatesInPlace` / `inCardActions` capabilities
for a phase-2 Teams bot with `Action.Execute`. SMS stays under 300 characters with a `/i/<code>`
short link. Webhook URLs are sealed with the master key, never returned to the browser, never
logged (provider errors are scrubbed of URLs) and audited only as `[set]`.

**MAS alerts on itself** (`maint.selfcheck`, every minute): a Teams channel or provider that has
failed 3 times in a row, notifications overdue by more than 5 minutes, or more than 5,000
uncorrelated transitions raise a self-alert on the self-alert channel (or any other working
channel), at most hourly each, and a banner on every dashboard page.

## 10. Web, live updates and the wall (implemented in M3)

**Pages.** Overview (`/`): P1–P4 counts, noise ratio, SolarWinds status and poll ages, a site
tile per site grouped by division, the map and the open incidents. Incidents (`/incidents`):
one row of filters (status, opened, priority, division, site, kind, search, `INC-123`),
paged. Incident detail: summary, member alerts with their role, a merged timeline, timing and
recovery target, the priority explanation, affected devices and interfaces, and actions. Sites
(`/sites`, `/sites/<code>`): Site Profile, devices grouped as network / scale systems / servers /
UPS, interfaces down or above 80 %, recent incidents. Devices (`/nodes/<id>`,
`/interfaces/<id>`): status history and charts over 24 h / 7 d / 30 d. Settings adds
**Sign-in**, **Map & wall** and a read-only **Audit log**.

**Site colour** (`siteHealth()` in `packages/core/src/dashboard`): red for an open P1/P2, a site
outage, the WAN firewall down or every device down; amber for any other open incident or a
device down or in warning; blue in a maintenance window; grey with no monitored devices. The
reason is printed under the tile, and every colour has an icon and a label.

**Incident actions.** Acknowledge, un-acknowledge, snooze (30 min – 1 day), cancel snooze,
resolve, and notes. The rules are a pure function (`planIncidentAction`); the repository applies
them in one transaction that also takes the correlator's advisory lock, so a correlation run can
never overwrite an acknowledgement it loaded a moment earlier. Each action writes the incident
event, the audit row and a `pg_notify`. Resolving with alerts still active is allowed (the event
says how many); if they clear and fire again the incident reopens within the reopen window.
Acknowledging can also acknowledge the alerts in Orion (below).

**Timeline.** `buildTimeline()` merges MAS's incident events, alert and status transitions for
the member alerts, nodes and interfaces, the Orion event log for those nodes, and people's acks and
notes from `Orion.AlertHistory`, in time order (at the same instant, Orion's fact comes before
MAS's reaction). Each source can be hidden.

**Auth.** Two ways in, one `CurrentUser`:

- **Microsoft Entra ID** through Auth.js v5 (`next-auth@5.0.0-beta.32`, pinned). The Auth.js
  configuration is built **per request from the saved settings**, so sign-in is set up in Settings
  → Sign-in without a restart or config file. The session key is derived from the master key
  (HKDF), and `AUTH_URL` follows `APP_BASE_URL`, so the redirect URI shown on that page is exactly
  what Entra must have. Sign-in requires the `groups` claim to contain `ENTRA_ALLOWED_GROUP_ID`
  (and the tenant to match). Admins come from `ENTRA_ADMIN_GROUP_ID` or `BOOTSTRAP_ADMIN_EMAILS`;
  everyone else in the group can view, acknowledge, snooze, resolve and add notes. Group overage
  is refused with an explanation. The stock provider's Microsoft Graph photo call is replaced
  (it would fail sign-in on a VM that cannot reach Graph). People are kept in `users`; the JWT
  cookie holds only their id, and a disabled user is refused at the next request.
- **Local administrator accounts** from the setup wizard stay as break-glass access (collapsed
  under the Microsoft button once SSO is on).

**Client addresses.** Next.js keeps a client-supplied `X-Forwarded-For`, so without a proxy any
client could claim any IP. `instrumentation.ts` wraps `http.Server#emit` at start-up so every
request carries the socket address in a header that is always overwritten (`lib/peer-ip.ts`).
With `TRUST_PROXY` on, the address is the entry **our** proxy appended (`TRUST_PROXY_HOPS` from
the right), never the leftmost one. Audit rows and wall IP allowlists use this.

**SSE.** Each web process holds one `LISTEN mas_events` connection (reconnecting with backoff,
and telling clients to resync afterwards) and fans out to `/api/events`. Payloads are validated
with Zod (`@mercer/core/events`) on both ends. Browsers refresh the page's server components,
debounced (1.2 s, at most 4 s), on incident, source, config and poll-with-changes events, so a
storm triggers a few refreshes, not one per alert. The worker also publishes a heartbeat event
every 15 s; the browser uses heartbeats and poll events to show **DATA STALE** when the worker is
silent past `HEALTH_WORKER_STALE_SEC`, SolarWinds has not been polled successfully for
`SWIS_STALE_AFTER_SEC`, or the stream itself has been down for 30 s. Times are corrected for the
browser's clock offset (a wall PC with a wrong clock still shows the right state).

**Wall `/wall/<token>`.** No sign-in. Tokens are 256-bit random, stored as SHA-256 (only a
6-character prefix is kept for display), shown once on creation or rotation, and can be revoked,
given an expiry and limited to IP ranges. Every render and the SSE stream re-check the token
(a revoked link goes blank within a minute); failed attempts are rate-limited per address; every
failure shows the same message. Pages are `noindex`, `no-store` and `Referrer-Policy:
strict-origin`, so the token never reaches a tile server. The wall rotates (`WALL_ROTATE_SEC`)
between open incidents (P1 first), the site grid (problem sites as large tiles, the rest as a
compact "N other sites OK" list) and the map; text is 28–44 px. It shows only titles and short
summaries, with IP and MAC addresses stripped, and no buttons or links. It reloads itself every
6 h.

**Map.** Leaflet, loaded only in the browser. OpenStreetMap tiles by default (`MAP_TILE_URL`,
any XYZ server); `MAP_MODE=image` uses an uploaded PNG/JPEG/WebP (Settings → Map & wall, stored in
`setting_assets`) with `CRS.Simple` and each site's Map X/Y in pixels. Markers are coloured by
site health, with a legend; on the wall, problem sites carry permanent name labels.

**Orion write-back (optional).** With `SWIS_WRITEBACK_ENABLED` and a separate write-capable
account, acknowledging in MAS queues `swis.writeback.ack`; the worker calls
`Orion.AlertActive.Acknowledge` for the incident's active, not-yet-acknowledged Orion alerts and
records the result on the timeline and in the audit log. The web app never calls SWIS.

## 10b. Configuration & first-run setup

```mermaid
sequenceDiagram
  participant A as Admin (browser)
  participant W as web (Next.js)
  participant DB as Postgres
  participant K as worker
  participant O as Orion SWIS
  Note over W: first start: no admin → setup code<br/>printed in `docker compose logs web`
  A->>W: /setup: setup code + admin username/password
  W->>DB: local_accounts (scrypt), session cookie, audit
  A->>W: SolarWinds form → "Fetch certificate" / "Test connection"
  W->>DB: pg-boss job setup.swis.cert|test (password sealed with master key)
  K->>O: TLS handshake / SWQL count queries
  K-->>DB: job output (certificate thumbprints, result + plain-language hint)
  W-->>A: result; admin trusts the cert, saves → app_settings (+ NOTIFY mas_events)
  K->>DB: reload settings (LISTEN, 15 s fallback) → rebuild SWIS client
  A->>W: Mapping → "Run discovery" (job) → pick custom properties; Sites; General
  A->>W: Finish → MAS_SETUP_COMPLETE=true
  K->>O: polling starts
```

- **Effective config** = `loadConfig(env, savedSettings)`. The environment wins, then saved
  settings, then the zod defaults. The settings registry
  (`packages/core/src/config/registry.ts`) drives the forms: labels, kinds, sections and
  "advanced" flags.
- **The worker starts with only a database.** It runs in `awaiting_setup` mode, and it
  answers wizard jobs as soon as a connection exists. It only polls once
  `MAS_SETUP_COMPLETE=true`, or immediately when Orion credentials come from the
  environment (IaC and CI). Invalid saved settings are rejected on save. If invalid values
  get in anyway, the worker keeps the last good config and reports the problem.
- **The web app still never calls SWIS.** Certificate fetch, connection test and discovery
  are pg-boss jobs (`setup.swis.*`) that the worker runs. The server action waits up to 45 to
  120 s for the job's output. Before running, the worker reloads settings, so "use the
  saved connection" means the connection saved a moment ago.
- **Setup-code protection.** Until the first admin exists, `/setup` requires a one-time code
  that only appears in the server log. Being able to reach port 3000 isn't enough to claim
  the installation. Attempts are rate-limited, and the account creation is serialized with
  an advisory lock.
- **Local admin accounts** use scrypt, DB-backed sessions storing only SHA-256 token hashes,
  httpOnly cookies, a 12 h idle and 7 d absolute lifetime, and rate-limited sign-in. They are
  the break-glass path once Entra ID SSO is configured, also from the UI.

## 11. Security & operations

- **No configuration files.** Operator settings are entered in the web UI (setup wizard /
  Settings) and stored in `app_settings`. Secrets are encrypted at rest with AES-256-GCM
  under the master key from the `bootstrap` volume. They are never sent back to the
  browser, and the audit log redacts them. Environment variables (and `X_FILE` Docker
  secrets) still work and take precedence; those fields show as locked in the UI. We ship
  `.env.example` as an optional override list and never commit real values. Teams webhook
  URLs (M4) will be stored the same way, as encrypted settings.
- An `audit_log` row is written for every UI mutation, every kiosk token change, and
  every write-back to Orion.
- **Self-monitoring.** The worker heartbeat is written every 15 s. `/api/health` returns
  503 when the DB is unreachable or the heartbeat is older than 60 s. A worker can't
  report its own death, so we use Docker restart policies, the dashboard banner and wall
  stale banner, and optionally an Orion SAM HTTP monitor on `/api/health`. SolarWinds
  watching the watcher closes the loop. `DEADMAN_PING_URL` is also available.
- Logs are structured JSON (pino), with redaction of `authorization`, passwords and
  webhook URLs.
- **Outbound hosts the VM needs:** Orion `:17774`, `login.microsoftonline.com` (sign-in), `api.anthropic.com`, the Teams Workflows
  host (`*.logic.azure.com` / `*.powerplatform.com`), `api.twilio.com`, `api.pushover.net`,
  and OSM tiles unless `MAP_MODE=image`.

## 12. Key decisions

| Decision                                                          | Why                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drizzle** over Prisma                                           | SQL-first schema in TypeScript, shared by `web` and `worker`, with no query-engine binary, which keeps Docker images small. Migrations are plain, reviewable SQL. Time-series and `ON CONFLICT` upserts with running aggregates are easy to write. It also fits pg-boss, which lives in the same Postgres. |
| **pg-boss** (no Redis)                                            | It is already in Postgres. `stately` queues give non-overlapping polls, `singletonKey` debounces AI jobs, delayed jobs handle escalation, and cron with a time zone runs digests. One fewer service to run.                                                                                                |
| Interval ticks + stately queues for polls                         | pg-boss cron is minute-granular, but alerts need 30 s. Ticks enqueue, and the stately policy deduplicates across replicas.                                                                                                                                                                                 |
| SSE over LISTEN/NOTIFY                                            | Real-time without extra infrastructure. Payloads stay small, and clients refetch over normal authenticated routes.                                                                                                                                                                                         |
| Structured outputs instead of forced tool calls                   | Current Claude models reject forced `tool_choice`. JSON-schema output plus Zod gives the same guarantee.                                                                                                                                                                                                   |
| **Node 22+** (images use Node 24 LTS)                             | Node 20 reached end of life in April 2026. pg-boss 12 and undici 8 require Node ≥ 22.                                                                                                                                                                                                                      |
| TypeScript 5.9 (pinned)                                           | TS 7 (the native compiler) isn't supported yet by typescript-eslint or Next tooling.                                                                                                                                                                                                                       |
| Settings in the DB, encrypted (not `.env`)                        | The requirement is set-up completely online with no config files. Secrets are sealed with a key that lives outside the DB, so a dump alone exposes nothing. Env vars still win for IaC.                                                                                                                    |
| Auth.js v5 (pinned beta) with a per-request config                | v5 is the release built for the App Router, and its lazy configuration lets Microsoft sign-in be set up in the browser (settings in the DB, session key derived from the master key). v4 would need the client secret in an environment variable. Pinned exactly because it is still tagged beta.          |
| Socket peer address via an `http.Server` hook                     | Next.js keeps a client-supplied `X-Forwarded-For`, so without a proxy the real address is lost and IP allowlists would be spoofable. The hook is a few lines in `instrumentation.ts`, needs no custom server, and fails closed (no address) if it is ever not active.                                      |
| Notifications outbox in Postgres, not one pg-boss job per message | The table is both the record the dashboard shows and the queue, so they can never disagree. Retries, backoff and leases are plain columns, and the simulator can drive it on a virtual clock.                                                                                                              |
| Escalations as due-time rows, not delayed jobs                    | Cancelling on ack is an UPDATE; a restart loses nothing; the planner can re-check the incident at fire time; the simulator's virtual clock works.                                                                                                                                                          |
| Shadow mode on by default                                         | A fresh install never pages anyone by surprise. Turning it off is the deliberate go-live step after the pilot.                                                                                                                                                                                             |
| Leaflet over MapLibre                                             | We only need raster OSM and an offline image overlay (`CRS.Simple`). It is lighter and simpler.                                                                                                                                                                                                            |
