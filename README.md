# ExampleHR Time-Off Microservice

A backend microservice that manages the lifecycle of employee time-off requests and keeps per-(employee, location) balances consistent with an external HCM system (Workday/SAP class).

**Repository:** https://github.com/Hooria13/examplehr-timeoff

**Deliverables for review:**

- [`TRD.md`](./TRD.md) — Technical Requirement Document with challenges, architecture, data model, flows, alternatives-considered
- [`apps/examplehr-timeoff`](./apps/examplehr-timeoff) — the microservice under evaluation
- [`apps/mock-hcm`](./apps/mock-hcm) — a realistic HCM simulator used by integration tests (configurable state, fault injection, silent-accept mode)
- Test suite — 100+ tests across unit, service, and full-HTTP integration levels

---

## Quick start

Requires **Node.js 20+** and npm. The project has been developed and tested against Node 24.

### 1. Install

```bash
npm install
```

### 2. Run the tests

```bash
npm test
```

Expected: **14 suites, 109 tests, all passing**. The suite spins up both NestJS apps in-process and exercises real HTTP traffic between them — no external dependencies required.

### 3. Generate a coverage report

```bash
npm run test:cov
```

Coverage is written to `./coverage/`. Open `./coverage/lcov-report/index.html` for the full report. The critical accounting invariant (`effective_available`) and outbox worker are covered at 100%.

### 4. Run the services

In one terminal, start the mock HCM:

```bash
MOCK_HCM_PORT=3001 npm run start -- mock-hcm
```

In a second terminal, start ExampleHR:

```bash
HCM_BASE_URL=http://localhost:3001 PORT=3000 DB_PATH=./data.sqlite npm run start -- examplehr-timeoff
```

ExampleHR listens on `:3000`. The mock HCM listens on `:3001`. Both speak JSON over HTTP.

### 5. Try it

```bash
# Seed a balance in the mock HCM
curl -X POST http://localhost:3001/__test/seed \
  -H 'content-type: application/json' \
  -d '{"records":[{"employeeId":"alice","locationId":"us","balance":10}]}'

# Read balance (acts as employee)
curl http://localhost:3000/balances/alice/us

# Submit a request
curl -X POST http://localhost:3000/time-off/requests \
  -H 'content-type: application/json' \
  -H 'x-user-id: alice' \
  -H 'x-user-role: employee' \
  -d '{"employeeId":"alice","locationId":"us","startDate":"2026-05-01","endDate":"2026-05-02"}'

# Approve (as manager)
curl -X POST http://localhost:3000/time-off/requests/<request-id>/approve \
  -H 'content-type: application/json' \
  -H 'x-user-id: bob' \
  -H 'x-user-role: manager' \
  -d '{}'
```

---

## Architecture at a glance

```
          Employee / Manager HTTP clients
                        │
                        ▼
    ┌─────────────────────────────────────────┐
    │  ExampleHR (apps/examplehr-timeoff)     │
    │  ┌───────────┐  ┌────────────────────┐  │
    │  │ Balances  │  │ Time-Off lifecycle │  │
    │  │ controller│  │  (submit/approve/  │  │
    │  │           │  │   reject/cancel)   │  │
    │  └─────┬─────┘  └─────────┬──────────┘  │
    │        │                  │              │
    │        ▼                  ▼              │
    │  ┌──────────────────────────────────┐   │
    │  │ SQLite: balances, time_off_      │   │
    │  │ requests, hcm_outbox, hcm_sync   │   │
    │  └──────────────────────────────────┘   │
    │        ▲                    ▲           │
    │        │                    │           │
    │  ┌─────┴────────┐   ┌──────┴─────────┐  │
    │  │ OutboxWorker │   │ Reconciliation │  │
    │  │  (every 10s) │   │ Cron (every    │  │
    │  │              │   │  30 min)       │  │
    │  └──────┬───────┘   └────────┬───────┘  │
    └─────────┼────────────────────┼──────────┘
              │                    │
              ▼                    ▼
    ┌─────────────────────────────────────────┐
    │  HCM — mocked via apps/mock-hcm for     │
    │  tests; a real Workday/SAP in prod      │
    └─────────────────────────────────────────┘
```

Core invariant, enforced in every flow:

```
effective_available = hcm_balance − pending_at_hcm − local_holds
```

See [TRD.md §4–§8](./TRD.md) for full detail.

---

## API summary

All lifecycle endpoints require the headers `X-User-Id` and `X-User-Role` (`employee` | `manager` | `admin`). Production would replace this stub with JWT verification — see TRD §10.

### Balances

- `GET /balances/:employeeId/:locationId` → `{ hcmBalance, pendingAtHcm, localHolds, effectiveAvailable, hcmSyncedAt, stale }`. Cold reads block on an HCM fetch; warm reads serve from the local projection; stale reads return the cached value with `stale: true` and trigger a background refresh.

### Health

- `GET /healthz` → `{ ok: true }` — liveness probe, no auth required.
- `GET /readyz` → `{ ok: true, db: 'up', hcm: 'up' | 'degraded' }` — readiness probe. Reports `hcm: 'degraded'` when HCM is unreachable rather than failing entirely (TRD §8 circuit-breaker stance).

### Admin (requires `X-User-Role: admin`)

- `POST /admin/sync/run` — trigger reconciliation immediately
- `POST /admin/outbox/run` — drain the outbox immediately
- `GET /admin/sync/log?limit=…` — recent reconciliation runs
- `GET /admin/outbox?status=…&limit=…` — inspect outbox rows, filter by status

### Time-off lifecycle

- `POST /time-off/requests` — employee submits. Validates, computes days, reserves in `local_holds`. `409` on insufficient balance or overlap.
- `POST /time-off/requests/:id/approve` — manager approves. Re-fetches HCM realtime. Transitions `SUBMITTED → APPROVING`, enqueues `DEDUCT` outbox op. If HCM has independently dropped the balance, auto-rejects with `REJECTED_BY_HCM`.
- `POST /time-off/requests/:id/reject` — manager rejects. Releases `local_holds`.
- `POST /time-off/requests/:id/cancel` — pre-approval: releases holds, status `CANCELLED`. Post-approval: enqueues `REVERSE` outbox op, status `CANCELLATION_REQUESTED` until HCM confirms.
- `GET /time-off/requests/:id` — lookup.
- `GET /time-off/requests?employeeId=…` — list by employee.

### Mock HCM (test fixture only)

Realtime + batch endpoints that mirror what a real HCM would expose:

- `GET /hcm/balance/:employeeId/:locationId`
- `POST /hcm/deduct` / `POST /hcm/reverse` (both accept an `idempotencyKey`)
- `GET /hcm/batch?page=&limit=`

Plus a `/__test/*` control surface for driving the simulator into specific states: `seed`, `reset`, `anniversary`, `yearstart`, `fault`. The `fault` endpoint supports `error500`, `throttle`, `timeout`, and — most importantly for the brief's §3.4 — `silent-accept`, which returns a successful-looking response without actually mutating state.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | examplehr-timeoff HTTP port |
| `MOCK_HCM_PORT` | `3001` | mock-hcm HTTP port |
| `HCM_BASE_URL` | `http://localhost:3001` | where ExampleHR finds HCM |
| `HCM_TIMEOUT_MS` | `5000` | per-request timeout for HCM HTTP calls |
| `HCM_STALE_MS` | `900000` (15 min) | read-path staleness threshold |
| `DB_PATH` | `:memory:` | SQLite file path; in-memory for tests |
| `DB_LOGGING` | `false` | emit TypeORM query logs when `true` |
| `OUTBOX_MAX_ATTEMPTS` | `10` | terminal threshold for outbox retries |

---

## Testing strategy

The brief calls out test rigor as the primary evaluation signal; the suite is structured in four layers:

1. **Pure-function unit tests** — no DB, no network. The accounting invariant, calendar-day calculator, backoff math, fault registry, idempotency logic.
2. **Service-level unit tests** — mocked repositories and clock. Cover staleness branching, HCM 404 vs 5xx handling, effective-available edge cases.
3. **Mock-HCM HTTP integration** — real `MockHcmModule` behind supertest. Covers HTTP contract, idempotency, pagination, fault behaviour (including silent-accept).
4. **Full-stack HTTP integration** — both apps booted in-process; ExampleHR talks to mock-hcm over a real TCP socket. Covers every state-machine transition, the trust-but-verify loop, retry-then-recovery, max-attempts terminal, HCM-drop auto-reject, batch sync drift, and in-flight-key skip.

Named scenarios covered (sampling):

- `submit_happy_path`, `submit_insufficient_balance`, `submit_overlap_rejected`
- `approve_happy_path`, `approve_with_independent_hcm_drop`, `approve_idempotent`
- `outbox_silent_accept_detected`, `outbox_retry_then_recovery`, `outbox_max_attempts_terminal`
- `cancel_pre_approval`, `cancel_post_approval_with_reverse`
- `batch_sync_picks_up_anniversary`, `batch_sync_skips_in_flight`
- `guard_rejects_missing_user_id`, `guard_rejects_employee_approve`

Run `npm run test:cov` for coverage numbers; see TRD §11 for the full testing philosophy.

---

## Project layout

```
.
├── TRD.md                              — Technical Requirement Document
├── apps/
│   ├── examplehr-timeoff/              — the time-off microservice
│   │   ├── src/
│   │   │   ├── app.module.ts
│   │   │   ├── common/                 — clock abstraction, numeric transformer
│   │   │   ├── database/               — TypeORM wiring
│   │   │   └── modules/
│   │   │       ├── balances/           — GET /balances, accounting invariant
│   │   │       ├── time-off/           — submit/approve/reject/cancel state machine
│   │   │       └── hcm/                — HCM client, outbox worker, reconciliation
│   │   └── test/                       — full-HTTP integration tests
│   └── mock-hcm/                       — HCM simulator (realtime + batch + faults)
│       ├── src/
│       │   ├── hcm/                    — store, service, controller
│       │   ├── fault/                  — fault registry, DTOs
│       │   └── test-control/           — /__test/* control surface
│       └── test/                       — mock-hcm HTTP tests
├── package.json
├── tsconfig.json
└── README.md                           — you are here
```

---

## Language note

The HR email specifies "developed using JavaScript." This submission is TypeScript, which compiles to JavaScript and is idiomatic for NestJS. The compiled artifact under `dist/` satisfies the letter of the requirement, and the type system materially contributes to correctness — the state machine and balance arithmetic both benefit from compile-time checking of enum values and numeric transformations. Justification is documented in TRD §12.8.

---

## Known limitations

These are documented in the TRD and left as future work rather than silently cut:

- Header-based authZ is a stub — see [TRD §10](./TRD.md).
- No webhook ingestion from HCM — pull-based sync only. Reasoning in TRD §7.6 and §12.3.
- No accrual / policy engine. HCM owns that; ExampleHR executes against its outputs.
- Single-instance SQLite. PostgreSQL + competing-consumers on the outbox are the production swap — discussed in TRD §12.5.
- No rate limiting or observability backend wired. Gateway + Prometheus/OpenTelemetry in production.

---

## Deliverable checklist

- [x] TRD with challenges, solution, and alternatives analysis (`TRD.md`)
- [x] Working microservice code (`apps/examplehr-timeoff`)
- [x] Mock HCM with simulated balance changes and fault injection (`apps/mock-hcm`)
- [x] Unit, service, and integration test coverage (100+ tests)
- [x] Setup/run instructions (this README)
- [x] Coverage report generated via `npm run test:cov`
