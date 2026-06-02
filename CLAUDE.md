# TradeAero Indexing - Codebase Reference

## Overview

Standalone Node.js/TypeScript service that auto-submits newly published TradeAero listings to search engine indexing APIs. Runs every 30 minutes via GitHub Actions.

**What it does:**
- Detects listings that became active and fully translated (all 14 locale slugs populated) within the lookback window
- Builds all 14 locale URLs per listing
- Submits URLs in batch to **IndexNow** (covers Bing, Yandex, Seznam, Naver)
- Submits URLs to the **Google Indexing API** via a service account (falls back to a sitemap ping only when no service account is configured)
- Records all attempts in the `indexing_events` Supabase table with retry/backoff logic
- Exposes data to the admin dashboard via `/api/admin/indexing` in TradeAero-Refactor

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript 5.7, ES modules
- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service role key bypasses RLS)
- **HTTP**: Native `fetch` (no extra HTTP client)
- **Scheduling**: GitHub Actions cron every 30 minutes + `workflow_dispatch`
- **Testing**: Vitest

## Project Structure

```
src/
  index.ts                    # CLI entry: validateConfig -> discoverAndEnqueue -> submitPendingEvents
  config.ts                   # Load + validate env vars into typed config object
  types.ts                    # EntityType, IndexingEvent, NewIndexingEvent, SubmitStats interfaces
  db/
    client.ts                 # Supabase service-role client (singleton)
    listings.ts               # fetchRecentlyPublishedListings() — 4 parallel queries with translation gate
    indexing-events.ts        # upsertIndexingEvent, fetchDueEvents, markEventsAttempted,
                              #   markEventsSuccess, markEventFailed
  channels/
    indexnow.ts               # submitToIndexNow(urls[]) — batch POST to api.indexnow.org
    google.ts                 # submitGoogleEvents() — Google Indexing API (service-account JWT);
                              #   pingGoogleSitemap() — deprecated-endpoint fallback
  jobs/
    discover.ts               # discoverAndEnqueue(): query new listings -> insert pending events
    submit.ts                 # submitPendingEvents(): batch IndexNow + per-event Google Indexing API
    retry.ts                  # computeNextRetryAt(attemptCount): exponential backoff
  utils/
    logger.ts                 # Structured logger with timestamp, level, context
    fetch.ts                  # fetchWithTimeout wrapper
    dedupe.ts                 # computeDedupeKey(entityId, channel): sha256 hex
    url-builder.ts            # buildAllLocaleUrls(entityType, slugs): 14 locale URLs
    heartbeat.ts              # pingHeartbeat() dead-man's-switch + isRunUnhealthy() failure-rate gate
  __tests__/
    url-builder.test.ts       # 56 URL assertions (4 entity types x 14 locales)
    dedupe.test.ts            # Dedupe key stability
    discover.test.ts          # Listing discovery query logic (mocked Supabase)
    retry.test.ts             # Exponential backoff intervals
supabase/
  add_indexing_events_table.sql  # DB migration (run once in Supabase SQL Editor)
  monitoring.sql                 # Read-only health queries (liveness, hard-failure rate, missed listings)
docs/
  indexnow-credentials.md    # How to generate/rotate the IndexNow API key
.github/workflows/
  index-listings.yml          # Cron every 30 min + workflow_dispatch with dry_run input
```

## Commands

```bash
npm run dev        # Run indexer locally (requires .env)
npm run build      # Compile TypeScript to dist/
npm run start      # Run compiled JS (dist/index.js)
npm test           # Run vitest unit tests
npm run test:watch # Run vitest in watch mode
npm run lint       # ESLint
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Service role JWT (bypasses RLS) |
| `INDEXNOW_API_KEY` | Yes | — | Must match content of `public/{key}.txt` in TradeAero-Refactor |
| `INDEXING_LOOKBACK_MINUTES` | No | `60` | How far back to look for new listings |
| `INDEXING_DRY_RUN` | No | `false` | Discover and enqueue but skip external API calls |
| `INDEXNOW_BATCH_SIZE` | No | `100` | Max listings per IndexNow batch |
| `HEARTBEAT_URL` | No | — | Dead-man's-switch URL (healthchecks.io / cronitor). Pinged on a healthy run; `<url>/fail` pinged on a fatal error or a silently-failing run. Unset = no-op. |
| `INDEXING_FAILURE_ALERT_THRESHOLD` | No | `0.5` | Hard-failure ratio (0–1) at/above which a *completed* run pings `<url>/fail` instead of success. Only auth/bad-request 4xx count (excl. 429), so Google quota never trips it. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

## GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `INDEXNOW_API_KEY` | Must match `public/{key}.txt` hosted on trade.aero |
| `HEARTBEAT_URL` | Optional. Dead-man's-switch ping target so an external monitor alerts when this `*/30` schedule silently stops firing (see the 2026-05-28 stall — a schedule that never runs emits no logs and no error). |

## GitHub Actions Workflow

| Workflow | Trigger | Timeout | Concurrency |
|----------|---------|---------|-------------|
| Index New Listings | Every 30 min + manual | 10 min | `group: index-listings`, `cancel-in-progress: false` |

**Manual dispatch inputs:**
- `lookback_minutes` (default: `60`; use `10080` for a 1-week backfill)
- `dry_run` (`false` / `true`)

## Monitoring (heartbeat / dead-man's-switch)

A GitHub-hosted `schedule:` cron can silently stop firing for days (it did,
2026-05-28 → 06-01) — a workflow that never runs emits no logs and no error, so
nothing alerts. The optional `HEARTBEAT_URL` closes that gap: an external monitor
expects a ping on every run and alerts when one doesn't arrive.

**Behaviour** (`src/utils/heartbeat.ts`, wired in `src/index.ts`):
- Successful run → `POST HEARTBEAT_URL`.
- Fatal error → `POST <HEARTBEAT_URL>/fail`.
- Best-effort: 5 s timeout, never throws — monitoring can't fail a run.
- No-op when `HEARTBEAT_URL` is unset. The URL itself is the credential (no
  separate token); store it as a secret.
- The success ping fires only on a *completed* run with `INDEXING_ENABLED="true"`
  — a kill-switched (gated) run early-exits and does **not** ping. Don't point a
  production monitor at a deliberately-disabled environment.
- An **idle** run (no new listings) still completes and pings success, so the
  monitor stays green during quiet windows.

**Silent-failure alert (completed-but-failing runs).** The dead-man's-switch
only catches "the job didn't run". It can't catch a run that *completes* while a
channel rejects every URL — exactly what happened Apr 5–20 (1,436 IndexNow 403
"site not verified" rejections; every run "succeeded", nothing was indexed, no
alert fired). To close that gap, `submitPendingEvents` tracks `hardFailures`
(auth/bad-request 4xx, excluding 429), and `isRunUnhealthy(stats, threshold)`
(`src/utils/heartbeat.ts`) flips a completed run to a `/fail` ping when the
hard-failure ratio ≥ `INDEXING_FAILURE_ALERT_THRESHOLD` (default 0.5).
- **Why 0.5:** every listing enqueues exactly one IndexNow + one Google event,
  so one channel wiping out is ~50% of attempts — 0.5 fires on a full
  single-channel outage but not on isolated transient failures.
- **Google quota 429s never trip it** — they're counted in `googleFailed` but
  not `hardFailures`, so daily-quota exhaustion stays green (it's expected).
- 5xx / network errors are treated as transient (retried), not hard.

**Ad-hoc health checks (`supabase/monitoring.sql`).** Read-only queries for the
Supabase SQL Editor: Q1 liveness/freshness, Q2 channel·status·response_code
breakdown (disambiguates what `skipped` actually means), Q3 hard-failure rate
(mirrors the in-app alert), Q4 retry backlog, and Q5 **missed listings** —
active + fully-translated listings with no `indexing_events` row, the one
discovery-side gap the event table can't show on its own.

**Setup**
1. Create a check at healthchecks.io (or cronitor / Better Stack). Set
   **period 30 min** but a generous **grace ≈ 12 h** (see the cadence note
   below). Copy the ping URL (e.g. `https://hc-ping.com/<uuid>`).
2. Add it as an **Actions secret** named `HEARTBEAT_URL` in
   **Settings → Secrets and variables → Actions** (repository secret; or an
   environment secret if the `index` job is later scoped to a GitHub Environment).
   The workflow already passes `HEARTBEAT_URL: ${{ secrets.HEARTBEAT_URL }}`.
3. (Local) optionally set `HEARTBEAT_URL` in `.env`.

**Verify**
- Manually dispatch the workflow → the check flips to *up*.
- Break a secret and re-run → a `/fail` ping is recorded; restore it.
- Disable the schedule / wait past the grace window → the monitor sends a *down*
  alert (route it via the check's Integrations).

**Cadence note — why grace is hours, not minutes.** GitHub delivers
`schedule:` triggers on a heavily throttled best-effort basis: in practice this
workflow fires only a handful of times a day with gaps of **2–6 h**, not every
30 min (observed 2026-06-01 while on `*/15`: runs at 01:43, 04:00, 09:20, 15:07,
20:48). A tight grace (e.g. 30–60 min) would false-alarm constantly. A ~12 h
grace rides out normal throttling while still catching a genuine multi-day stall
(like 2026-05-28) within half a day. If you ever need near-real-time freshness,
don't lean on the GitHub cron — the Refactor app's publish webhook already
enqueues indexing in real time on publish; the cron is only a slow backstop.

## Main Flow

```
1. validateConfig()          — fail fast if required env vars missing
2. discoverAndEnqueue()      — Phase 1
   a. Query 4 tables in parallel (aircraft, parts, rental, search_requests/wanted)
   b. Translation gate: skip listings with any null slug_* column (not fully translated yet)
   c. Build English canonical URL + all 14 locale URLs per listing
   d. Compute dedupe_key = sha256(entity_id|channel)
   e. Upsert 2 indexing_events rows per listing (indexnow + google), ignoreDuplicates: true
3. submitPendingEvents()     — Phase 2
   a. Fetch all events where status='pending' OR (status='failed' AND next_retry_at <= now())
   b. IndexNow: flatten all submitted_urls from pending indexnow events -> one batch POST
   c. Google: per-event POST to the Indexing API (service account); sitemap-ping fallback if unconfigured
   d. Mark events success/failed/skipped, increment attempt_count, accumulate hardFailures
4. Heartbeat — ping HEARTBEAT_URL (success), or <url>/fail on a fatal error
   OR a completed run whose hard-failure ratio ≥ INDEXING_FAILURE_ALERT_THRESHOLD
```

## Translation Gate

Listings are only indexed after ALL 14 locale slugs are populated. The query filters:

```sql
WHERE status = 'active'
  AND slug_en IS NOT NULL AND slug_de IS NOT NULL AND slug_fr IS NOT NULL
  AND slug_es IS NOT NULL AND slug_it IS NOT NULL AND slug_pl IS NOT NULL
  AND slug_cs IS NOT NULL AND slug_sv IS NOT NULL AND slug_nl IS NOT NULL
  AND slug_pt IS NOT NULL AND slug_ru IS NOT NULL AND slug_tr IS NOT NULL
  AND slug_el IS NOT NULL AND slug_no IS NOT NULL
  AND updated_at >= $since
```

`updated_at` (not `created_at`) is used to catch draft→active transitions.

## URL Building

Each listing generates 14 locale URLs. English has no locale prefix (`localePrefix: "as-needed"`). All others use `/{locale}/{translated-path}/{slug}`.

```
https://trade.aero/aircraft/cessna-172-123              (en — no prefix)
https://trade.aero/de/flugzeuge/cessna-172-123-de       (de)
https://trade.aero/fr/aeronefs/cessna-172-123-fr        (fr)
... 11 more locales
```

Path segments per entity type are defined in `src/utils/url-builder.ts` and mirror the routes in `src/i18n/routing.ts` in TradeAero-Refactor.

## Deduplication

`dedupe_key = sha256(entity_id + '|' + channel)`

- Entity-based (not URL-based) — survives slug changes
- Unique index on `indexing_events.dedupe_key` enforces this at DB level
- Second run for the same listing+channel = no-op (`ignoreDuplicates: true`)
- 2 rows per listing: one `indexnow`, one `google`

## Retry / Backoff

| Attempt | Delay |
|---------|-------|
| 1 | 5 min |
| 2 | 10 min |
| 3 | 20 min |
| 4 | 40 min |
| 5 | 80 min |
| >5 | status → `skipped` (manual retry only) |

Formula: `min(5min × 2^attempt, 24h)` ± 10% jitter

`next_retry_at` uses `"2099-01-01"` sentinel for terminal states (`success`, `skipped`) — the column is `NOT NULL` and `fetchDueEvents` only picks up `pending`/`failed` rows anyway.

## IndexNow Channel

- **Endpoint**: `POST https://api.indexnow.org/IndexNow`
- **Payload**: `{ host, key, keyLocation, urlList[] }`
- `urlList` = all 14 locale URLs from ALL pending listings in one batch (up to 1,400 URLs, well within IndexNow's 10,000 limit)
- **Success**: HTTP 200 or 202
- **Retry**: HTTP 429 or 5xx
- **Skip**: HTTP 400, 403, 422
- Key verification file must be hosted at `https://trade.aero/{key}.txt` — see `docs/indexnow-credentials.md`

## Google Channel

Primary path — **Google Indexing API** (when `GOOGLE_SERVICE_ACCOUNT_JSON` is set):
- **Endpoint**: `POST https://indexing.googleapis.com/v3/urlNotifications:publish`
- **Auth**: service-account JWT → OAuth2 access token (`https://www.googleapis.com/auth/indexing` scope)
- **Per-event**: submits each listing's canonical English URL (or all 14 locale URLs when `GOOGLE_INDEXING_ALL_LOCALES=true`)
- **Quota**: 200 URL notifications/day per Search Console property. On `429` the rest of the batch is short-circuited; events retry next run and, past the retry budget, settle as `skipped` (expected — not a hard failure)

Fallback — **sitemap ping** (only when no service account is configured):
- `GET https://www.google.com/ping?sitemap=<sitemap>` — **deprecated/removed by Google (Jan 2024)**; a 404 is expected and events are marked `skipped` (not `failed`) so they don't retry forever. Configure a service account to actually index.

## Database Table: `indexing_events`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `entity_type` | text | `aircraft`, `part`, `wanted`, `rental` |
| `entity_id` | text | Source table row ID |
| `url` | text | English canonical URL (reference) |
| `submitted_urls` | jsonb | Array of all 14 locale URLs submitted |
| `published_at` | timestamptz | `updated_at` from source table |
| `channel` | text | `indexnow` or `google` |
| `status` | text | `pending`, `success`, `failed`, `skipped` |
| `attempt_count` | integer | Incremented on each submission attempt |
| `last_attempt_at` | timestamptz | Timestamp of most recent attempt |
| `next_retry_at` | timestamptz | NOT NULL; `2099-01-01` for terminal states |
| `response_code` | integer | HTTP response code from submission |
| `response_body` | text | Truncated to 500 chars |
| `error_message` | text | Truncated to 500 chars |
| `dedupe_key` | text | `sha256(entity_id\|channel)` — unique index |
| `correlation_id` | text | GitHub Actions run ID |
| `created_at` | timestamptz | Row creation time |
| `updated_at` | timestamptz | Auto-updated by trigger |

**Indexes:**
- `UNIQUE idx_indexing_events_dedupe_key` — core idempotency guarantee
- `idx_indexing_events_created_at DESC` — dashboard ordering
- `idx_indexing_events_pending_retry` (partial: status IN pending/failed) — retry worker
- `idx_indexing_events_entity_type` — dashboard filter
- `idx_indexing_events_channel` — dashboard filter

## Admin Dashboard Integration

The indexing tab at `/dashboard/admin/#indexing` in TradeAero-Refactor reads from:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/indexing` | GET | Fetch recent `indexing_events` (limit 500) |
| `/api/admin/indexing` | POST `{action:"retry"}` | Reset failed/skipped → pending |
| `/api/admin/indexing` | POST `{action:"submit", url}` | Manual URL submission |
| `/api/admin/trigger-indexing` | POST `{dry_run}` | Trigger GitHub Actions workflow |

## Supported Locales (14)

`en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no`

## Key Design Decisions

1. **Service role key**: Bypasses RLS; `indexing_events` has permissive policies for service role writes
2. **Idempotency at DB level**: `dedupe_key` unique index — second run for same listing+channel = no-op
3. **Batch IndexNow**: All 14 locale URLs for ALL pending listings sent in one HTTP request per run
4. **Single Google ping**: One sitemap ping per run covers all locales via hreflang in sitemap
5. **Translation gate**: Listings not submitted until all 14 slugs exist — prevents broken locale URLs
6. **`updated_at` lookback**: Catches draft→active transitions, not just new listings
7. **FAR_FUTURE sentinel**: `"2099-01-01"` for `next_retry_at` on terminal states — column is NOT NULL
8. **cancel-in-progress: false**: Concurrent runs allowed; dedupe_key prevents double submissions
9. **correlationId**: GitHub run ID threads across all log lines and DB rows for easy debugging
