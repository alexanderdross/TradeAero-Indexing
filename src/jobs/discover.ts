import { config } from "../config.js";
import { fetchRecentlyPublishedListings } from "../db/listings.js";
import { upsertIndexingEvent } from "../db/indexing-events.js";
import { computeDedupeKey } from "../utils/dedupe.js";
import { buildAllLocaleUrls, buildEnglishUrl } from "../utils/url-builder.js";
import { logger } from "../utils/logger.js";
import type { Channel } from "../types.js";

const CHANNELS: Channel[] = ["indexnow", "google"];

/**
 * Phase 1: Find newly published, fully-translated listings and enqueue
 * pending indexing events for each channel.
 *
 * A listing is only enqueued if ALL 14 locale slugs are populated
 * (translation gate — enforced by the DB query in listings.ts).
 *
 * Idempotent: the dedupe_key unique index silently skips already-enqueued
 * listings, so re-running with a wide lookback window is safe.
 *
 * @returns Number of newly enqueued events (0 if all were duplicates)
 */
export async function discoverAndEnqueue(correlationId: string): Promise<number> {
  const lookbackMs = config.indexing.lookbackMinutes * 60 * 1000;
  const since = new Date(Date.now() - lookbackMs);

  logger.info("Discovering new listings", {
    lookbackMinutes: config.indexing.lookbackMinutes,
    since: since.toISOString(),
    correlationId,
  });

  const listings = await fetchRecentlyPublishedListings(since);

  if (listings.length === 0) {
    logger.info("No new fully-translated listings found", { correlationId });
    return 0;
  }

  let enqueued = 0;

  for (const listing of listings) {
    const englishUrl = buildEnglishUrl(listing.entityType, listing.slugs.en);
    const allLocaleUrls = buildAllLocaleUrls(listing.entityType, listing.slugs);

    for (const channel of CHANNELS) {
      const dedupeKey = computeDedupeKey(listing.entityId, channel);

      const inserted = await upsertIndexingEvent({
        entity_type: listing.entityType,
        entity_id: listing.entityId,
        url: englishUrl,
        submitted_urls: allLocaleUrls,
        published_at: listing.publishedAt,
        channel,
        status: "pending",
        dedupe_key: dedupeKey,
        correlation_id: correlationId,
      });

      if (inserted) enqueued++;
      // If dedupe_key already exists, upsert silently skips — listing was already indexed
    }
  }

  logger.info("Enqueue complete", {
    listingsFound: listings.length,
    eventsEnqueued: enqueued,
    correlationId,
  });

  return enqueued;
}
