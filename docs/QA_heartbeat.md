# QA / UAT — Indexing heartbeat (dead-man's-switch)

Covers the change in PR #36: an opt-in `HEARTBEAT_URL` ping that lets an external
monitor alert when the `*/15` GitHub Actions schedule silently stops firing
(the failure mode behind the 2026-05-28 stall).

Scope: `src/utils/heartbeat.ts`, `src/index.ts`, `src/config.ts`,
`.github/workflows/index-listings.yml`.

## Unit tests (automated — `src/__tests__/heartbeat.test.ts`)

| # | Case | Expected |
|---|------|----------|
| U1 | `url` empty | no `fetch` call (no-op) |
| U2 | success status | POST to the base URL |
| U3 | fail status, trailing slash | POST to `<url>/fail` (one slash) |
| U4 | `fetch` rejects | resolves, never throws |
| U5 | regression: request shape | method `POST` + `AbortSignal` (timeout) present |
| U6 | regression: success + trailing slash | never appends `/fail` |

Run: `npm test` (full suite must stay green — 104 tests).

## Functionality tests (manual)

| # | Steps | Expected |
|---|-------|----------|
| F1 | Set `HEARTBEAT_URL` repo secret to a healthchecks.io check URL. Run the workflow via **Actions → Index New Listings → Run workflow**. | Run completes; the check flips to "up" (a ping was received). |
| F2 | Trigger a run that throws (e.g. temporarily set a bad `SUPABASE_URL`). | `<url>/fail` is pinged; monitor records a failure ping; job exits non-zero. |
| F3 | Leave `HEARTBEAT_URL` unset. | Run behaves exactly as before; no ping; no error. |

## Regression tests

| # | Risk | Check |
|---|------|-------|
| R1 | Heartbeat breaks a real run | Network failure / timeout to the monitor must not fail the job (U4 + 5s `AbortSignal`). |
| R2 | Writer path unchanged | Indexer still writes `indexing_events` directly via service role; IndexNow/Google behaviour unchanged (existing suites green). |
| R3 | Kill-switch path | With `INDEXING_ENABLED!="true"` the run still early-exits without pinging (no success ping on a gated run). |

## UAT (acceptance)

- **Given** the schedule stops firing, **when** the grace window elapses, **then**
  the monitor alerts the operator (no longer silent for days).
- **Given** a normal run, **when** it completes, **then** the monitor stays green
  and no operator action is needed.
