import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import type { IndexingEvent, NewIndexingEvent } from "../types.js";

/**
 * Insert a new indexing event. Silently skips if the dedupe_key already
 * exists (same listing+channel was already indexed).
 * Returns true if a new row was inserted, false if it was a duplicate.
 */
export async function upsertIndexingEvent(
  event: NewIndexingEvent,
): Promise<boolean> {
  const { error } = await supabase
    .from("indexing_events")
    .upsert(event, { onConflict: "dedupe_key", ignoreDuplicates: true });

  if (error) {
    logger.warn("upsertIndexingEvent error", {
      error: error.message,
      dedupe_key: event.dedupe_key,
      channel: event.channel,
    });
    return false;
  }
  return true;
}

/**
 * Fetch all events that are ready for submission:
 * - status = 'pending', OR
 * - status = 'failed' AND next_retry_at <= now()
 */
export async function fetchDueEvents(): Promise<IndexingEvent[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("indexing_events")
    .select("*")
    .or(`status.eq.pending,and(status.eq.failed,next_retry_at.lte.${now})`)
    .order("created_at", { ascending: true })
    .limit(1000);

  if (error) {
    throw new Error(`fetchDueEvents: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Increment attempt_count and record last_attempt_at for a batch of events.
 * Caller passes the in-memory events so we can do attempt_count + 1 without
 * a separate read (safe because this service runs single-process per cron run).
 */
export async function markEventsAttempted(
  events: Pick<IndexingEvent, "id" | "attempt_count">[],
): Promise<void> {
  if (events.length === 0) return;
  const now = new Date().toISOString();
  await Promise.all(
    events.map(({ id, attempt_count }) =>
      supabase
        .from("indexing_events")
        .update({ attempt_count: attempt_count + 1, last_attempt_at: now })
        .eq("id", id),
    ),
  );
}

/**
 * Mark a batch of events as successfully submitted.
 */
export async function markEventsSuccess(
  ids: string[],
  responseCode: number,
  responseBody: string,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("indexing_events")
    .update({
      status: "success",
      response_code: responseCode,
      response_body: responseBody.slice(0, 500),
      error_message: null,
      next_retry_at: null,
    })
    .in("id", ids);

  if (error) {
    logger.warn("markEventsSuccess error", { error: error.message });
  }
}

/**
 * Mark a single event as failed and schedule its next retry.
 * When skip=true, marks as 'skipped' with no further retry.
 */
export async function markEventFailed(
  id: string,
  responseCode: number,
  responseBody: string,
  nextRetryAt: Date | null,
  skip = false,
): Promise<void> {
  const { error } = await supabase
    .from("indexing_events")
    .update({
      status: skip ? "skipped" : "failed",
      response_code: responseCode,
      response_body: responseBody.slice(0, 500),
      next_retry_at: skip ? null : nextRetryAt?.toISOString() ?? null,
    })
    .eq("id", id);

  if (error) {
    logger.warn("markEventFailed error", { id, error: error.message });
  }
}
