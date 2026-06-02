import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IndexingEvent } from "../types.js";

/**
 * Integration test for the Phase 2 orchestration (`submitPendingEvents`).
 *
 * The Supabase client and both submission channels (IndexNow + Google) are
 * mocked, so this exercises the real `submit.ts` orchestration logic end to
 * end: which channel each event is routed to, the status transitions written
 * back to the DB, and the retry / skip decision derived from `attempt_count`.
 */

// --- Mutable config so individual tests can flip dryRun / service account ---
const mockConfig = vi.hoisted(() => ({
  config: {
    indexnow: { apiKey: "test-key", batchSize: 100 },
    site: { baseUrl: "https://trade.aero" },
    google: { serviceAccountJson: "", allLocales: false },
    indexing: { lookbackMinutes: 60, dryRun: false },
  },
}));

vi.mock("../config.js", () => mockConfig);

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// --- DB layer: capture every status-mutating call -------------------------
const db = vi.hoisted(() => ({
  fetchDueEvents: vi.fn(),
  markEventsAttempted: vi.fn(),
  markEventsSuccess: vi.fn(),
  markEventFailed: vi.fn(),
}));

vi.mock("../db/indexing-events.js", () => ({
  fetchDueEvents: db.fetchDueEvents,
  markEventsAttempted: db.markEventsAttempted,
  markEventsSuccess: db.markEventsSuccess,
  markEventFailed: db.markEventFailed,
}));

// --- Channels -------------------------------------------------------------
const channels = vi.hoisted(() => ({
  submitToIndexNow: vi.fn(),
  submitGoogleEvents: vi.fn(),
  pingGoogleSitemap: vi.fn(),
}));

vi.mock("../channels/indexnow.js", () => ({
  submitToIndexNow: channels.submitToIndexNow,
}));

vi.mock("../channels/google.js", () => ({
  submitGoogleEvents: channels.submitGoogleEvents,
  pingGoogleSitemap: channels.pingGoogleSitemap,
}));

import { submitPendingEvents } from "../jobs/submit.js";

function makeEvent(overrides: Partial<IndexingEvent> = {}): IndexingEvent {
  return {
    id: "evt-1",
    entity_type: "aircraft",
    entity_id: "listing-1",
    url: "https://trade.aero/aircraft/cessna-172-1",
    submitted_urls: ["https://trade.aero/aircraft/cessna-172-1"],
    published_at: new Date().toISOString(),
    channel: "indexnow",
    status: "pending",
    attempt_count: 0,
    last_attempt_at: null,
    next_retry_at: new Date().toISOString(),
    response_code: null,
    response_body: null,
    error_message: null,
    dedupe_key: "key-1-indexnow",
    correlation_id: "test-run",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.config.indexing.dryRun = false;
  mockConfig.config.google.serviceAccountJson = "";
  mockConfig.config.google.allLocales = false;
  db.markEventsAttempted.mockResolvedValue({ failed: 0 });
  db.markEventsSuccess.mockResolvedValue(undefined);
  db.markEventFailed.mockResolvedValue(undefined);
});

describe("submitPendingEvents — no work", () => {
  it("returns zeroed stats and touches nothing when there are no due events", async () => {
    db.fetchDueEvents.mockResolvedValue([]);

    const stats = await submitPendingEvents("corr-empty");

    expect(stats).toEqual({
      indexnowSuccess: 0,
      indexnowFailed: 0,
      googleSuccess: 0,
      googleFailed: 0,
      hardFailures: 0,
    });
    expect(db.markEventsAttempted).not.toHaveBeenCalled();
    expect(channels.submitToIndexNow).not.toHaveBeenCalled();
    expect(channels.submitGoogleEvents).not.toHaveBeenCalled();
    expect(channels.pingGoogleSitemap).not.toHaveBeenCalled();
  });
});

describe("submitPendingEvents — IndexNow channel", () => {
  it("marks all indexnow events success on a 200 response", async () => {
    const events = [
      makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 0 }),
      makeEvent({ id: "in-2", channel: "indexnow", attempt_count: 1 }),
    ];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitToIndexNow.mockResolvedValue({
      success: true,
      httpStatus: 200,
      responseBody: "OK",
      urlsSubmitted: 2,
    });

    const stats = await submitPendingEvents("corr-in-ok");

    expect(db.markEventsAttempted).toHaveBeenCalledTimes(1);
    expect(channels.submitToIndexNow).toHaveBeenCalledTimes(1);
    expect(db.markEventsSuccess).toHaveBeenCalledTimes(1);
    // attempt_count is bumped by 1 per event (authoritative count written
    // alongside the status).
    const [ids, code, , attemptCounts] = db.markEventsSuccess.mock.calls[0];
    expect(ids).toEqual(["in-1", "in-2"]);
    expect(code).toBe(200);
    expect(attemptCounts).toEqual({ "in-1": 1, "in-2": 2 });
    expect(stats.indexnowSuccess).toBe(2);
    expect(stats.indexnowFailed).toBe(0);
    expect(db.markEventFailed).not.toHaveBeenCalled();
  });

  it("marks events failed and schedules a retry on a 429 response", async () => {
    const events = [makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 1 })];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitToIndexNow.mockResolvedValue({
      success: false,
      httpStatus: 429,
      responseBody: "Too Many Requests",
      urlsSubmitted: 0,
    });

    const stats = await submitPendingEvents("corr-in-429");

    expect(db.markEventsSuccess).not.toHaveBeenCalled();
    expect(db.markEventFailed).toHaveBeenCalledTimes(1);
    const [id, code, , nextRetryAt, skip, newCount] =
      db.markEventFailed.mock.calls[0];
    expect(id).toBe("in-1");
    expect(code).toBe(429);
    expect(skip).toBe(false);
    expect(newCount).toBe(2); // attempt_count 1 -> 2
    expect(nextRetryAt).toBeInstanceOf(Date); // a retry is scheduled
    expect(stats.indexnowFailed).toBe(1);
    // 429 is transient (quota/rate-limit), not a misconfiguration — it must not
    // count as a hard failure or it would page on every Google quota cap.
    expect(stats.hardFailures).toBe(0);
  });

  it("counts a 403 batch rejection as a hard failure (silent-failure alert)", async () => {
    // The Apr 5–20 episode: IndexNow returns 403 "UserForbiddedToAccessSite"
    // for the whole batch. Each event is hard-failed so a completed run can
    // still raise a /fail ping.
    const events = [
      makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 0 }),
      makeEvent({ id: "in-2", channel: "indexnow", attempt_count: 0 }),
    ];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitToIndexNow.mockResolvedValue({
      success: false,
      httpStatus: 403,
      responseBody: "UserForbiddedToAccessSite",
      urlsSubmitted: 0,
    });

    const stats = await submitPendingEvents("corr-in-403");

    expect(stats.indexnowFailed).toBe(2);
    expect(stats.hardFailures).toBe(2);
  });

  it("marks the 5th failure as skipped (no further retry)", async () => {
    // attempt_count 4 -> 5 reaches MAX_ATTEMPTS, so the event is skipped.
    const events = [makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 4 })];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitToIndexNow.mockResolvedValue({
      success: false,
      httpStatus: 503,
      responseBody: "Service Unavailable",
      urlsSubmitted: 0,
    });

    await submitPendingEvents("corr-in-skip");

    expect(db.markEventFailed).toHaveBeenCalledTimes(1);
    const [id, , , nextRetryAt, skip, newCount] =
      db.markEventFailed.mock.calls[0];
    expect(id).toBe("in-1");
    expect(skip).toBe(true);
    expect(newCount).toBe(5);
    expect(nextRetryAt).toBeNull(); // no retry scheduled for a skipped event
  });
});

describe("submitPendingEvents — Google channel (Indexing API)", () => {
  beforeEach(() => {
    mockConfig.config.google.serviceAccountJson = JSON.stringify({
      client_email: "svc@example.com",
      private_key: "key",
    });
  });

  it("uses the Indexing API and marks per-event results", async () => {
    const events = [
      makeEvent({ id: "g-ok", channel: "google", attempt_count: 0 }),
      makeEvent({ id: "g-fail", channel: "google", attempt_count: 1 }),
    ];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitGoogleEvents.mockResolvedValue({
      usedIndexingApi: true,
      results: [
        { eventId: "g-ok", success: true, httpStatus: 200, responseBody: "OK" },
        {
          eventId: "g-fail",
          success: false,
          httpStatus: 500,
          responseBody: "Server Error",
        },
      ],
    });

    const stats = await submitPendingEvents("corr-g-api");

    expect(channels.submitGoogleEvents).toHaveBeenCalledTimes(1);
    expect(channels.pingGoogleSitemap).not.toHaveBeenCalled();

    // Successful event -> markEventsSuccess with bumped count
    expect(db.markEventsSuccess).toHaveBeenCalledTimes(1);
    const [okIds, , , okCounts] = db.markEventsSuccess.mock.calls[0];
    expect(okIds).toEqual(["g-ok"]);
    expect(okCounts).toEqual({ "g-ok": 1 });

    // Failed event (500) -> markEventFailed with a retry scheduled
    expect(db.markEventFailed).toHaveBeenCalledTimes(1);
    const [failId, , , nextRetryAt, skip, newCount] =
      db.markEventFailed.mock.calls[0];
    expect(failId).toBe("g-fail");
    expect(skip).toBe(false);
    expect(newCount).toBe(2);
    expect(nextRetryAt).toBeInstanceOf(Date);

    expect(stats.googleSuccess).toBe(1);
    expect(stats.googleFailed).toBe(1);
  });

  it("marks events skipped when the channel reports skipped (deprecated endpoint)", async () => {
    const events = [makeEvent({ id: "g-dep", channel: "google", attempt_count: 1 })];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitGoogleEvents.mockResolvedValue({
      usedIndexingApi: true,
      results: [
        {
          eventId: "g-dep",
          success: false,
          httpStatus: 404,
          responseBody: "Not Found",
          skipped: true,
        },
      ],
    });

    await submitPendingEvents("corr-g-skip");

    expect(db.markEventFailed).toHaveBeenCalledTimes(1);
    const [id, , , nextRetryAt, skip] = db.markEventFailed.mock.calls[0];
    expect(id).toBe("g-dep");
    expect(skip).toBe(true);
    expect(nextRetryAt).toBeNull();
  });
});

describe("submitPendingEvents — Google channel (sitemap ping fallback)", () => {
  it("falls back to the sitemap ping when no service account is configured", async () => {
    const events = [makeEvent({ id: "g-1", channel: "google", attempt_count: 0 })];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.pingGoogleSitemap.mockResolvedValue({
      usedIndexingApi: false,
      results: [
        { eventId: "g-1", success: true, httpStatus: 200, responseBody: "OK" },
      ],
    });

    const stats = await submitPendingEvents("corr-g-ping");

    expect(channels.pingGoogleSitemap).toHaveBeenCalledTimes(1);
    expect(channels.submitGoogleEvents).not.toHaveBeenCalled();
    expect(db.markEventsSuccess).toHaveBeenCalledTimes(1);
    expect(stats.googleSuccess).toBe(1);
  });
});

describe("submitPendingEvents — both channels in one run", () => {
  it("routes events to the correct channel and aggregates stats", async () => {
    const events = [
      makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 0 }),
      makeEvent({ id: "g-1", channel: "google", attempt_count: 0 }),
    ];
    db.fetchDueEvents.mockResolvedValue(events);
    channels.submitToIndexNow.mockResolvedValue({
      success: true,
      httpStatus: 202,
      responseBody: "Accepted",
      urlsSubmitted: 1,
    });
    channels.pingGoogleSitemap.mockResolvedValue({
      usedIndexingApi: false,
      results: [
        { eventId: "g-1", success: true, httpStatus: 200, responseBody: "OK" },
      ],
    });

    const stats = await submitPendingEvents("corr-both");

    // IndexNow batch received only the indexnow event's URL.
    const [indexnowUrls] = channels.submitToIndexNow.mock.calls[0];
    expect(indexnowUrls).toEqual(["https://trade.aero/aircraft/cessna-172-1"]);
    // Google ping received only the google event.
    const [googleEvents] = channels.pingGoogleSitemap.mock.calls[0];
    expect(googleEvents.map((e: IndexingEvent) => e.id)).toEqual(["g-1"]);

    expect(stats).toEqual({
      indexnowSuccess: 1,
      indexnowFailed: 0,
      googleSuccess: 1,
      googleFailed: 0,
      hardFailures: 0,
    });
  });
});

describe("submitPendingEvents — dry run", () => {
  it("does not call external channels or mutate attempt_count", async () => {
    mockConfig.config.indexing.dryRun = true;
    const events = [
      makeEvent({ id: "in-1", channel: "indexnow", attempt_count: 2 }),
      makeEvent({ id: "g-1", channel: "google", attempt_count: 3 }),
    ];
    db.fetchDueEvents.mockResolvedValue(events);

    const stats = await submitPendingEvents("corr-dry");

    // No external submission.
    expect(channels.submitToIndexNow).not.toHaveBeenCalled();
    expect(channels.submitGoogleEvents).not.toHaveBeenCalled();
    expect(channels.pingGoogleSitemap).not.toHaveBeenCalled();
    // Critically: dry runs must NOT touch attempt_count / last_attempt_at.
    expect(db.markEventsAttempted).not.toHaveBeenCalled();
    // Events are marked success with a "dry-run" body and NO attemptCounts arg.
    expect(db.markEventsSuccess).toHaveBeenCalledTimes(2);
    for (const call of db.markEventsSuccess.mock.calls) {
      expect(call[2]).toBe("dry-run");
      expect(call[3]).toBeUndefined();
    }
    expect(db.markEventFailed).not.toHaveBeenCalled();
    expect(stats.indexnowSuccess).toBe(1);
    expect(stats.googleSuccess).toBe(1);
  });
});
