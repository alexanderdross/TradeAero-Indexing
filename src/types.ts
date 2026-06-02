export type EntityType = "aircraft" | "part" | "wanted" | "rental";
export type Channel = "indexnow" | "google";
export type IndexingStatus = "pending" | "success" | "failed" | "skipped";
export type SupportedLang =
  | "en" | "de" | "fr" | "es" | "it" | "pl"
  | "cs" | "sv" | "nl" | "pt" | "ru" | "tr" | "el" | "no";

export interface DiscoveredListing {
  entityType: EntityType;
  entityId: string;
  /** All 14 locale slugs — must all be non-null (translation gate) */
  slugs: Record<SupportedLang, string>;
  publishedAt: string; // ISO timestamp from updated_at
}

export interface IndexingEvent {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  /** English canonical URL — used as the primary reference */
  url: string;
  /** All 14 locale URLs submitted in this event */
  submitted_urls: string[] | null;
  published_at: string;
  channel: Channel;
  status: IndexingStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  response_code: number | null;
  response_body: string | null;
  error_message: string | null;
  /** sha256(entity_id|channel) — unique index prevents duplicate submissions */
  dedupe_key: string;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewIndexingEvent {
  entity_type: EntityType;
  entity_id: string;
  url: string;
  submitted_urls: string[];
  published_at: string;
  channel: Channel;
  status: IndexingStatus;
  dedupe_key: string;
  correlation_id: string;
}

export interface SubmitStats {
  indexnowSuccess: number;
  indexnowFailed: number;
  googleSuccess: number;
  googleFailed: number;
  /**
   * Subset of failures that are *unexpected* — auth / bad-request style 4xx
   * (e.g. IndexNow 403 "UserForbiddedToAccessSite", a revoked Google service
   * account). Deliberately excludes outcomes the retry/quota model already
   * accounts for: Google 429 quota exhaustion, deprecated-endpoint skips, 5xx
   * server errors, and network blips.
   *
   * This is the signal behind the "ran but silently failing" alert: a run can
   * complete cleanly while a channel rejects every URL (as happened Apr 5–20,
   * 1,436 IndexNow 403s). The dead-man's-switch only catches "job didn't run";
   * `hardFailures` lets a *completed* run still raise a `/fail` ping.
   */
  hardFailures: number;
}
