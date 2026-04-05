import { describe, it, expect } from "vitest";
import { computeDedupeKey } from "../utils/dedupe.js";

describe("computeDedupeKey", () => {
  it("returns a 64-character hex string (sha256)", () => {
    const key = computeDedupeKey("abc-123", "indexnow");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — same inputs always produce the same key", () => {
    const key1 = computeDedupeKey("entity-abc", "indexnow");
    const key2 = computeDedupeKey("entity-abc", "indexnow");
    expect(key1).toBe(key2);
  });

  it("differs by channel", () => {
    const indexnow = computeDedupeKey("entity-abc", "indexnow");
    const google = computeDedupeKey("entity-abc", "google");
    expect(indexnow).not.toBe(google);
  });

  it("differs by entity ID", () => {
    const key1 = computeDedupeKey("entity-001", "indexnow");
    const key2 = computeDedupeKey("entity-002", "indexnow");
    expect(key1).not.toBe(key2);
  });

  it("uses | as separator — entity-1|indexnow differs from entity|1indexnow", () => {
    const key1 = computeDedupeKey("entity-1", "indexnow");
    const key2 = computeDedupeKey("entity", "1indexnow");
    expect(key1).not.toBe(key2);
  });
});
