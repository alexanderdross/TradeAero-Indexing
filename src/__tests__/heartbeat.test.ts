import { describe, it, expect, vi, afterEach } from "vitest";
import { pingHeartbeat } from "../utils/heartbeat.js";

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
});
