# TradeAero Indexing

Standalone Node.js / TypeScript worker that auto-submits newly published
TradeAero listings to search-engine indexing APIs so they get crawled within
minutes of going live instead of waiting for the next organic crawl.

## What it does

On every run the worker:

1. **Discovers** listings (aircraft, parts, rentals, wanted) that became
   `active` and fully translated (all 14 locale slugs populated) within the
   lookback window.
2. **Builds** all 14 locale URLs for each listing.
3. **Submits** those URLs in one batch to **IndexNow** (covers Bing, Yandex,
   Seznam, Naver).
4. **Submits** to **Google** — directly via the Google Indexing API when a
   service account is configured, otherwise via a sitemap ping fallback.
5. **Records** every attempt in the `indexing_events` Supabase table with
   retry / exponential-backoff logic. After 5 failed attempts an event is
   marked `skipped`.

It runs unattended on a GitHub Actions cron — there is no long-running server.

## Env gates

Two environment variables act as control switches:

| Variable | Effect |
|----------|--------|
| `INDEXING_ENABLED` | **Master kill switch.** The worker exits cleanly unless this is exactly `"true"`. Sourced from GitHub Actions **vars** (not secrets) so it can be scoped per environment. A missing value is the safe default (disabled). |
| `INDEXING_DRY_RUN` | When `"true"`, the worker discovers and enqueues events but skips all external API calls. Dry runs do **not** mutate `attempt_count` or `last_attempt_at`, so they can be run freely for validation. |

## Required environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Service role JWT (bypasses RLS) |
| `INDEXNOW_API_KEY` | Yes | — | Must match the content of `public/{key}.txt` hosted on the live site (see `docs/indexnow-credentials.md`) |
| `INDEXING_ENABLED` | No | unset | Master kill switch — must be `"true"` for the worker to do anything |
| `INDEXING_DRY_RUN` | No | `false` | Skip external API calls when `"true"` |
| `SITE_BASE_URL` | No | `https://trade.aero` | Base URL all submitted URLs are built from |
| `INDEXING_LOOKBACK_MINUTES` | No | `60` | How far back to look for newly published listings |
| `INDEXNOW_BATCH_SIZE` | No | `100` | Max listings per IndexNow batch |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | unset | Full Google Service Account JSON. When set, uses the Google Indexing API; when empty, falls back to a sitemap ping |
| `GOOGLE_INDEXING_ALL_LOCALES` | No | `false` | When `"true"`, submit all 14 locale URLs per listing to the Indexing API (costs 14x quota) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `SENTRY_DSN` | No | — | Sentry DSN for fatal-error reporting. Inert when unset. The run captures a fatal exception (and flushes) before exiting. |
| `SENTRY_ENVIRONMENT` | No | branch name | Sentry `environment` tag. Defaults to the Git ref / `NODE_ENV`. |

Copy `.env.example` to `.env` for local development.

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Run the indexer locally with `tsx` (requires `.env`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled output (`dist/index.js`) |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run test:coverage` | Run Vitest with the v8 coverage reporter |
| `npm run lint` | Run ESLint over `src/` |
| `npm run typecheck` | Type-check with `tsc --noEmit` |

## Deployment model

The worker is **not** deployed as a service. It runs as a scheduled GitHub
Actions job:

- **Workflow:** `.github/workflows/index-listings.yml`
- **Trigger:** cron every 30 minutes, plus manual `workflow_dispatch`
- **Manual dispatch inputs:** `lookback_minutes` (default `60`; use `10080`
  for a one-week backfill) and `dry_run` (`false` / `true`)
- **Timeout:** 10 minutes per run
- **Concurrency:** `group: index-listings`, `cancel-in-progress: false` —
  overlapping runs are allowed because the `dedupe_key` unique index in
  `indexing_events` prevents double submissions.

Each run installs dependencies with `npm ci` (reproducible install from the
committed lockfile), builds, then executes `node dist/index.js`.

`.github/workflows/ci.yml` runs lint, tests, type-check and a dependency audit
on pull requests and pushes to `main`.

### GitHub Actions secrets / vars

| Name | Kind | Description |
|------|------|-------------|
| `SUPABASE_URL` | secret | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Service role key |
| `INDEXNOW_API_KEY` | secret | Must match `public/{key}.txt` on the live site |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | Optional — enables the Google Indexing API |
| `INDEXING_ENABLED` | var | Master kill switch (`"true"` to enable) |
| `GOOGLE_INDEXING_ALL_LOCALES` | var | Optional — submit all locale URLs to Google |

## Further reading

- `CLAUDE.md` — full codebase reference (architecture, DB schema, design notes)
- `docs/indexnow-credentials.md` — how to generate / rotate the IndexNow key
- `docs/pre-launch-checklist.md` — pre-launch checklist
