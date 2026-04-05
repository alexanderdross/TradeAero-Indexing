-- =============================================================
-- TradeAero: Search Engine Indexing Events Table
-- =============================================================
-- Tracks IndexNow and Google sitemap submission events per listing.
--
-- Design decisions:
--   - One row per listing per channel (2 rows total per listing: indexnow + google)
--   - submitted_urls JSONB stores all 14 locale URLs submitted in this event
--   - url stores the English canonical URL as the primary reference
--   - dedupe_key = sha256(entity_id|channel) prevents duplicate submissions
--     even if two cron runs overlap (unique index enforces this at DB level)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.indexing_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was indexed
  entity_type       text        NOT NULL
                                CHECK (entity_type IN ('aircraft', 'part', 'wanted', 'rental')),
  entity_id         text        NOT NULL,

  -- URL references
  url               text        NOT NULL,   -- English canonical URL (primary reference)
  submitted_urls    jsonb,                   -- Array of all 14 locale URLs submitted

  published_at      timestamptz NOT NULL,    -- updated_at from source table when listing became active

  -- Submission channel
  channel           text        NOT NULL
                                CHECK (channel IN ('indexnow', 'google')),

  -- Submission lifecycle
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'success', 'failed', 'skipped')),
  attempt_count     integer     NOT NULL DEFAULT 0,
  last_attempt_at   timestamptz,
  next_retry_at     timestamptz NOT NULL DEFAULT now(),  -- Ready immediately on first insert

  -- Response capture (truncated to 500 chars in application layer)
  response_code     integer,
  response_body     text,
  error_message     text,

  -- Deduplication and correlation
  dedupe_key        text        NOT NULL,   -- sha256(entity_id|channel)
  correlation_id    text,                   -- GitHub Actions run ID

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- =============================================================
-- Indexes
-- =============================================================

-- Primary deduplication: prevents duplicate submissions for the same listing+channel.
-- This is the core idempotency guarantee — enforced at DB level, not just app level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_indexing_events_dedupe_key
  ON public.indexing_events (dedupe_key);

-- Dashboard: recent events ordered by time
CREATE INDEX IF NOT EXISTS idx_indexing_events_created_at
  ON public.indexing_events (created_at DESC);

-- Retry worker: find events that are due for submission
CREATE INDEX IF NOT EXISTS idx_indexing_events_pending_retry
  ON public.indexing_events (status, next_retry_at)
  WHERE status IN ('pending', 'failed');

-- Dashboard filter by entity type
CREATE INDEX IF NOT EXISTS idx_indexing_events_entity_type
  ON public.indexing_events (entity_type, created_at DESC);

-- Dashboard filter by channel + status
CREATE INDEX IF NOT EXISTS idx_indexing_events_channel
  ON public.indexing_events (channel, status);

-- =============================================================
-- Auto-update trigger for updated_at
-- =============================================================

CREATE OR REPLACE FUNCTION update_indexing_events_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_indexing_events_updated_at
  BEFORE UPDATE ON public.indexing_events
  FOR EACH ROW EXECUTE FUNCTION update_indexing_events_updated_at();

-- =============================================================
-- Row Level Security
-- =============================================================

ALTER TABLE public.indexing_events ENABLE ROW LEVEL SECURITY;

-- Admin dashboard can read all events (uses anon key with RLS)
CREATE POLICY "Public select for admin dashboard"
  ON public.indexing_events FOR SELECT
  USING (true);

-- Indexing service writes via service role (bypasses RLS, but policies kept for clarity)
CREATE POLICY "Service role can insert indexing events"
  ON public.indexing_events FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update indexing events"
  ON public.indexing_events FOR UPDATE
  USING (true);

-- =============================================================
-- Column comments
-- =============================================================

COMMENT ON TABLE public.indexing_events IS
  'Search engine indexing submission log — one row per listing per channel (indexnow + google)';
COMMENT ON COLUMN public.indexing_events.url IS
  'English canonical URL — primary reference for the listing';
COMMENT ON COLUMN public.indexing_events.submitted_urls IS
  'JSONB array of all 14 locale-specific URLs submitted in this event';
COMMENT ON COLUMN public.indexing_events.dedupe_key IS
  'sha256(entity_id|channel) — unique index prevents duplicate submissions per listing+channel';
COMMENT ON COLUMN public.indexing_events.next_retry_at IS
  'When this event is next eligible for submission; DEFAULT now() makes new rows immediately processable';
