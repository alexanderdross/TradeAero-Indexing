import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    indexnow: { apiKey: "test-key", batchSize: 100 },
    site: { baseUrl: "https://trade.aero" },
    google: { serviceAccountJson: "", allLocales: false },
    indexing: { lookbackMinutes: 60, dryRun: false },
  },
}));

vi.mock("../utils/fetch.js", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { pingGoogleSitemap } from "../channels/google.js";
import { fetchWithTimeout } from "../utils/fetch.js";
import type { IndexingEvent } from "../types.js";

const mockFetch = vi.mocked(fetchWithTimeout);

function makeResponse(status: number, body = ""): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeEvents(count: number): IndexingEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    entity_type: "part",
    entity_id: `listing-${i}`,
    url: `https://trade.aero/parts/listing/slug-${i}-en`,
    submitted_urls: [`https://trade.aero/parts/listing/slug-${i}-en`],
    published_at: new Date().toISOString(),
    channel: "google",
    status: "pending",
    attempt_count: 0,
    last_attempt_at: null,
    next_retry_at: new Date().toISOString(),
    response_code: null,
    response_body: null,
    error_message: null,
    dedupe_key: `key-${i}-google`,
    correlation_id: "test-run",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
}

describe("pingGoogleSitemap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks all events skipped when Google returns 404 (deprecated endpoint)", async () => {
    mockFetch.mockResolvedValue(makeResponse(404, "Not Found"));
    const events = makeEvents(3);
    const result = await pingGoogleSitemap(events, "corr-404");

    expect(result.usedIndexingApi).toBe(false);
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.success).toBe(false);
      expect(r.skipped).toBe(true);
      expect(r.httpStatus).toBe(404);
    }
  });

  it("marks all events success when ping returns 200", async () => {
    mockFetch.mockResolvedValue(makeResponse(200, "OK"));
    const events = makeEvents(2);
    const result = await pingGoogleSitemap(events, "corr-200");

    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.success).toBe(true);
      expect(r.skipped).toBeUndefined();
      expect(r.httpStatus).toBe(200);
    }
  });

  it("marks events failed (not skipped) on 5xx server error", async () => {
    mockFetch.mockResolvedValue(makeResponse(503, "Service Unavailable"));
    const events = makeEvents(1);
    const result = await pingGoogleSitemap(events, "corr-503");

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].skipped).toBeUndefined();
    expect(result.results[0].httpStatus).toBe(503);
  });

  it("returns failure with httpStatus 0 on network error", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));
    const events = makeEvents(2);
    const result = await pingGoogleSitemap(events, "corr-neterr");

    for (const r of result.results) {
      expect(r.success).toBe(false);
      expect(r.httpStatus).toBe(0);
      expect(r.responseBody).toContain("connection refused");
    }
  });

  it("pings the correct sitemap URL derived from SITE_BASE_URL", async () => {
    mockFetch.mockResolvedValue(makeResponse(200));
    await pingGoogleSitemap(makeEvents(1), "corr-url");
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain("https://www.google.com/ping");
    expect(calledUrl).toContain(encodeURIComponent("https://trade.aero/sitemap.xml"));
  });

  it("maps each event id to its result", async () => {
    mockFetch.mockResolvedValue(makeResponse(404));
    const events = makeEvents(3);
    const result = await pingGoogleSitemap(events, "corr-ids");
    const returnedIds = result.results.map((r) => r.eventId);
    expect(returnedIds).toEqual(["evt-0", "evt-1", "evt-2"]);
  });

  it("truncates long response body to 500 chars", async () => {
    mockFetch.mockResolvedValue(makeResponse(200, "z".repeat(1000)));
    const result = await pingGoogleSitemap(makeEvents(1), "corr-trunc");
    expect(result.results[0].responseBody).toHaveLength(500);
  });
});
