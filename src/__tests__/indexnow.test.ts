import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    indexnow: { apiKey: "test-key-abc123", batchSize: 100 },
    site: { baseUrl: "https://trade.aero" },
    google: { serviceAccountJson: "", allLocales: false },
    indexing: { lookbackMinutes: 60, dryRun: false },
  },
}));

vi.mock("../utils/fetch.js", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { submitToIndexNow } from "../channels/indexnow.js";
import { fetchWithTimeout } from "../utils/fetch.js";

const mockFetch = vi.mocked(fetchWithTimeout);

function makeResponse(status: number, body = ""): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("submitToIndexNow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns success with 0 urls when list is empty — no fetch call made", async () => {
    const result = await submitToIndexNow([], "corr-empty");
    expect(result.success).toBe(true);
    expect(result.urlsSubmitted).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns success on HTTP 200", async () => {
    mockFetch.mockResolvedValue(makeResponse(200));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-200");
    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.urlsSubmitted).toBe(1);
  });

  it("returns success on HTTP 202", async () => {
    mockFetch.mockResolvedValue(makeResponse(202, "Accepted"));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-202");
    expect(result.success).toBe(true);
    expect(result.httpStatus).toBe(202);
  });

  it("returns failure on HTTP 403 (key file not found)", async () => {
    mockFetch.mockResolvedValue(makeResponse(403, "Forbidden"));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-403");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(403);
  });

  it("returns failure on HTTP 422 (URL host mismatch)", async () => {
    mockFetch.mockResolvedValue(makeResponse(422, "Unprocessable"));
    const result = await submitToIndexNow(["https://other.com/page"], "corr-422");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(422);
  });

  it("returns failure on HTTP 429 (rate limited)", async () => {
    mockFetch.mockResolvedValue(makeResponse(429, "Too Many Requests"));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-429");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(429);
  });

  it("returns failure on HTTP 500 (server error)", async () => {
    mockFetch.mockResolvedValue(makeResponse(500, "Internal Server Error"));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-500");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(500);
  });

  it("returns failure and includes message on network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network timeout"));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test-1"], "corr-err");
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(0);
    expect(result.responseBody).toContain("Network timeout");
  });

  it("sends correct JSON payload — host, key, keyLocation, urlList", async () => {
    mockFetch.mockResolvedValue(makeResponse(202));
    await submitToIndexNow(
      ["https://trade.aero/aircraft/slug-en", "https://trade.aero/de/flugzeuge/slug-de"],
      "corr-payload"
    );
    const [_url, init] = mockFetch.mock.calls[0];
    const payload = JSON.parse(init!.body as string);
    expect(payload.host).toBe("trade.aero");
    expect(payload.key).toBe("test-key-abc123");
    expect(payload.keyLocation).toBe("https://trade.aero/test-key-abc123.txt");
    expect(payload.urlList).toHaveLength(2);
  });

  it("derives host from SITE_BASE_URL — keyLocation matches base URL hostname", async () => {
    // Temporarily override config.site.baseUrl
    const { config } = await import("../config.js");
    const origBase = (config.site as { baseUrl: string }).baseUrl;
    (config.site as { baseUrl: string }).baseUrl = "https://refactor.trade.aero";
    mockFetch.mockResolvedValue(makeResponse(202));
    await submitToIndexNow(["https://refactor.trade.aero/aircraft/test"], "corr-baseurl");
    const payload = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(payload.host).toBe("refactor.trade.aero");
    expect(payload.keyLocation).toContain("https://refactor.trade.aero/");
    // Restore
    (config.site as { baseUrl: string }).baseUrl = origBase;
  });

  it("truncates responseBody to 500 chars", async () => {
    const longBody = "x".repeat(1000);
    mockFetch.mockResolvedValue(makeResponse(400, longBody));
    const result = await submitToIndexNow(["https://trade.aero/aircraft/test"], "corr-trunc");
    expect(result.responseBody).toHaveLength(500);
  });
});
