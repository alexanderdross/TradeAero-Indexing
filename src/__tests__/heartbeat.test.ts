import { describe, it, expect, vi, afterEach } from "vitest";
import { pingHeartbeat, isRunUnhealthy } from "../utils/heartbeat.js";
import type { SubmitStats } from "../types.js";

describe("pingHeartbeat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops (no fetch) when the url is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await pingHeartbeat("", "success", "cid");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pings the base url on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await pingHeartbeat("https://hc.example/abc", "success", "cid");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hc.example/abc");
  });

  it("pings the /fail sub-path on failure (and trims a trailing slash)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await pingHeartbeat("https://hc.example/abc/", "fail", "cid");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hc.example/abc/fail");
  });

  it("never throws when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(
      pingHeartbeat("https://hc.example/abc", "success", "cid"),
    ).resolves.toBeUndefined();
  });

  it("REGRESSION: pings with POST and an abort signal (timeout)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await pingHeartbeat("https://hc.example/abc", "success", "cid");
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("REGRESSION: success path never appends /fail (even with trailing slash)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await pingHeartbeat("https://hc.example/abc/", "success", "cid");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://hc.example/abc/");
  });
});

describe("isRunUnhealthy", () => {
  const base: SubmitStats = {
    indexnowSuccess: 0,
    indexnowFailed: 0,
    googleSuccess: 0,
    googleFailed: 0,
    hardFailures: 0,
  };

  it("is healthy when nothing was attempted (idle run)", () => {
    expect(isRunUnhealthy(base, 0.5)).toBe(false);
  });

  it("is healthy when there are no hard failures (e.g. all-success run)", () => {
    expect(
      isRunUnhealthy({ ...base, indexnowSuccess: 10, googleSuccess: 10 }, 0.5),
    ).toBe(false);
  });

  it("does NOT flip on Google quota 429s (counted in googleFailed, not hardFailures)", () => {
    // 10 indexnow ok + 10 google quota-skipped → 50% failed but 0 hard.
    expect(
      isRunUnhealthy(
        { ...base, indexnowSuccess: 10, googleSuccess: 0, googleFailed: 10 },
        0.5,
      ),
    ).toBe(false);
  });

  it("flips when a whole channel hard-fails (the 403 episode)", () => {
    // 10 indexnow hard-failed + 10 google ok → 10/20 = 0.5 ≥ threshold.
    expect(
      isRunUnhealthy(
        {
          ...base,
          indexnowFailed: 10,
          hardFailures: 10,
          googleSuccess: 10,
        },
        0.5,
      ),
    ).toBe(true);
  });

  it("does not flip on a single isolated hard failure among many successes", () => {
    expect(
      isRunUnhealthy(
        { ...base, indexnowSuccess: 99, googleSuccess: 100, indexnowFailed: 1, hardFailures: 1 },
        0.5,
      ),
    ).toBe(false);
  });
});
