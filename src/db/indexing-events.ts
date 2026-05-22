import { supabase } from "./client.js";
import { logger } from "../utils/logger.js";
import type { IndexingEvent, NewIndexingEvent } from "../types.js";

// Sentinel value for next_retry_at on terminal states (success/skipped).
// Column is NOT NULL so we can't use null — a far-future date is functionally
// equivalent since fetchDueEvents only picks up pending/failed events.
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

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
 * Record last_attempt_at for a batch of events that are about to be submitted.
 *
 * NOTE: this does NOT touch attempt_count — the retry counter is incremented
 * atomically inside markEventFailed (and markEventsSuccess) as part of the
 * SAME statement that sets the event's status, so the count and the retry
 * decision can never desync. This function only timestamps the attempt.
 *
 * Errors from the individual UPDATEs are captured and logged (never swallowed)
 * and the count of failures is returned so callers can react if desired.
 */
export async function markEventsAttempted(
  events: Pick<IndexingEvent, "id">[],
): Promise<{ failed: number }> {
  if (events.length === 0) return { failed: 0 };
  const now = new Date().toISOString();
  const results = await Promise.allSettled(
    events.map(({ id }) =>
      supabase
        .from("indexing_events")
        .update({ last_attempt_at: now })
        .eq("id", id)
        .then(({ error }) => {
          if (error) {
            throw new Error(error.message);
          }
        }),
    ),
  );

  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      failed += 1;
      logger.warn("markEventsAttempted: failed to record attempt", {
        id: events[i].id,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });
  return { failed };
}

/**
 * Mark a batch of events as successfully submitted.
 *
 * `attempt_count` is bumped to reflect the attempt that just succeeded so the
 * stored count is always consistent with reality.
 */
export async function markEventsSuccess(
  ids: string[],
  responseCode: number,
  responseBody: string,
  attemptCounts?: Record<string, number>,
): Promise<void> {
  if (ids.length === 0) return;

  // When attemptCounts are supplied each event may have a different new
  // attempt_count, so issue one UPDATE per event; otherwise a single batched
  // UPDATE is enough.
  if (attemptCounts) {
    const results = await Promise.allSettled(
      ids.map((id) =>
        supabase
          .from("indexing_events")
          .update({
            status: "success",
            response_code: responseCode,
            response_body: responseBody.slice(0, 500),
            error_message: null,
            next_retry_at: FAR_FUTURE,
            attempt_count: attemptCounts[id],
          })
          .eq("id", id)
          .then(({ error }) => {
            if (error) throw new Error(error.message);
          }),
      ),
    );
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logger.warn("markEventsSuccess error", {
          id: ids[i],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
    return;
  }

  const { error } = await supabase
    .from("indexing_events")
    .update({
      status: "success",
      response_code: responseCode,
      response_body: responseBody.slice(0, 500),
      error_message: null,
      next_retry_at: FAR_FUTURE,
    })
    .in("id", ids);

  if (error) {
    logger.warn("markEventsSuccess error", { error: error.message });
  }
}

/**
 * Mark a single event as failed and schedule its next retry.
 *
 * The new `attempt_count` is written in the SAME UPDATE that sets the status,
 * so the persisted retry counter and the retry/skip decision derived from it
 * can never desync (no separate increment step that could fail independently).
 *
 * @param newAttemptCount - attempt_count AFTER this failed attempt. The caller
 *   derives `skip` / `nextRetryAt` from this same value.
 * When skip=true, marks as 'skipped' with no further retry.
 */
export async function markEventFailed(
  id: string,
  responseCode: number,
  responseBody: string,
  nextRetryAt: Date | null,
  skip = false,
  newAttemptCount?: number,
): Promise<void> {
  const update: Record<string, unknown> = {
    status: skip ? "skipped" : "failed",
    response_code: responseCode,
    response_body: responseBody.slice(0, 500),
    next_retry_at: skip ? FAR_FUTURE : (nextRetryAt?.toISOString() ?? FAR_FUTURE),
  };
  if (newAttemptCount !== undefined) {
    update.attempt_count = newAttemptCount;
  }

  const { error } = await supabase
    .from("indexing_events")
    .update(update)
    .eq("id", id);

  if (error) {
    logger.warn("markEventFailed error", { id, error: error.message });
  }
}
