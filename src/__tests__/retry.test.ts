import { describe, it, expect } from "vitest";
import { computeNextRetryAt, shouldAbortRetrying, MAX_ATTEMPTS } from "../jobs/retry.js";

describe("shouldAbortRetrying", () => {
  it(`returns false for attempt counts below MAX_ATTEMPTS (${MAX_ATTEMPTS})`, () => {
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(shouldAbortRetrying(i)).toBe(false);
    }
  });

  it(`returns true at MAX_ATTEMPTS (${MAX_ATTEMPTS})`, () => {
    expect(shouldAbortRetrying(MAX_ATTEMPTS)).toBe(true);
  });

  it("returns true above MAX_ATTEMPTS", () => {
    expect(shouldAbortRetrying(MAX_ATTEMPTS + 1)).toBe(true);
  });
});

describe("computeNextRetryAt", () => {
  const BASE_DELAY_MINUTES = 5;

  it("schedules first retry approximately 5 minutes in the future", () => {
    const now = Date.now();
    const retry = computeNextRetryAt(1);
    const diffMs = retry.getTime() - now;
    const expectedMs = BASE_DELAY_MINUTES * 60 * 1000; // 5 min
    // Allow 20% tolerance for jitter
    expect(diffMs).toBeGreaterThan(expectedMs * 0.8);
    expect(diffMs).toBeLessThan(expectedMs * 1.2);
  });

  it("doubles the delay for each subsequent attempt", () => {
    const now = Date.now();
    const retry1 = computeNextRetryAt(1).getTime() - now;
    const retry2 = computeNextRetryAt(2).getTime() - now;
    const retry3 = computeNextRetryAt(3).getTime() - now;
    // Each delay should be roughly double the previous (within 30% for jitter)
    expect(retry2 / retry1).toBeGreaterThan(1.4);
    expect(retry2 / retry1).toBeLessThan(2.6);
    expect(retry3 / retry2).toBeGreaterThan(1.4);
    expect(retry3 / retry2).toBeLessThan(2.6);
  });

  it("always returns a future date", () => {
    const now = Date.now();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(computeNextRetryAt(i).getTime()).toBeGreaterThan(now);
    }
  });

  it("caps delay at 24 hours", () => {
    const now = Date.now();
    const maxDelayMs = 24 * 60 * 60 * 1000;
    // Test a very high attempt count to trigger the cap
    const retry = computeNextRetryAt(20);
    const diffMs = retry.getTime() - now;
    // Allow 20% tolerance for jitter around the max
    expect(diffMs).toBeLessThan(maxDelayMs * 1.2);
  });
});
