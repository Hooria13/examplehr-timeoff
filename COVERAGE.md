# Test Coverage Report

**Reproduce:** `npm run test:cov` — writes full HTML report to `./coverage/`, then open `./coverage/lcov-report/index.html`.

**Last captured:** 2026-04-24 against commit on `master`. 14 suites, **102 tests**, all passing.

## Summary

| Scope | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| **All files** | **91.19%** | **73.68%** | **90.76%** | **91.45%** |

## Per-module

### Critical correctness paths (100% across the board)

| File | Stmts | Branch | Func | Lines |
|---|---:|---:|---:|---:|
| `modules/balances/balance-accounting.ts` | 100 | 100 | 100 | 100 |
| `modules/hcm/backoff.ts` | 100 | 100 | 100 | 100 |
| `modules/time-off/days-calculator.ts` | 100 | 100 | 100 | 100 |
| `mock-hcm/src/fault/fault.service.ts` | 100 | 100 | 100 | 100 |

### High-coverage domain logic

| File | Stmts | Branch | Func | Lines |
|---|---:|---:|---:|---:|
| `modules/balances/balances.service.ts` | 95 | 82 | 83 | 97 |
| `modules/balances/balances.controller.ts` | 100 | 83 | 100 | 100 |
| `modules/time-off/time-off.service.ts` | 91 | 72 | 100 | 95 |
| `modules/time-off/time-off.controller.ts` | 100 | 75 | 100 | 100 |
| `modules/time-off/actor.guard.ts` | 96 | 87 | 100 | 95 |
| `modules/hcm/hcm.client.ts` | 93 | 77 | 100 | 93 |
| `modules/hcm/outbox.service.ts` | 80 | 59 | 85 | 80 |
| `modules/hcm/reconciliation.service.ts` | 97 | 75 | 100 | 98 |

### Mock-HCM

| File | Stmts | Branch | Func | Lines |
|---|---:|---:|---:|---:|
| `mock-hcm/src/hcm/hcm.service.ts` | 92 | 81 | 80 | 93 |
| `mock-hcm/src/hcm/hcm.controller.ts` | 100 | 75 | 100 | 100 |
| `mock-hcm/src/hcm/hcm.store.ts` | 96 | 50 | 100 | 96 |
| `mock-hcm/src/test-control/test-control.controller.ts` | 94 | 75 | 75 | 94 |

### Entry points and glue (unexercised by tests, not business logic)

- `main.ts` in both apps — 0% (bootstrap code; exercised manually / in production)
- `hcm.workers.ts` — 57% (thin `@Cron` wrappers; the underlying `OutboxService` and `ReconciliationService` are tested directly with timing control)

## Test suite shape

- **4 pure-function unit suites**: accounting invariant, backoff math, days calculator, fault registry — no DB, no network
- **3 service-level suites**: `BalancesService` with mocked repo/clock, `HcmService` and `FaultService` in mock-hcm
- **4 HTTP integration suites**: `mock-hcm` end-to-end, `/balances` end-to-end against live mock-hcm, `/time-off` full state machine against live mock-hcm, outbox worker with trust-but-verify, reconciliation cron with drift/in-flight detection
- **2 scaffold suites**: default controller specs retained for the baseline app entry points
- **1 e2e scaffold**: the Nest-default app.e2e-spec
