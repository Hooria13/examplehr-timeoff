# Technical Requirements Document — ExampleHR Time-Off Microservice

**Author:** Hooria
**Date:** 2026-04-24
**Status:** Draft v1
**Scope:** Backend microservice for managing time-off request lifecycle and keeping per-employee per-location balances in sync with an external HCM system (Workday/SAP-class).

---

## 1. Context

ExampleHR is the primary employee-facing interface for requesting time off. The authoritative record of employment data — including time-off balances — lives in an external **HCM** system (Human Capital Management; think Workday or SAP). HCM is the **source of truth**; ExampleHR is a system of engagement that must reflect HCM accurately while remaining responsive and available to end users.

Two user personas drive the requirements:

- **Employee** — wants to see an accurate, current balance and get instant feedback when submitting a request. Tolerates neither "unknown" balances nor approvals that later get overturned.
- **Manager** — approves requests and needs confidence that the data they approve against is valid. A stale or incorrect balance that leads to an overdraft surfaces as a payroll dispute later.

The central difficulty is that **balances can change from two sides**:

1. ExampleHR itself, when an employee's request is approved and a deduction is pushed to HCM.
2. HCM independently — work-anniversary refreshes, year-start resets, manual HR adjustments, or deductions originating from other systems integrated with HCM.

Naïve synchronisation (e.g., read-through / write-through on every request) is not viable because HCM is latency-sensitive, rate-limited, subject to outages, and — critically per the brief — may silently accept requests that should have been rejected.

---

## 2. Goals and Non-Goals

### Goals

- Manage the full lifecycle of a time-off request (submit → approve/reject → cancel) with correct balance accounting.
- Maintain a local projection of HCM balances that is **eventually consistent** with HCM and **safe to read** for UI purposes.
- Integrate with HCM via both the realtime per-(employee, location) API and the batch corpus endpoint.
- Be **defensive against HCM lying or going silent** — i.e., reconcile independently of HCM's error signal.
- Be testable end-to-end without a real HCM: a mock HCM service simulates realistic behavior including independent balance changes.
- Prioritise test rigor as a first-class deliverable (the brief weights this highest).

### Non-Goals

- User authentication/authorisation beyond request-scoped stubs. In production the service would sit behind an identity layer; for this exercise we scope that out and document where the seams are (§10).
- A UI. This is a backend microservice; API consumers may be assumed.
- Multi-tenancy. Implied single-tenant (single ExampleHR deployment talking to a single HCM).
- Time-off policy engine (accrual rules, carryover, min tenure). Policy lives in HCM; this service executes the brief's "per-employee per-location" balance model.
- Horizontal scale-out. SQLite fits the take-home scope; §12.5 documents what would change at production scale.

---

## 3. Challenges (from the brief, with implications)

The brief enumerates four interesting challenges. Each has non-obvious implications on design:

### 3.1 Independent HCM updates

> "ExampleHR is not the only system that updates HCM; on work anniversary or start of year, employees may get a refresh of time-off balances."

**Implication:** The projection cannot be derived purely from ExampleHR's history. It must be **anchored** to whatever HCM says at the last sync, and ExampleHR's in-flight work layered on top. Any attempt to compute availability from "starting balance + our deductions" is wrong — HCM may have changed the starting balance since we last looked.

### 3.2 HCM realtime API

> "HCM provides a realtime API for getting or sending time off values (e.g. 1 day for locationId X for employeeId Y)."

**Implication:** Low-latency per-key reads and writes are available, but we assume they are **expensive** (rate-limited, slow, failure-prone). They should be used on the write path (before approval) but are too costly for every employee-facing read.

### 3.3 HCM batch endpoint

> "HCM provides a batch endpoint that would send the whole corpus of time-off balances (with necessary dimensions) to ExampleHR."

**Implication:** A periodic full-corpus pull can converge the projection and detect drift from independent updates. Batch cadence is a knob — too frequent is wasteful, too rare lets drift accumulate.

### 3.4 HCM may silently accept bad requests

> "We can count on HCM to send back errors... HOWEVER this may not always be guaranteed; we want to be defensive about it."

**Implication:** We cannot trust HCM's happy-path response as proof of success. After an approved deduction is sent, reconciliation must verify the deduction *actually landed* and roll back local accounting if not. This turns the outbox from a one-shot "send and forget" into a two-phase "send, then verify".

---

## 4. Architecture Overview

```
                    +-----------------------------+
                    |   Employee / Manager APIs   |
                    | (REST, request lifecycle)   |
                    +--------------+--------------+
                                   |
                                   v
  +--------------+      +----------+-----------+      +-----------------+
  |  BalancesSvc |<---->|   ExampleHR core     |<---->| Time-Off StateM |
  +------+-------+      |   (NestJS app)       |      +--------+--------+
         |              +----------+-----------+               |
         |                         |                           |
         |                         v                           |
         |              +----------+-----------+               |
         +------------->|  SQLite projection   |<--------------+
                        | balances / requests  |
                        | hcm_outbox / synclog |
                        +----------+-----------+
                                   |
                +------------------+------------------+
                |                                     |
                v                                     v
       +--------+---------+                +----------+----------+
       | HcmClient (realtime)              | HcmBatchSync (cron) |
       +--------+---------+                +----------+----------+
                \                                     /
                 \                                   /
                  v                                 v
                      +-------------------------+
                      |   HCM (external)        |
                      |   — mocked for tests —  |
                      +-------------------------+
```

Two Nest applications live in the monorepo:

- **`apps/examplehr-timeoff`** — the microservice under evaluation.
- **`apps/mock-hcm`** — a separate Nest app implementing a credible HCM simulator: realtime endpoints, batch endpoint, independent update triggers, and fault-injection controls. Used only by tests; not part of the production deployable.

Persistence is **SQLite** via TypeORM, using `better-sqlite3`. The DB file lives on the ExampleHR pod. This choice is justified in §12.5.

---

## 5. Data Model

Four tables. Each column exists for a reason — none are vestigial.

### 5.1 `balances`

| Column           | Type         | Notes |
|------------------|--------------|-------|
| `id`             | uuid PK      | Surrogate. |
| `employee_id`    | text         | HCM's employee identifier. |
| `location_id`    | text         | HCM's location identifier. Composite unique `(employee_id, location_id)`. |
| `hcm_balance`    | decimal(10,2)| Last balance reported by HCM. Units: days (allows half-days). |
| `pending_at_hcm` | decimal(10,2)| Sum of approved deductions sent to HCM but not yet **confirmed landed** via reconciliation. |
| `local_holds`    | decimal(10,2)| Sum of submitted-but-not-approved request days. Reserves capacity locally so concurrent submissions don't oversubscribe. |
| `hcm_synced_at`  | timestamp    | Last successful pull from HCM for this key. Drives staleness policy. |
| `version`        | integer      | Optimistic locking for concurrent approval paths. |

**Invariant:** `effective_available = hcm_balance − pending_at_hcm − local_holds`. This formula is the system's correctness heart; it is unit-tested in isolation and re-asserted after every state transition.

Why three separate columns instead of one "reserved" total? Because each responds to a different event:

- `hcm_balance` changes only when HCM tells us (batch sync or realtime re-fetch).
- `pending_at_hcm` increases on approval-push, decreases when reconciliation confirms HCM applied the deduction (which then lands in `hcm_balance`).
- `local_holds` increases on submission, decreases on approval (moves to `pending_at_hcm`) or on reject/cancel (released).

Collapsing them into a single "reserved" column loses the information needed to reconcile after HCM drops a request silently.

### 5.2 `time_off_requests`

| Column             | Type           | Notes |
|--------------------|----------------|-------|
| `id`              | uuid PK         | Also serves as idempotency key to HCM. |
| `employee_id`     | text            | |
| `location_id`     | text            | |
| `start_date`      | date            | |
| `end_date`        | date            | Inclusive. |
| `days`            | decimal(10,2)   | Canonicalised at submission time (handles half-days, respects working-day policy stub). |
| `status`          | enum            | See §6.1 for the state machine. |
| `submitted_by`    | text            | Employee ID. |
| `decided_by`      | text nullable   | Manager ID. |
| `reason`          | text nullable   | Free text. |
| `decision_notes`  | text nullable   | |
| `created_at`      | timestamp       | |
| `updated_at`      | timestamp       | |

### 5.3 `hcm_outbox`

Durable retry queue for outbound HCM operations.

| Column              | Type        | Notes |
|---------------------|-------------|-------|
| `id`               | uuid PK      | |
| `op`               | enum         | `DEDUCT`, `REVERSE`, `GET_BALANCE`. |
| `payload`          | json         | Op-specific. For `DEDUCT`, includes `request_id` as idempotency key. |
| `status`           | enum         | `PENDING`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `CONFIRMED`. `CONFIRMED` is distinct from `SUCCEEDED` — see §7.5. |
| `attempts`         | integer      | |
| `next_attempt_at`  | timestamp    | Exponential backoff with jitter. |
| `last_error`       | text nullable| |
| `created_at`       | timestamp    | |
| `updated_at`       | timestamp    | |
| `correlation_id`   | text         | Links to `time_off_requests.id` where applicable. |

### 5.4 `hcm_sync_log`

Audit trail of batch reconciliations.

| Column          | Type      | Notes |
|-----------------|-----------|-------|
| `id`           | uuid PK    | |
| `started_at`   | timestamp  | |
| `finished_at`  | timestamp nullable | |
| `records_seen` | integer    | |
| `drift_count`  | integer    | Keys where HCM disagreed with local projection. |
| `status`       | enum       | `RUNNING`, `COMPLETED`, `FAILED`. |
| `error`        | text nullable | |
| `summary`      | json       | Per-key drift details for debugging. |

---

## 6. API Surface (REST)

All endpoints are JSON over HTTPS in production; `application/json` and HTTP in dev.

### 6.1 Time-off request lifecycle

- `POST /time-off/requests` — employee submits.
  - Body: `{ employeeId, locationId, startDate, endDate, reason? }`
  - Effect: validates, computes `days`, **reserves capacity** by adding to `local_holds`, returns `SUBMITTED`. Rejects with `409 INSUFFICIENT_BALANCE` if `effective_available < days`.
- `POST /time-off/requests/:id/approve` — manager approves.
  - Effect: re-fetches HCM realtime for freshness; if still available, transitions to `APPROVING`, moves days from `local_holds` to `pending_at_hcm`, enqueues a `DEDUCT` outbox op. Idempotent on the request ID.
- `POST /time-off/requests/:id/reject` — manager rejects.
  - Effect: releases `local_holds`, status `REJECTED`.
- `POST /time-off/requests/:id/cancel` — employee (if not yet approved) or manager.
  - Effect: pre-approval → release `local_holds`. Post-approval → enqueue `REVERSE` outbox op, status `CANCELLATION_REQUESTED` → `CANCELLED` after HCM confirms.
- `GET /time-off/requests/:id` — lookup.
- `GET /time-off/requests?employeeId=…` — list.

### 6.2 Balances

- `GET /balances/:employeeId/:locationId` — returns `{ hcmBalance, pendingAtHcm, localHolds, effectiveAvailable, hcmSyncedAt, stale }`. Serves from projection if fresh; triggers background refresh if stale (§8).

### 6.3 Admin / observability

- `POST /admin/sync/run` — kick a batch sync on demand. Idempotent via run ID.
- `GET /admin/sync/log?limit=…` — inspect recent sync runs.
- `GET /admin/outbox?status=…` — inspect the outbox.
- `GET /healthz` — liveness.
- `GET /readyz` — DB + mock HCM reachability.

### 6.4 State machine for `time_off_requests.status`

```
SUBMITTED ──approve──▶ APPROVING ──outbox-confirmed──▶ APPROVED
    │                      │
    │                      ├── outbox-rejected-by-hcm ──▶ REJECTED_BY_HCM
    │                      │          (release holds)
    │                      │
    │                      └── verification-ambiguous ──▶ INDETERMINATE
    │                                 (requires reconciliation)
    ├──reject───────▶ REJECTED
    ├──cancel───────▶ CANCELLED
    └──N days elapsed, no decision──▶ EXPIRED (release holds)

APPROVED ──cancel──▶ CANCELLATION_REQUESTED ──outbox-confirmed──▶ CANCELLED
```

**State notes:**

- `APPROVING` is an intentional intermediate state: the request has been manager-approved locally, capacity is moved from `local_holds` to `pending_at_hcm`, but HCM has not yet confirmed the deduction landed. An employee polling during this window sees `APPROVING`, not `APPROVED` — truth in UI.
- `INDETERMINATE` is entered when the trust-but-verify loop (§7.5) gets an ambiguous answer from HCM — e.g., the deduct returned 200 but the follow-up `GET_BALANCE` timed out, so we can neither confirm nor deny. These are picked up by the next batch reconciliation (§7.6) which has the authoritative corpus view to resolve them.
- `EXPIRED` auto-cancels requests that sit in `SUBMITTED` past a configurable window (default 14 days). Holds are released. Prevents stale holds from starving an employee's future submissions if a manager never acts.

---

## 7. Key Flows

### 7.1 Submit

1. Validate payload (date order, non-overlap with existing SUBMITTED/APPROVED/APPROVING requests for same employee).
2. Canonicalise `days`.
3. Load balance row with row-level lock (SQLite `BEGIN IMMEDIATE`).
4. Compute `effective_available`; reject with 409 if insufficient.
5. Insert request row `status=SUBMITTED`.
6. Increment `balances.local_holds += days`, bump `version`.
7. Commit.

### 7.2 Approve

1. Load request; reject if not `SUBMITTED`.
2. Call `HcmClient.getBalance(employeeId, locationId)` to **re-fetch realtime**. This is the write-path freshness requirement. Update `hcm_balance` and `hcm_synced_at` if the returned value differs.
3. Recompute `effective_available`; if HCM has independently decreased the balance such that the request no longer fits, auto-reject with `REJECTED_BY_HCM` and release `local_holds`.
4. Otherwise: `local_holds -= days`, `pending_at_hcm += days`, request status `APPROVING`, enqueue `DEDUCT` outbox op with `correlation_id = request.id`.
5. Commit. Outbox worker picks it up (§7.5).

### 7.3 Reject

Status → `REJECTED`, `local_holds -= days`. Single transaction.

### 7.4 Cancel (pre-approval vs post-approval)

- Pre-approval (`SUBMITTED`): status `CANCELLED`, `local_holds -= days`.
- Post-approval (`APPROVED`): status `CANCELLATION_REQUESTED`, enqueue `REVERSE` outbox op. `pending_at_hcm` does **not** change yet — funds are still deducted at HCM until reversal lands. On confirmation, `hcm_balance += days`, status `CANCELLED`.

### 7.5 Outbox worker (the defensive loop)

A Nest `@Cron` job polls `hcm_outbox` every N seconds. For each `PENDING` row whose `next_attempt_at <= now`:

1. Transition `PENDING → IN_FLIGHT` with optimistic lock on `attempts`.
2. Call the HCM op (e.g., `POST /hcm/deduct` with idempotency key).
3. On HTTP success:
   - Mark `SUCCEEDED` (**not** `CONFIRMED` yet).
   - Trust-but-verify: issue `GET_BALANCE` for the same key (inline or enqueued). If the balance now reflects the deduction (within tolerance), mark `CONFIRMED`, update `balances.hcm_balance -= days`, `balances.pending_at_hcm -= days`, transition request `APPROVING → APPROVED`.
   - If verification shows HCM did *not* apply the deduction (the silent-accept case from §3.4), mark outbox row `FAILED_TERMINAL`, transition request to `REJECTED_BY_HCM`, release `pending_at_hcm` (return the days to nothing — HCM never took them).
   - If verification is *ambiguous* (the `GET_BALANCE` itself times out or returns a value that can be explained by either outcome — e.g., a concurrent anniversary bump landed between deduct and verify), transition the request to `INDETERMINATE`. The next batch reconciliation (§7.6) has the full corpus view and can resolve ambiguity deterministically.
4. On retryable error (5xx, timeout, 429): increment `attempts`, set `next_attempt_at = now + backoff(attempts)`, status `FAILED_RETRYABLE`. Eligible for re-pickup next tick.
5. On terminal error (4xx business rejection from HCM): status `FAILED_TERMINAL`, transition request to `REJECTED_BY_HCM`, release `pending_at_hcm`.
6. If `attempts >= MAX_ATTEMPTS`: status `FAILED_TERMINAL`, emit an alert. Human operator can inspect via `GET /admin/outbox`.

Backoff: exponential with full jitter, capped at 5 minutes. `MAX_ATTEMPTS` defaulted to 10 — configurable.

### 7.6 Batch reconciliation (cron)

**Pull, not push.** The reconciliation loop polls HCM's batch endpoint on a cron schedule rather than accepting webhook pushes from HCM. This is a deliberate choice: pull is deterministic for the test suite (tests advance simulated time and trigger a run themselves, with no race against an inbound HTTP event), introduces no new inbound surface area to secure, and keeps the failure mode one-directional (HCM down = we stop pulling and retry; vs. HCM webhook delivery failing silently while we think we're in sync). Webhooks are a reasonable future extension (§12.3) if HCM supports them and the latency win matters.

Cadence: every 15 minutes (configurable). For each run:

1. Insert `hcm_sync_log` row `status=RUNNING`.
2. Call HCM batch endpoint, page through corpus.
3. For each `(employee_id, location_id, hcm_balance)`:
   - Upsert local `balances` row.
   - If local `hcm_balance` differs and there is no in-flight outbox op for this key, record drift and apply HCM's value.
   - If there *is* an in-flight op, skip overwriting — reconciliation for that key happens through the outbox loop (§7.5). Log it under drift to aid debugging.
4. Update `hcm_synced_at` for all seen keys.
5. Mark sync run `COMPLETED`.

Key point: reconciliation **never rewrites `local_holds`**. Holds are ExampleHR-local state and have no HCM counterpart.

### 7.7 Independent HCM update propagation

Anniversary bonus scenario:

- T₀: HCM shows 10 days. Local projection has `hcm_balance=10`, `local_holds=0`, `pending_at_hcm=0`.
- T₁: HCM independently adds 5 days (anniversary). Local projection unchanged.
- T₂: Employee views balance. Projection is >15min old (stale), triggers background refresh. Meanwhile returns stale value with `stale: true` flag. Next tick or the refresh pulls `hcm_balance=15`.
- T₃: Batch sync runs, confirms `hcm_balance=15`, no drift this time.

Correct behavior without manual intervention.

---

## 8. Consistency and Staleness Policy

- **Read path** (`GET /balances/...`): serve from projection. If `hcm_synced_at > 15min old`, trigger an async realtime refresh and include `stale: true` in the response. Do NOT block the read.
- **Write path** (approve, post-approval cancel): always call HCM realtime to refresh the anchor before the transition. Blocks until HCM responds or times out (circuit-breaker with fallback below).
- **Batch path**: every 15min, independent of user activity.

**Circuit breaker:** If realtime HCM is unreachable during an approval, the system enters a degraded mode: approvals are accepted using projection as anchor (documented limitation, logged, surfaced in response). The outbox handles the eventual push. Alternative — rejecting approvals during HCM outage — is documented in §12.2 as considered-and-rejected.

---

## 9. Failure Modes and Defensive Design

| Failure | Detection | Mitigation |
|---------|-----------|------------|
| HCM returns 5xx on deduct | HTTP status | Outbox retry with backoff |
| HCM times out on deduct | Request timeout | Treat as retryable; idempotency key on retry |
| HCM returns 200 but does not apply (silent accept) | Post-op `GET_BALANCE` verification | Mark `FAILED_TERMINAL`, release `pending_at_hcm`, transition to `REJECTED_BY_HCM` |
| HCM batch endpoint paginated failure | Per-page errors | Resume from last-successful page; full run marked `FAILED` if unrecoverable |
| Local DB write fails mid-transaction | TypeORM throws | Transaction rolls back; no state change; caller sees 500 |
| Double-submit of same approval | Duplicate POST to `/approve` | Request status check; second call is a no-op returning current state |
| Outbox row picked by two workers (future multi-instance) | Optimistic lock on `attempts` | Second worker's update fails; no double-send |
| Anniversary lands mid-approval | Realtime refresh on approve | Covered in §7.2 step 3 |
| Clock skew between ExampleHR and HCM | Minor timestamp drift | Timestamps in log are for audit only; no business logic branches on them |

---

## 10. Security Considerations

Documented even though full authentication is out of scope for this exercise — the seams matter.

- **AuthN/AuthZ seam:** All request lifecycle endpoints assume a `userId` and role (`employee`, `manager`) supplied by an upstream identity layer (API gateway, service mesh, etc.). The submission implements this as a header-based stub (`X-User-Id`, `X-User-Role`) for testability. Real deployment would replace with JWT verification or mTLS.
- **Authorisation rules** (enforced in controllers):
  - Employees may submit/cancel their own requests and view their own balance.
  - Managers may approve/reject requests for their reports (report-of relationship is out of scope; stubbed).
  - Admin endpoints (`/admin/*`) require an `admin` role.
- **HCM credentials:** mocked. Production would use secret manager (AWS Secrets Manager, Vault); never env vars in plain text.
- **Input validation:** `class-validator` on all DTOs. Reject dates outside plausible range (guard against year 9999 overflow etc.).
- **SQLi:** TypeORM parameterised queries everywhere; no raw SQL concatenation.
- **Rate limiting:** Out of scope for the exercise; in production would be at the gateway layer.
- **PII in logs:** employee IDs are logged (necessary for debugging); no names, emails, or free-form `reason` fields in structured logs.
- **Idempotency keys (request IDs):** client-generated or server-generated? Server-generated on `POST /time-off/requests`; retries of *submission* use a client-supplied `X-Idempotency-Key` header to deduplicate at the API layer. Retries of outbox ops use the request ID, which is immutable once assigned.

---

## 11. Testing Strategy

The brief weights this as the **primary** evaluation signal. Structure:

### 11.1 Test pyramid

- **Unit tests** — pure logic. Accounting invariant (`effective_available` formula), state machine transitions, backoff math, DTO validation. Fast, no DB, no network.
- **Service-level tests** — `BalancesService`, `TimeOffService`, `OutboxWorker` against an in-memory SQLite and a stubbed `HcmClient`. Covers branching logic without network cost.
- **Integration tests** — full HTTP stack against a real running mock-hcm server, using SuperTest. Covers cross-service orchestration and the real HTTP contract to HCM.
- **Scenario tests** — named end-to-end scenarios that correspond to documented failure modes and business flows (see §11.3).

### 11.2 Mock HCM as a test asset

The mock-hcm app is a **real server**, not a jest mock. It exposes the same realtime and batch APIs as a real HCM plus a **test-control surface** (e.g., `POST /__test/seed`, `POST /__test/anniversary`, `POST /__test/fault`) that lets each test configure behaviour deterministically. Rationale: mocks that echo what the caller did cannot exercise divergence paths. The brief specifically calls out silent-accept as a defensive scenario — only a simulator with controllable state can test it.

### 11.3 Scenario coverage

Each scenario is a single test name and assertion set:

1. `submit_happy_path` — employee has 10 days, submits 2 days, `local_holds=2`, `effective_available=8`.
2. `submit_insufficient_balance` — employee has 2 days, submits 3, returns 409.
3. `approve_happy_path` — approve → outbox dispatches → HCM accepts → CONFIRMED → hcm_balance decrements.
4. `approve_with_independent_hcm_drop` — between submit and approve, HCM loses 3 days to an anniversary reset; approval auto-rejects with `REJECTED_BY_HCM`.
5. `approve_with_hcm_silent_accept` — HCM returns 200 but does not apply; post-verify detects; outbox `FAILED_TERMINAL`, request `REJECTED_BY_HCM`, `pending_at_hcm` released.
6. `approve_with_hcm_5xx_then_recovery` — outbox retries 3 times with backoff, 4th succeeds.
7. `approve_double_submit` — two POSTs to `/approve` for same request; second is idempotent no-op.
8. `reject_releases_holds` — submit + reject → `local_holds` back to 0.
9. `cancel_pre_approval` — releases holds.
10. `cancel_post_approval` — enqueues REVERSE, confirmed, `hcm_balance` restored.
11. `batch_sync_picks_up_anniversary` — HCM gains 5 days via anniversary; batch sync run reflects it locally.
12. `batch_sync_skips_in_flight_keys` — key has pending outbox op; batch sync does not overwrite.
13. `concurrent_submissions` — two submissions racing for last 2 days of 3-day balance; exactly one wins.
14. `stale_read_served_with_flag` — balance last synced 20min ago; GET returns stale=true and triggers refresh.
15. `fresh_read_not_refreshed` — synced 5min ago; GET returns stale=false, no refresh triggered.

### 11.4 Coverage target

Line + branch coverage ≥ 85%, with the accounting invariant and outbox worker at 100%. Report generated via `jest --coverage` and included in the submission.

---

## 12. Alternatives Considered

### 12.1 Passthrough architecture (no local projection)

Every read and write hits HCM realtime. **Rejected** because: HCM latency propagates to every employee balance view; rate limits make the employee dashboard fragile; HCM downtime makes ExampleHR unusable; nothing in the design prevents the silent-accept failure mode.

### 12.2 Hard-fail approvals during HCM outage

When HCM realtime is down, refuse to approve rather than accept-and-enqueue. **Rejected** because: a multi-hour HCM outage would block payroll-critical workflows; the outbox + verification loop already gives us eventual consistency; approvals during outage are surfaced to the manager with a warning rather than hidden. Documented trade-off: during outage, a manager may approve a request that HCM later rejects; the system detects this and surfaces `REJECTED_BY_HCM`. The alternative — blocking the manager — is worse UX for a rarer failure.

### 12.3 Event-driven sync (webhooks from HCM)

HCM pushes changes to ExampleHR instead of (or in addition to) the batch pull. **Rejected** because: the brief specifies the realtime + batch APIs and does not mention webhooks; introducing them expands surface area without observable user benefit in this scope. Noted as a future extension in §14.

### 12.4 External message broker (Kafka/RabbitMQ) for the outbox

**Rejected** because: SQLite with `hcm_outbox` is already durable and transactional with the business write; a broker would require two-phase commit semantics (dual-write) or an additional outbox-to-broker relay. For single-node scope, pure DB outbox is simpler and arguably more correct.

### 12.5 PostgreSQL instead of SQLite

PG gives us proper concurrency, replication, schema migrations. **Rejected for this submission** because: the brief specifies SQLite; take-home scope does not need concurrent writers from multiple ExampleHR instances. At production scale we would move to PG, and the design transfers — the only code changes would be the TypeORM driver config and replacing `BEGIN IMMEDIATE` with `SELECT FOR UPDATE`.

### 12.6 Single `reserved` column instead of `pending_at_hcm` + `local_holds`

Simpler schema, but loses the information needed to reconcile after silent-accept (we would not know whether to return days to `hcm_balance` or just cancel the reserve). **Rejected** — correctness cost outweighs simplicity gain.

### 12.7 GraphQL instead of REST

The brief allows either. **Chose REST** for simplicity of mocking HCM (which is a REST concept in the brief), for the familiarity of HTTP status codes in the outbox HTTP contract, and to avoid the GraphQL schema being another thing for evaluators to read. GraphQL would be a reasonable swap and is noted in §14.

### 12.8 Pure JavaScript vs TypeScript

Email says "developed using JavaScript." **Using TypeScript** because: NestJS is idiomatic in TS, the type system catches state-machine and accounting bugs at compile time (directly relevant to the brief's correctness goals), and TypeScript compiles to JavaScript — the compiled artefact satisfies the letter of the requirement. This choice is explicit so evaluators see it as judgement, not oversight.

---

## 13. Observability

Though this is a take-home, observability scaffolding is present because several failure modes are only debuggable with it:

- Structured JSON logs (Nest's logger, extended with correlation IDs from request ID).
- Every outbox state change is a log event.
- Every batch sync run is a log event plus `hcm_sync_log` row.
- Log levels: `debug` per request, `info` per state change, `warn` per retry, `error` per terminal failure.
- `GET /healthz` and `GET /readyz` for k8s-style probes.

Metrics and traces would be added in production (Prometheus + OpenTelemetry); scaffolding stubbed but not wired.

---

## 14. Open Questions and Future Work

- **Webhook integration with HCM** — §12.3, would reduce staleness window to seconds rather than minutes.
- **Multi-instance ExampleHR** — move SQLite to PostgreSQL, outbox worker would need leader election or competing-consumers coordination.
- **Accrual engine** — currently out of scope; in reality ExampleHR would not manage accrual (HCM does) but would surface upcoming accruals to the employee.
- **Partial-day requests** — schema supports `decimal(10,2)` but the policy layer (what counts as half a day) is stubbed.
- **Timezone handling** — request dates are stored as `DATE` without TZ; production would need per-location TZ.
- **Audit log for compliance** — the `hcm_sync_log` is debug-level, not a compliance audit log. A production deployment would need tamper-evident request-lifecycle audit.

---

## 15. Glossary

- **ExampleHR** — the time-off microservice being built.
- **HCM** — Human Capital Management system (Workday/SAP-class). Source of truth.
- **Projection** — local SQLite copy of HCM balances, kept eventually consistent.
- **Outbox** — durable queue of outbound HCM operations with retry state.
- **Realtime API** — HCM's per-(employee, location) endpoint.
- **Batch endpoint** — HCM's full-corpus balance dump.
- **Effective available** — `hcm_balance − pending_at_hcm − local_holds`, the number a manager sees and decides against.
- **Local holds** — submitted-but-not-approved days reserved on the projection.
- **Pending at HCM** — approved days sent to HCM but not yet confirmed landed.
- **Drift** — disagreement between projection and HCM detected during sync.
- **Silent accept** — HCM returns success but does not apply the deduction; the brief's signature failure mode.
