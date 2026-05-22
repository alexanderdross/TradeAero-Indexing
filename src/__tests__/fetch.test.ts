import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchWithTimeout } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns the response on success", async () => {
    const response = new Response("ok", { status: 200 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(fetchWithTimeout("https://example.com")).resolves.toBe(response);
  });

  it("forwards request options and attaches an abort signal", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await fetchWithTimeout("https://example.com", { method: "POST" });
    const [, options] = fetchSpy.mock.calls[0];
    expect(options?.method).toBe("POST");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rethrows and logs a warning when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(fetchWithTimeout("https://example.com")).rejects.toThrow(
      "network down",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com"),
      { error: "network down" },
    );
  });

  it("stringifies non-Error rejection values for the log context", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("plain string failure");
    await expect(fetchWithTimeout("https://example.com")).rejects.toBe(
      "plain string failure",
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      error: "plain string failure",
    });
  });
});
