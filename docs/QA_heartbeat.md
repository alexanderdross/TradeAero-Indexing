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

---

## Silent-failure alert (completed-but-failing runs)

Extends the dead-man's-switch: the heartbeat catches "the job didn't run", this
catches "the job ran but a channel rejects every URL" (the Apr 5–20 IndexNow 403
episode). `submitPendingEvents` accumulates `hardFailures` (auth/bad-request 4xx,
excluding 429); `isRunUnhealthy(stats, threshold)` flips a *completed* run to a
`/fail` ping when `hardFailures / attempted ≥ INDEXING_FAILURE_ALERT_THRESHOLD`
(default 0.5).

Scope: `src/jobs/submit.ts` (`isHardFailure`, `hardFailures`),
`src/utils/heartbeat.ts` (`isRunUnhealthy`), `src/index.ts`, `src/config.ts`.

### Unit tests (automated)

| # | Case | Expected |
|---|------|----------|
| U7 | `submit`: IndexNow 200 batch | `hardFailures = 0` |
| U8 | `submit`: IndexNow 429 batch | failed, but `hardFailures = 0` (transient) |
| U9 | `submit`: IndexNow 403 batch | `hardFailures = batch size` (the 403 episode) |
| U10 | `isRunUnhealthy`: 0 attempts (idle) | `false` |
| U11 | `isRunUnhealthy`: all success | `false` |
| U12 | `isRunUnhealthy`: 10 google quota-429s + 10 indexnow ok | `false` (429 not hard) |
| U13 | `isRunUnhealthy`: one channel hard-failed (50%) | `true` |
| U14 | `isRunUnhealthy`: 1 hard failure among ~200 ok | `false` |

### Functionality tests (manual)

| # | Steps | Expected |
|---|-------|----------|
| F4 | With `HEARTBEAT_URL` set, force a whole-channel 4xx (e.g. wrong `INDEXNOW_API_KEY`) on a run with pending events. | Run completes (exit 0), logs a WARN, pings `<url>/fail`; monitor records a failure. |
| F5 | Normal run where Google hits its daily quota (many 429s). | Pings success — quota 429s do **not** count as hard failures. |

### Regression

| # | Risk | Check |
|---|------|-------|
| R4 | Quota noise | Google 429s must never flip a run unhealthy (U12, F5). |
| R5 | Over-sensitivity | A lone transient failure among many successes must stay green (U14). |
