# Pre-Launch Checklist — Indexing Service

Topics to address before `trade.aero` goes live in production.

All items below are **not blockers for development/QA** on `refactor.trade.aero`,
but must be resolved before the first live IndexNow or Google Indexing submission
to `trade.aero` counts in search engines.

---

## 1. IndexNow — Domain Verification

**Status:** ✅ Resolved (verified live). The 403 `"UserForbiddedToAccessSite"`
rejections appear in `indexing_events` only between **2026-04-05 and 2026-04-20**
(1,436 events, all settled to `skipped`); **zero in the last 7 days** as of
2026-06-02. The key file is now reachable and IndexNow accepts submissions
(recent `indexnow` events are `status='success'` with `response_code` 200/202).

IndexNow verifies site ownership by fetching the key file from the submitted domain
before accepting URLs.

**To re-confirm if it ever regresses:**
- Confirm the Next.js `public/dae83f2c776a45ffa42825f4f1f523dc.txt` file is included
  in the Vercel deployment for `trade.aero`.
- Run: `curl https://trade.aero/dae83f2c776a45ffa42825f4f1f523dc.txt`
  and confirm it returns just the key string with HTTP 200.
- Watch for `indexnow` / `403` rows reappearing (Q2 in `supabase/monitoring.sql`)
  — the in-app hard-failure alert now pages on this automatically.

**Reference:** `docs/indexnow-credentials.md`

---

## 2. Launch Day — Backfill All Existing Listings

**Status:** ✅ Enqueued (2026-06-02). `missed_total` (Q5a in
`supabase/monitoring.sql`) is now **0** — every active, fully-translated listing
has indexing_events rows. Submission then drains automatically (see note below).

**What happened:** ~1,457 active, fully-translated listings (~59% of ~2,476
eligible, almost all `parts`) had **zero** indexing_events rows — the launch-day
historical backfill was never completed as inventory grew. Backfill runs with
`lookback_minutes=525960` cleared it once two ceilings were fixed:
1. a hardcoded 500-row/table discovery cap (→ `INDEXING_DISCOVERY_LIMIT`), and
2. PostgREST's ~1000-row server cap on a single response — discovery now
   **paginates** with `.range()`, so it can reach the whole table.

**Submission drain (automatic, no action needed):**
- **IndexNow** clears fast — the whole batch goes in one or two scheduled runs
  (`fetchDueEvents` processes 1000/run; IndexNow auto-chunks at 10k URLs).
- **Google** is quota-bound at ~200 URL/day, so the ~1,400 Google events spread
  over ~7 days via the normal retry/backoff; events past the retry budget settle
  as `skipped` (expected — not a hard failure). Request a Google quota increase
  (item #3) to speed this up.
- Watch Q3 (hard-failure rate) and Q5a (`missed_total`) in `supabase/monitoring.sql`.

**To re-backfill in future** (e.g. after a long outage): manual dispatch with
`dry_run: false` (NOT dry — a dry run enqueues then marks `success`/`dry-run`
without submitting, and `dedupe_key` blocks the real submission),
`lookback_minutes: 525960`, `discovery_limit` ≥ the largest table's row count.

---

## 3. Google Indexing API — Daily Quota

**Status:** Working (1 URL confirmed submitted in run #19), but quota is limited.

The Google Indexing API default quota is **200 URL notifications per day** per
Search Console property. The backfill on launch day will have ~278 listings
(currently), which exceeds the daily limit.

**What to ask:**
- Request a quota increase via Google Search Console before launch:
  `https://search.google.com/search-console/settings/quota`
- Or accept that Google backfill will spread across 2+ days automatically
  (retry logic will resubmit failed/unsubmitted events on subsequent runs).
- Consider enabling `GOOGLE_INDEXING_ALL_LOCALES=true` **only** after quota
  is increased (submits 14 locale URLs per listing × 278 = ~3,892 requests/day).

---

## 4. `SITE_BASE_URL` — Confirm Production Value

**Status:** Currently defaults to `https://trade.aero` — correct for production.

**What to ask:**
- Confirm no `SITE_BASE_URL` override is set in GitHub Actions variables
  that could accidentally point to `refactor.trade.aero`.
- Go to: `https://github.com/alexanderdross/TradeAero-Indexing/settings/variables/actions`
  and verify `SITE_BASE_URL` is either absent (default applies) or set to `https://trade.aero`.

---

## 5. `INDEXING_DRY_RUN` — Ensure Live Mode for Production

**Status:** Currently controlled via the manual dispatch input (`dry_run`).
The scheduled cron runs always use live mode (dry_run defaults to `false`).

**What to ask:**
- Confirm no GitHub Actions variable named `INDEXING_DRY_RUN` is set to `true`
  (it would have no effect on the workflow, but may cause confusion).
- Go to: `https://github.com/alexanderdross/TradeAero-Indexing/settings/variables/actions`
  and verify.

---

## 6. Google Search Console — Verify `trade.aero` Property

**Status:** Depends on domain going live.

**What to ask:**
- After `trade.aero` goes live, verify the property in Google Search Console:
  `https://search.google.com/search-console`
- Confirm the service account
  `indexing-service@tradeaero-indexing.iam.gserviceaccount.com`
  still shows as **Owner** (not just User) on the `trade.aero` property.
- Submit the sitemap manually once:
  `https://search.google.com/search-console/sitemaps`
  → Add sitemap URL: `https://trade.aero/sitemap.xml`

---

## 7. Sitemap — Confirm Format and Locale Hreflang

**Status:** Not verified — sitemap contents not reviewed in this session.

**What to ask:**
- Confirm `https://trade.aero/sitemap.xml` is reachable after launch.
- Confirm it includes `<xhtml:link rel="alternate" hreflang="...">` tags for all
  14 locales per listing (this is what tells Google about locale variants).
- Validate at: `https://www.xml-sitemaps.com/validate-xml-sitemap.html`

---

## 8. Rate Limiting — Production Traffic Review

**Status:** In-memory rate limiter in place (10 req/min for indexing POST,
3 req/min for trigger). Resets on each serverless instance cold start.

**What to ask:**
- Under high traffic (many admins or automated calls), the in-memory store
  does not share state across Vercel instances.
- If abuse becomes a concern, upgrade to Redis-backed rate limiting via
  Vercel KV (`@vercel/kv`).
- For now, the limits are appropriate for low-traffic admin endpoints.

---

## 9. Branch Cleanup

**Status:** Pending merge of open PRs.

Delete these branches after merging the PRs:

| Repo | Branch | Action |
|---|---|---|
| TradeAero-Indexing | `claude/auto-indexing-listings-cbkAM` | Delete after merging PR #3 |
| TradeAero-Refactor | `claude/auto-indexing-listings-cbkAM` | Delete after merging PR #399 |
| TradeAero-Refactor | `claude/review-project-docs-hzwBS` | Delete (stale — no open PR) |
| TradeAero-Refactor | `claude/review-trade-aero-docs-mcROl` | Delete (stale — no open PR) |
| TradeAero-Crawler | `claude/review-project-docs-hzwBS` | Delete (stale — no open PR) |
| TradeAero-Crawler | `claude/review-trade-aero-docs-mcROl` | Delete (stale — no open PR) |

---

## Summary Table

| # | Topic | Blocker for launch? | Who |
|---|---|---|---|
| 1 | IndexNow domain verification | ✅ Done — verified live (403s stopped 2026-04-20) | Dev/Ops |
| 2 | Backfill existing listings | ✅ Enqueued — missed_total=0; Google submission drains over ~7d (quota) | Dev/Ops |
| 3 | Google quota increase | Soft — retry logic covers it | Dev/Ops |
| 4 | Confirm `SITE_BASE_URL` not overridden | Yes | Dev/Ops |
| 5 | Confirm `INDEXING_DRY_RUN` not stuck on | Yes | Dev/Ops |
| 6 | Verify Search Console property + service account | Yes | Dev/Ops |
| 7 | Sitemap format + hreflang validation | Yes | Dev |
| 8 | Rate limiting (Redis upgrade) | No — optional | Dev |
| 9 | Branch cleanup | No — housekeeping | Dev |
