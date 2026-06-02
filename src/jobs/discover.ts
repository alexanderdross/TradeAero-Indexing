import { config } from "../config.js";
import { fetchRecentlyPublishedListings } from "../db/listings.js";
import { upsertIndexingEvents } from "../db/indexing-events.js";
import { computeDedupeKey } from "../utils/dedupe.js";
import { buildAllLocaleUrls, buildEnglishUrl } from "../utils/url-builder.js";
import { logger } from "../utils/logger.js";
import type { Channel, NewIndexingEvent } from "../types.js";

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

  // Build every event up front, then bulk-insert in chunks (one round-trip per
  // chunk). A per-row upsert loop is fine for a 15-min run's handful of new
  // listings but times out on a backfill of thousands; dedupe_key still makes
  // the insert idempotent, so already-enqueued listings are skipped silently.
  const newEvents: NewIndexingEvent[] = [];
  for (const listing of listings) {
    const englishUrl = buildEnglishUrl(listing.entityType, listing.slugs.en);
    const allLocaleUrls = buildAllLocaleUrls(listing.entityType, listing.slugs);

    for (const channel of CHANNELS) {
      newEvents.push({
        entity_type: listing.entityType,
        entity_id: listing.entityId,
        url: englishUrl,
        submitted_urls: allLocaleUrls,
        published_at: listing.publishedAt,
        channel,
        status: "pending",
        dedupe_key: computeDedupeKey(listing.entityId, channel),
        correlation_id: correlationId,
      });
    }
  }

  const enqueued = await upsertIndexingEvents(newEvents);

  logger.info("Enqueue complete", {
    listingsFound: listings.length,
    eventsEnqueued: enqueued,
    correlationId,
  });

  return enqueued;
}
