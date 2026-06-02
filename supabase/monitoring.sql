-- TradeAero Indexing — operational monitoring queries
-- =====================================================
-- Read-only health checks for the indexing pipeline. Paste any block into the
-- Supabase SQL Editor (project: TradeAero). Each block is independent.
--
-- Why these exist: the `indexing_events` table goes quiet both when the
-- pipeline is broken AND when there's simply nothing new to index, so raw
-- row counts can look healthy while a channel is silently rejecting every URL.
-- These queries separate "benign quiet" from "actually broken".


-- ---------------------------------------------------------------------------
-- Q1. Liveness & freshness
-- ---------------------------------------------------------------------------
-- A large `gap` is only a problem if the GitHub Actions workflow ALSO stopped
-- running — the schedule is throttled to hours apart, and an idle run writes
-- no rows. Cross-check the Actions run history before declaring a stall.
select
  now()                                                           as now_utc,
  max(created_at)                                                 as last_event,
  now() - max(created_at)                                         as gap,
  count(*) filter (where created_at > now() - interval '1 hour')  as last_1h,
  count(*) filter (where created_at > now() - interval '24 hours') as last_24h,
  count(*) filter (where created_at > now() - interval '7 days')  as last_7d
from indexing_events;


-- ---------------------------------------------------------------------------
-- Q2. Channel / status / response-code breakdown (disambiguates "skipped")
-- ---------------------------------------------------------------------------
-- `skipped` conflates very different outcomes — read the response_code:
--   indexnow 403 = site not verified (HARD failure, actionable)
--   google   429 = daily quota exhausted (expected, benign)
--   google   404 = deprecated sitemap-ping fallback (expected, benign)
-- `last_7d` tells you whether each bucket is current or historical.
select
  channel,
  status,
  response_code,
  count(*)                                                        as total,
  count(*) filter (where created_at > now() - interval '7 days')  as last_7d,
  min(created_at)                                                 as first_seen,
  max(created_at)                                                 as last_seen
from indexing_events
group by channel, status, response_code
order by channel, status, count(*) desc;


-- ---------------------------------------------------------------------------
-- Q3. Hard-failure rate (last 24h) — the "ran but silently failing" signal
-- ---------------------------------------------------------------------------
-- Mirrors the in-app alert (src/utils/heartbeat.ts isRunUnhealthy): counts
-- only auth/bad-request 4xx (excl. 429). A non-zero hard_failures here means a
-- channel is misconfigured even if the workflow shows green.
select
  channel,
  count(*)                                                              as attempts_24h,
  count(*) filter (where status = 'success')                           as success,
  count(*) filter (
    where response_code >= 400 and response_code < 500 and response_code <> 429
  )                                                                     as hard_failures,
  count(*) filter (where response_code = 429)                          as quota_429,
  round(100.0 * count(*) filter (
    where response_code >= 400 and response_code < 500 and response_code <> 429
  ) / nullif(count(*), 0), 1)                                          as hard_failure_pct
from indexing_events
where last_attempt_at > now() - interval '24 hours'
   or created_at      > now() - interval '24 hours'
group by channel
order by channel;


-- ---------------------------------------------------------------------------
-- Q4. Retry backlog — events stuck pending/failed with a future retry
-- ---------------------------------------------------------------------------
-- A growing backlog (especially attempt_count climbing) means submissions keep
-- failing. `next_retry_at = '2099-01-01'` is the terminal sentinel — excluded.
select
  channel,
  status,
  count(*)                       as events,
  min(next_retry_at)             as next_due,
  max(attempt_count)             as max_attempts
from indexing_events
where status in ('pending', 'failed')
  and next_retry_at < '2099-01-01'::timestamptz
group by channel, status
order by channel, status;


-- ---------------------------------------------------------------------------
-- Q5. Missed listings — active + fully-translated but never enqueued
-- ---------------------------------------------------------------------------
-- The one failure mode the event table can't show on its own: a listing that
-- passes the translation gate (all 14 locale slugs) and is active, yet has NO
-- indexing_events row — i.e. discovery never enqueued it. Mirrors the gate in
-- src/db/listings.ts. (rental_listings intentionally excluded — hidden post-MVP,
-- same as discovery.)
--
-- Two numbers matter and they differ a lot:
--   * total backlog  — every never-indexed gated listing (historical + recent).
--                      Measured 2026-06-02: ~1,457. This is pre-service /
--                      never-backfilled inventory; clearing it needs a wide
--                      (~1y) lookback backfill, deferred by decision.
--   * last-7d        — recently published/updated ones the normal pipeline
--                      should have caught. This is the actionable, ongoing
--                      signal; it should trend to ~0 now the lookback is 24h.
with gated as (
  select 'aircraft'::text as entity_type, id::text as entity_id, updated_at
  from aircraft_listings
  where status = 'active'
    and slug_en is not null and slug_de is not null and slug_fr is not null
    and slug_es is not null and slug_it is not null and slug_pl is not null
    and slug_cs is not null and slug_sv is not null and slug_nl is not null
    and slug_pt is not null and slug_ru is not null and slug_tr is not null
    and slug_el is not null and slug_no is not null
  union all
  select 'part'::text, id::text, updated_at
  from parts_listings
  where status = 'active'
    and slug_en is not null and slug_de is not null and slug_fr is not null
    and slug_es is not null and slug_it is not null and slug_pl is not null
    and slug_cs is not null and slug_sv is not null and slug_nl is not null
    and slug_pt is not null and slug_ru is not null and slug_tr is not null
    and slug_el is not null and slug_no is not null
  union all
  select 'wanted'::text, id::text, updated_at
  from search_requests
  where status = 'active' and publish_as_wanted = true
    and slug_en is not null and slug_de is not null and slug_fr is not null
    and slug_es is not null and slug_it is not null and slug_pl is not null
    and slug_cs is not null and slug_sv is not null and slug_nl is not null
    and slug_pt is not null and slug_ru is not null and slug_tr is not null
    and slug_el is not null and slug_no is not null
),
missed as (
  select g.* from gated g
  where not exists (
    select 1 from indexing_events e
    where e.entity_id = g.entity_id and e.entity_type = g.entity_type
  )
)
-- 5a. Summary: total vs recent backlog (run this first).
select
  (select count(*) from missed)                                                    as missed_total,
  (select count(*) from missed where updated_at > now() - interval '7 days')        as missed_last_7d,
  (select count(*) from missed where updated_at > now() - interval '24 hours')      as missed_last_24h;

-- 5b. Detail: the actionable recent misses (swap the interval to audit older data).
-- with gated as ( ... ), missed as ( ... )  -- reuse the CTEs above
-- select entity_type, entity_id, updated_at
-- from missed
-- where updated_at > now() - interval '7 days'
-- order by updated_at desc;

