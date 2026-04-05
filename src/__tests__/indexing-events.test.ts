import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Supabase client
const mockUpdate = vi.fn();
const mockIn = vi.fn();
const mockEq = vi.fn();
const mockUpsert = vi.fn();
const mockSelect = vi.fn();
const mockOr = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

// Chain builder — each method returns the chain so .update().eq() works
const chain = {
  update: mockUpdate,
  in: mockIn,
  eq: mockEq,
  upsert: mockUpsert,
  select: mockSelect,
  or: mockOr,
  order: mockOrder,
  limit: mockLimit,
};

Object.values(chain).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain));

vi.mock("../db/client.js", () => ({
  supabase: { from: vi.fn().mockReturnValue(chain) },
}));

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { markEventsSuccess, markEventFailed, upsertIndexingEvent } from "../db/indexing-events.js";
import { supabase } from "../db/client.js";

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

describe("markEventsSuccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when ids array is empty", async () => {
    await markEventsSuccess([], 202, "ok");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("sets status=success and next_retry_at=FAR_FUTURE", async () => {
    mockIn.mockResolvedValue({ error: null });
    await markEventsSuccess(["id-1", "id-2"], 202, "Accepted");
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        next_retry_at: FAR_FUTURE,
        response_code: 202,
      })
    );
  });

  it("truncates responseBody to 500 chars", async () => {
    mockIn.mockResolvedValue({ error: null });
    const longBody = "x".repeat(1000);
    await markEventsSuccess(["id-1"], 200, longBody);
    const updateCall = mockUpdate.mock.calls[0][0];
    expect(updateCall.response_body).toHaveLength(500);
  });

  it("logs warning on DB error but does not throw", async () => {
    mockIn.mockResolvedValue({ error: { message: "DB error" } });
    await expect(markEventsSuccess(["id-1"], 200, "ok")).resolves.not.toThrow();
  });
});

describe("markEventFailed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets status=skipped and next_retry_at=FAR_FUTURE when skip=true", async () => {
    mockEq.mockResolvedValue({ error: null });
    await markEventFailed("id-1", 404, "Not Found", null, true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        next_retry_at: FAR_FUTURE,
      })
    );
  });

  it("sets status=failed and uses provided nextRetryAt when skip=false", async () => {
    mockEq.mockResolvedValue({ error: null });
    const retryAt = new Date("2026-05-01T00:00:00.000Z");
    await markEventFailed("id-1", 500, "Server Error", retryAt, false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        next_retry_at: retryAt.toISOString(),
      })
    );
  });

  it("uses FAR_FUTURE when skip=false and nextRetryAt is null", async () => {
    mockEq.mockResolvedValue({ error: null });
    await markEventFailed("id-1", 429, "Rate limited", null, false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ next_retry_at: FAR_FUTURE })
    );
  });

  it("truncates responseBody to 500 chars", async () => {
    mockEq.mockResolvedValue({ error: null });
    await markEventFailed("id-1", 500, "z".repeat(1000), null, true);
    const updateCall = mockUpdate.mock.calls[0][0];
    expect(updateCall.response_body).toHaveLength(500);
  });

  it("logs warning on DB error but does not throw", async () => {
    mockEq.mockResolvedValue({ error: { message: "constraint violation" } });
    await expect(markEventFailed("id-1", 500, "err", null, true)).resolves.not.toThrow();
  });
});

describe("upsertIndexingEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true on successful insert", async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const event = {
      entity_type: "aircraft" as const,
      entity_id: "abc",
      url: "https://trade.aero/aircraft/test",
      published_at: new Date().toISOString(),
      channel: "indexnow" as const,
      status: "pending" as const,
      attempt_count: 0,
      next_retry_at: new Date().toISOString(),
      dedupe_key: "sha256key",
    };
    const result = await upsertIndexingEvent(event);
    expect(result).toBe(true);
  });

  it("returns false and logs warning on DB error", async () => {
    mockUpsert.mockResolvedValue({ error: { message: "unique violation" } });
    const event = {
      entity_type: "aircraft" as const,
      entity_id: "abc",
      url: "https://trade.aero/aircraft/test",
      published_at: new Date().toISOString(),
      channel: "indexnow" as const,
      status: "pending" as const,
      attempt_count: 0,
      next_retry_at: new Date().toISOString(),
      dedupe_key: "sha256key",
    };
    const result = await upsertIndexingEvent(event);
    expect(result).toBe(false);
  });
});
