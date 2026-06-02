import { config } from "../config.js";
import {
  fetchDueEvents,
  markEventsAttempted,
  markEventsSuccess,
  markEventFailed,
} from "../db/indexing-events.js";
import { submitToIndexNow } from "../channels/indexnow.js";
import { submitGoogleEvents, pingGoogleSitemap } from "../channels/google.js";
import { computeNextRetryAt, shouldAbortRetrying } from "./retry.js";
import { logger } from "../utils/logger.js";
import type { SubmitStats, IndexingEvent } from "../types.js";

/**
 * A failure is "hard" (actionable misconfiguration) when it's an auth /
 * bad-request 4xx other than 429. 429 (quota / rate-limit) and 5xx are
 * transient and already covered by retry + quota handling, so they must NOT
 * trip the silent-failure alert (otherwise Google's daily-quota 429s would
 * page constantly). Network errors (status 0) are likewise treated as soft.
 */
function isHardFailure(httpStatus: number): boolean {
  return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;
}

/**
 * Phase 2: Process all pending (and retry-due) indexing events.
 *
 * IndexNow: All pending indexnow-channel events are batched into a single
 * HTTP request (all 14 locale URLs per listing, flattened).
 *
 * Google (Indexing API): If GOOGLE_SERVICE_ACCOUNT_JSON is set, submits the
 * canonical English URL of each listing directly to the Google Indexing API
 * (per-event results).  Otherwise falls back to a single sitemap ping.
 *
 * Dry-run mode: Skips external calls and marks events as 'success' with
 * response "dry-run" for validation purposes.
 */
export async function submitPendingEvents(
  correlationId: string,
): Promise<SubmitStats> {
  const stats: SubmitStats = {
    indexnowSuccess: 0,
    indexnowFailed: 0,
    googleSuccess: 0,
    googleFailed: 0,
    hardFailures: 0,
  };

  const pendingEvents = await fetchDueEvents();

  if (pendingEvents.length === 0) {
    logger.info("No pending indexing events", { correlationId });
    return stats;
  }

  logger.info(`Processing ${pendingEvents.length} pending events`, { correlationId });

  // ---- IndexNow ----
  const indexnowEvents = pendingEvents.filter((e) => e.channel === "indexnow");
  if (indexnowEvents.length > 0) {
    await processIndexNowEvents(indexnowEvents, correlationId, stats);
  }

  // ---- Google ----
  const googleEvents = pendingEvents.filter((e) => e.channel === "google");
  if (googleEvents.length > 0) {
    await processGoogleEvents(googleEvents, correlationId, stats);
  }

  logger.info("Submit complete", { correlationId, ...stats });
  return stats;
}

async function processIndexNowEvents(
  events: IndexingEvent[],
  correlationId: string,
  stats: SubmitStats,
): Promise<void> {
  // Flatten all locale URLs from all events into one IndexNow batch
  const allUrls = events.flatMap((e) => (e.submitted_urls as string[]) ?? [e.url]);

  if (config.indexing.dryRun) {
    // Dry runs must NOT mutate attempt_count or last_attempt_at — they only
    // validate URL generation. Skip markEventsAttempted entirely here.
    logger.info("[DRY RUN] Would submit to IndexNow", {
      listingCount: events.length,
      urlCount: allUrls.length,
      sampleUrls: allUrls.slice(0, 3),
      correlationId,
    });
    await markEventsSuccess(events.map((e) => e.id), 0, "dry-run");
    stats.indexnowSuccess = events.length;
    return;
  }

  // Record the attempt timestamp before calling the external API. The
  // attempt_count itself is bumped atomically in markEventFailed/markEventsSuccess.
  await markEventsAttempted(events);

  const result = await submitToIndexNow(allUrls, correlationId);

  if (result.success) {
    await markEventsSuccess(
      events.map((e) => e.id),
      result.httpStatus,
      result.responseBody,
      Object.fromEntries(events.map((e) => [e.id, e.attempt_count + 1])),
    );
    stats.indexnowSuccess = events.length;
  } else {
    for (const event of events) {
      const newCount = event.attempt_count + 1;
      const skip = shouldAbortRetrying(newCount);
      await markEventFailed(
        event.id,
        result.httpStatus,
        result.responseBody,
        skip ? null : computeNextRetryAt(newCount),
        skip,
        newCount,
      );
    }
    stats.indexnowFailed = events.length;
    // Whole-batch IndexNow failure (one request → one outcome for every URL).
    // A 403 here is the "site not verified" misconfiguration we want surfaced.
    if (isHardFailure(result.httpStatus)) {
      stats.hardFailures += events.length;
    }
  }
}

async function processGoogleEvents(
  events: IndexingEvent[],
  correlationId: string,
  stats: SubmitStats,
): Promise<void> {
  if (config.indexing.dryRun) {
    // Dry runs must NOT mutate attempt_count or last_attempt_at.
    const useApi = !!config.google.serviceAccountJson;
    logger.info("[DRY RUN] Would submit to Google", {
      eventCount: events.length,
      method: useApi ? "Indexing API" : "sitemap ping",
      allLocales: useApi ? config.google.allLocales : "n/a",
      correlationId,
    });
    await markEventsSuccess(events.map((e) => e.id), 0, "dry-run");
    stats.googleSuccess = events.length;
    return;
  }

  // Record the attempt timestamp before calling the external API. The
  // attempt_count itself is bumped atomically in markEventFailed/markEventsSuccess.
  await markEventsAttempted(events);

  // Choose method based on whether a service account is configured
  const { serviceAccountJson, allLocales } = config.google;
  const batchResult = serviceAccountJson
    ? await submitGoogleEvents(events, serviceAccountJson, allLocales, correlationId)
    : await pingGoogleSitemap(events, correlationId);

  // Apply per-event results
  for (const result of batchResult.results) {
    const event = events.find((e) => e.id === result.eventId)!;
    const newCount = event.attempt_count + 1;
    if (result.success) {
      await markEventsSuccess(
        [event.id],
        result.httpStatus,
        result.responseBody,
        { [event.id]: newCount },
      );
      stats.googleSuccess++;
    } else if (result.skipped) {
      // Endpoint deprecated or permanently unavailable — skip without retry
      await markEventFailed(
        event.id,
        result.httpStatus,
        result.responseBody,
        null,
        true, // skip = true
        newCount,
      );
      stats.googleFailed++;
    } else {
      const skip = shouldAbortRetrying(newCount);
      await markEventFailed(
        event.id,
        result.httpStatus,
        result.responseBody,
        skip ? null : computeNextRetryAt(newCount),
        skip,
        newCount,
      );
      stats.googleFailed++;
      // 429 (quota) flows through here too, but isHardFailure() excludes it —
      // daily quota exhaustion is expected, not an alertable misconfiguration.
      // A 401/403 (revoked service account) or 404 (bad URL) is.
      if (isHardFailure(result.httpStatus)) {
        stats.hardFailures++;
      }
    }
  }
}
