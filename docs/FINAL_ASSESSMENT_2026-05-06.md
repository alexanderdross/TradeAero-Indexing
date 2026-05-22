# Final Pre-Production Sign-Off — tradeaero-indexing — 2026-05-06

**Verdict**: **GO (gated by `INDEXING_ENABLED`)** — workflow exits
cleanly until the `production` GitHub Environment variable
`INDEXING_ENABLED` is set to `"true"` on cutover.

The full cross-repo go/no-go report is in **TradeAero-Refactor**:
[`docs/assessments/FINAL_ASSESSMENT_2026-05-06.md`](https://github.com/alexanderdross/tradeaero-refactor/blob/main/docs/assessments/FINAL_ASSESSMENT_2026-05-06.md)

The day-of operational checklist is in this repo:
[`docs/pre-launch-checklist.md`](./pre-launch-checklist.md). The
items below summarize state.

## Summary of indexing-side state (2026-05-06)

| Item | Status |
|---|---|
| Master kill-switch `INDEXING_ENABLED` (PR #7) | ✅ exits before `validateConfig()` when not exactly `"true"` |
| CI (Lint + Test + Typecheck) | ✅ live (PR #5) |
| Translation gate (14-locale slugs) | ✅ filters `slug_*` IS NOT NULL across all 14 locales |
| Idempotency | ✅ `dedupe_key = sha256(entity_id\|channel)` UNIQUE |
| Retry / backoff | ✅ 5/10/20/40/80 min, `2099-01-01` sentinel, `skipped` after 5 |
| Rentals scope | ✅ `rental_listings` discovery commented out per `MVP_HIDDEN_SECTIONS.md` (PR #8) |
| IndexNow key file | ✅ hosted on refactor; needs same path on `trade.aero` post-cutover |
| Hand-off from publish surfaces | ✅ refactor `listingPublishPipeline` + crawler `enqueueListingIndexing` write `indexing_events` rows that this service consumes |

## Cutover actions

Per [`docs/pre-launch-checklist.md`](./pre-launch-checklist.md):

1. Verify `https://trade.aero/dae83f2c776a45ffa42825f4f1f523dc.txt`
   returns the IndexNow key string with HTTP 200.
2. Set `INDEXING_ENABLED=true` in the `production` GitHub
   Environment.
3. Trigger a manual workflow dispatch with
   `lookback_minutes=525960` (≈ 1 year) and `dry_run=false` to
   backfill all existing listings.
4. Watch `indexing_events` for `status=success`. Re-run if any
   rows land in `failed` past the retry budget.
5. Confirm the Google service account
   `indexing-service@tradeaero-indexing.iam.gserviceaccount.com`
   is **Owner** on the `trade.aero` GSC property (not just User).
6. Submit `https://trade.aero/sitemap.xml` to GSC sitemaps tab.

Optional: request Google Indexing API quota increase if
`GOOGLE_INDEXING_ALL_LOCALES=true` will be enabled (~3,892
URLs/day at current 473-listing baseline).

---

**Branch**: `claude/final-assessments-production-JFyEG`
**HEAD reviewed**: `0ddc1f9` (PR #8 merge, 2026-05-03)
