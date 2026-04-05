# TradeAero Indexing - Codebase Reference

## Overview

Standalone Node.js/TypeScript service that auto-submits newly published TradeAero listings to search engine indexing APIs. Runs every 15 minutes via GitHub Actions.

**What it does:**
- Detects listings that became active and fully translated (all 14 locale slugs populated) within the lookback window
- Builds all 14 locale URLs per listing
- Submits URLs in batch to **IndexNow** (covers Bing, Yandex, Seznam, Naver)
- Pings **Google** sitemap endpoint to trigger re-crawl
- Records all attempts in the `indexing_events` Supabase table with retry/backoff logic
- Exposes data to the admin dashboard via `/api/admin/indexing` in TradeAero-Refactor

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript 5.7, ES modules
- **Database**: Supabase PostgreSQL via `@supabase/supabase-js` (service role key bypasses RLS)
- **HTTP**: Native `fetch` (no extra HTTP client)
- **Scheduling**: GitHub Actions cron every 15 minutes + `workflow_dispatch`
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
    google.ts                 # pingGoogleSitemap() — GET google.com/ping?sitemap=<url>
  jobs/
    discover.ts               # discoverAndEnqueue(): query new listings -> insert pending events
    submit.ts                 # submitPendingEvents(): batch IndexNow + single Google ping
    retry.ts                  # computeNextRetryAt(attemptCount): exponential backoff
  utils/
    logger.ts                 # Structured logger with timestamp, level, context
    fetch.ts                  # fetchWithTimeout wrapper
    dedupe.ts                 # computeDedupeKey(entityId, channel): sha256 hex
    url-builder.ts            # buildAllLocaleUrls(entityType, slugs): 14 locale URLs
  __tests__/
    url-builder.test.ts       # 56 URL assertions (4 entity types x 14 locales)
    dedupe.test.ts            # Dedupe key stability
    discover.test.ts          # Listing discovery query logic (mocked Supabase)
    retry.test.ts             # Exponential backoff intervals
supabase/
  add_indexing_events_table.sql  # DB migration (run once in Supabase SQL Editor)
docs/
  indexnow-credentials.md    # How to generate/rotate the IndexNow API key
.github/workflows/
  index-listings.yml          # Cron every 15 min + workflow_dispatch with dry_run input
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
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |

## GitHub Actions Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key |
| `INDEXNOW_API_KEY` | Must match `public/{key}.txt` hosted on trade.aero |

## GitHub Actions Workflow

| Workflow | Trigger | Timeout | Concurrency |
|----------|---------|---------|-------------|
| Index New Listings | Every 15 min + manual | 10 min | `group: index-listings`, `cancel-in-progress: false` |

**Manual dispatch inputs:**
- `lookback_minutes` (default: `60`; use `10080` for a 1-week backfill)
- `dry_run` (`false` / `true`)

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
   c. Google: if any pending google events -> one sitemap ping GET
   d. Mark events success/failed, increment attempt_count
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

- **Endpoint**: `GET https://www.google.com/ping?sitemap=https://trade.aero/2d6a9a/sitemap.xml`
- **One request per run** — signals Google to re-crawl the sitemap (covers all 14 locales via hreflang)
- All `channel='google'` events for that run share the same response outcome

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
