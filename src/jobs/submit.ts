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

  // Record attempt before calling external API
  await markEventsAttempted(events);

  if (config.indexing.dryRun) {
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

  const result = await submitToIndexNow(allUrls, correlationId);

  if (result.success) {
    await markEventsSuccess(events.map((e) => e.id), result.httpStatus, result.responseBody);
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
      );
    }
    stats.indexnowFailed = events.length;
  }
}

async function processGoogleEvents(
  events: IndexingEvent[],
  correlationId: string,
  stats: SubmitStats,
): Promise<void> {
  await markEventsAttempted(events);

  if (config.indexing.dryRun) {
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

  // Choose method based on whether a service account is configured
  const { serviceAccountJson, allLocales } = config.google;
  const batchResult = serviceAccountJson
    ? await submitGoogleEvents(events, serviceAccountJson, allLocales, correlationId)
    : await pingGoogleSitemap(events, correlationId);

  // Apply per-event results
  for (const result of batchResult.results) {
    const event = events.find((e) => e.id === result.eventId)!;
    if (result.success) {
      await markEventsSuccess([event.id], result.httpStatus, result.responseBody);
      stats.googleSuccess++;
    } else if (result.skipped) {
      // Endpoint deprecated or permanently unavailable — skip without retry
      await markEventFailed(
        event.id,
        result.httpStatus,
        result.responseBody,
        null,
        true, // skip = true
      );
      stats.googleFailed++;
    } else {
      const newCount = event.attempt_count + 1;
      const skip = shouldAbortRetrying(newCount);
      await markEventFailed(
        event.id,
        result.httpStatus,
        result.responseBody,
        skip ? null : computeNextRetryAt(newCount),
        skip,
      );
      stats.googleFailed++;
    }
  }
}
