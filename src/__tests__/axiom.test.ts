import { describe, it, expect, vi, afterEach } from "vitest";
import { emitRunEvent, type AxiomConfig } from "../utils/axiom.js";

const enabled: AxiomConfig = { token: "xaat-test", dataset: "tradeaero" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("emitRunEvent", () => {
  it("is a no-op (no fetch) when the token is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await emitRunEvent({ token: "", dataset: "tradeaero" }, { event: "run.complete" }, "c1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the dataset is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await emitRunEvent({ token: "xaat-test", dataset: "" }, { event: "run.complete" }, "c1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a single _time-stamped, service-tagged event to the ingest URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await emitRunEvent(enabled, { event: "run.complete", hardFailures: 0 }, "run-42");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Default domain + the `/v1/ingest/{dataset}` path.
    expect(url).toBe("https://api.axiom.co/v1/ingest/tradeaero");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xaat-test");

    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ service: "indexing", event: "run.complete", hardFailures: 0 });
    expect(typeof body[0]._time).toBe("string");
  });

  it("ingests to a configured (edge) domain, normalising scheme/trailing slash", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await emitRunEvent(
      { ...enabled, domain: "https://eu-central-1.aws.edge.axiom.co/" },
      { event: "run.complete" },
      "c1",
    );
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eu-central-1.aws.edge.axiom.co/v1/ingest/tradeaero");
  });

  it("adds the org-id header only when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await emitRunEvent({ ...enabled, orgId: "org-123" }, { event: "run.complete" }, "c1");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Axiom-Org-Id"]).toBe("org-123");
  });

  it("never throws when fetch rejects (best-effort)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(
      emitRunEvent(enabled, { event: "run.complete" }, "c1"),
    ).resolves.toBeUndefined();
  });
});
