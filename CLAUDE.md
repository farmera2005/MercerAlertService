# CLAUDE.md: MercerAlertService conventions

An internal tool for Mercer Landmark IT. It reads SolarWinds Orion through SWIS,
correlates alerts into incidents, notifies Teams/SMS/push, and serves a dashboard and
NOC wall. Read `docs/architecture.md` first. `docs/schema.md`, `docs/swql-queries.md` and
`docs/open-questions.md` are the other design references.

## Commands

```bash
pnpm install                 # Node ≥ 22.12, pnpm 10 (corepack enable)
pnpm dev:db                  # start a local Postgres (docker) or point DATABASE_URL at one
pnpm db:migrate              # apply migrations
pnpm db:seed                 # placeholder divisions/sites/seasons (idempotent)
pnpm dev:mock-swis           # mock SWIS on :17774 (synthetic Mercer-like world)
pnpm dev:worker              # worker with tsx watch
pnpm dev:web                 # Next.js dev server on :3000
pnpm lint && pnpm typecheck && pnpm test   # must pass before every commit
pnpm test:integration        # needs DATABASE_URL_TEST (a throwaway database)
pnpm db:generate             # after editing packages/db/src/schema/* → new SQL migration
pnpm swis:discover           # list entities/fields/custom properties on a real Orion
docker compose up -d         # full stack; add --profile dev for mock-swis
```

## Non-negotiable rules

1. **No device polling.** All device data comes from SWIS. **No polling in Next.js**:
   `apps/web` only reads the DB, writes config and actions, and serves SSE. Background
   work belongs in `apps/worker`.
2. **Deterministic first.** Incident creation, grouping, priority and delivery decisions
   live in `packages/core` as pure, unit-tested functions. AI output may only _enrich_
   (titles and summaries) or _suggest_ (±1 priority level, clamped by guardrails in code).
3. **AI is never on the critical path.** Every AI call has a timeout, runs in its own
   job, and has a templated fallback. Nothing waits on Claude before a notification goes out.
4. **SWQL lives only in `packages/swis/src/queries.ts`.** Every column gets an explicit
   alias, and every value is a bound `@param`. The only exceptions are validated
   integers in `WITH ROWS` and regex-validated identifiers. Update
   `docs/swql-queries.md` in the same commit.
5. **Never call `rejectUnauthorized: false`** except through the
   `SWIS_TLS_INSECURE_SKIP_VERIFY_DEV_ONLY` path in `packages/swis/src/tls.ts`.
6. **Store transitions, not polls.** Only a complete, successful fetch may delete or
   clear mirror rows. A failed or partial poll changes nothing except `poller_state`.
7. **Secrets** come only from env or `*_FILE` (Docker secrets), via
   `packages/core/src/config`. Never log them, never store webhook URLs in the DB, never
   commit `.env`.
8. **Audit every mutation** that a user or kiosk triggers, using `writeAudit()` from
   `@mercer/db`, in the same transaction as the change.
9. **The AI chat gets read-only, typed tools only.** It never gets raw SQL and never
   calls SWIS. Answers cite incident or node IDs.

## Code conventions

- TypeScript strict, ESM (`"type": "module"`), `moduleResolution: Bundler`. Workspace
  packages export their TS source (`@mercer/core`, `@mercer/db`, `@mercer/swis`, …). The
  worker is bundled with tsup. Next.js uses `transpilePackages`.
- Validate at every boundary with **Zod**: env, SWIS rows, AI output, API route bodies
  and SSE payloads. Infer types from schemas (`z.infer`) rather than duplicating them.
- **Logging:** use `createLogger('component')` from `@mercer/core`, which is pino with
  JSON output and secret redaction. No `console.log` outside scripts. Log objects first:
  `log.info({ poller, rows }, 'poll ok')`.
- **Time:** always store `Date` or `timestamptz` in UTC. Use `@mercer/core/time` helpers
  for business-hours and season math in `APP_TIMEZONE`. Never use the server's local
  time zone.
- **DB:** Drizzle query builder through repository functions in `packages/db/src/repo/*`.
  Use raw `sql` only inside `packages/db`. Multi-row writes are batched
  (`insert … onConflictDoUpdate`). Wrap snapshot replacement and its transitions in one
  transaction.
- **Migrations:** edit the schema and run `pnpm db:generate`, then commit the generated
  SQL. **Never edit a migration that has been merged.** Add a new one instead. CI fails if the schema and migrations drift. Import the migrator from `@mercer/db/migrate`, not the package root, so Next.js never bundles it.

- **Errors:** throw typed errors (`SwisHttpError`, `SwisSchemaError`, `CircuitOpenError`,
  …). Job handlers let errors propagate so pg-boss retries them, and record the failure in
  `poller_state` or `notifications`.
- **Naming:** files use `kebab-case.ts`, types use `PascalCase`, DB columns use
  `snake_case`, and TS fields use `camelCase`. Queue names are dotted (`swis.poll.alerts`).
- **Tests:** Vitest, colocated as `*.test.ts`. Integration tests are `*.int.test.ts` and
  are skipped unless `DATABASE_URL_TEST` is set. Correlation, scoring, guardrails and
  routing changes need tests. Scenario tests in `tools/simulator` assert incident counts,
  priorities and routing.
- **UI:** Tailwind + shadcn/ui, dark theme by default, and wall views must be readable
  from across the room (≥ 28px body text, WCAG AA contrast). Charts use Recharts, and the
  map uses Leaflet.
- Keep comments for _why_, not _what_. Business terms ("scales at Rockford elevator")
  belong in prompts and templates, not hard-coded in logic. Use the site profile and
  role mapping for those.

## Domain glossary

- **Site Profile:** a row in `sites`: division, tier (critical/high/standard),
  harvest-critical flag, business hours, owner group.
- **Division:** corporate, grain, agronomy, feed, energy, mps_feed, heartland_feed. The
  last two are affiliates.
- **Device role:** firewall (FortiGate WAN edge), core_switch, switch, router,
  access_point, server, scale_system (CompuWeigh), ups, other.
- **Transition:** a stored state change (alert raised/cleared/retriggered/acked, a
  node or interface status change, or SWIS source down/up).
- **Noise ratio:** raw alert raises ÷ incidents opened over a window. This is the
  headline metric.
- **Shadow mode:** every outbound message is redirected to one test Teams channel, and
  no paging happens.

## Git

- Branch per milestone or feature. Use Conventional Commits (`feat(swis): …`,
  `fix(core): …`). Each commit must be green on lint, typecheck and test.
- Don't commit `.env`, `secrets/`, `backups/`, or recorded fixtures that haven't been
  through `swis:record`'s sanitizer.
