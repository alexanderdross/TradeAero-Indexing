import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiscoveredListing } from "../types.js";

// ---- Mocks ----
// These modules have external dependencies (Supabase, network) so we mock them
vi.mock("../db/listings.js", () => ({
  fetchRecentlyPublishedListings: vi.fn(),
}));
vi.mock("../db/indexing-events.js", () => ({
  upsertIndexingEvent: vi.fn().mockResolvedValue(true),
}));
vi.mock("../config.js", () => ({
  config: {
    indexing: { lookbackMinutes: 60, dryRun: false },
    indexnow: { apiKey: "test-key", batchSize: 100 },
    supabase: { url: "https://test.supabase.co", serviceRoleKey: "service-key" },
    // url-builder reads config.site.baseUrl; without it buildEnglishUrl throws.
    site: { baseUrl: "https://trade.aero" },
    google: { serviceAccountJson: "", allLocales: false },
  },
  validateConfig: vi.fn(),
}));

import { discoverAndEnqueue } from "../jobs/discover.js";
import { fetchRecentlyPublishedListings } from "../db/listings.js";
import { upsertIndexingEvent } from "../db/indexing-events.js";

const mockFetch = vi.mocked(fetchRecentlyPublishedListings);
const mockUpsert = vi.mocked(upsertIndexingEvent);

const LANG_KEYS = [
  "en", "de", "fr", "es", "it", "pl",
  "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
] as const;

function makeListing(id: string): DiscoveredListing {
  return {
    entityType: "aircraft",
    entityId: id,
    slugs: Object.fromEntries(LANG_KEYS.map((l) => [l, `slug-${id}-${l}`])) as Record<typeof LANG_KEYS[number], string>,
    publishedAt: new Date().toISOString(),
  };
}

describe("discoverAndEnqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue(true);
  });

  it("returns 0 when no listings found", async () => {
    mockFetch.mockResolvedValue([]);
    const enqueued = await discoverAndEnqueue("test-run-1");
    expect(enqueued).toBe(0);
  });

  it("enqueues 2 events per listing (indexnow + google)", async () => {
    mockFetch.mockResolvedValue([makeListing("listing-001")]);
    const enqueued = await discoverAndEnqueue("test-run-2");
    expect(enqueued).toBe(2); // 1 listing × 2 channels
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it("enqueues the correct channels", async () => {
    mockFetch.mockResolvedValue([makeListing("listing-002")]);
    await discoverAndEnqueue("test-run-3");
    const channels = mockUpsert.mock.calls.map((call) => call[0].channel);
    expect(channels).toContain("indexnow");
    expect(channels).toContain("google");
  });

  it("includes 14 locale URLs in submitted_urls for each event", async () => {
    mockFetch.mockResolvedValue([makeListing("listing-003")]);
    await discoverAndEnqueue("test-run-4");
    for (const call of mockUpsert.mock.calls) {
      expect(call[0].submitted_urls).toHaveLength(14);
    }
  });

  it("uses the English URL as the primary url field", async () => {
    mockFetch.mockResolvedValue([makeListing("listing-004")]);
    await discoverAndEnqueue("test-run-5");
    const urls = mockUpsert.mock.calls.map((call) => call[0].url);
    for (const url of urls) {
      expect(url).toContain("/aircraft/slug-listing-004-en");
      expect(url).not.toContain("/de/");
    }
  });

  it("counts 0 enqueued when all upserts return false (all duplicates)", async () => {
    mockFetch.mockResolvedValue([makeListing("listing-005")]);
    mockUpsert.mockResolvedValue(false); // All already exist
    const enqueued = await discoverAndEnqueue("test-run-6");
    expect(enqueued).toBe(0);
  });

  it("enqueues multiple listings correctly", async () => {
    mockFetch.mockResolvedValue([
      makeListing("a"),
      makeListing("b"),
      makeListing("c"),
    ]);
    const enqueued = await discoverAndEnqueue("test-run-7");
    expect(enqueued).toBe(6); // 3 listings × 2 channels
  });
});
