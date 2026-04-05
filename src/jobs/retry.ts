/** Maximum number of submission attempts before an event is marked 'skipped' */
export const MAX_ATTEMPTS = 5;

const BASE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DELAY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Compute when to schedule the next retry after a failed attempt.
 *
 * @param newAttemptCount - The attempt_count AFTER the current failed attempt
 *
 * Retry schedule (approximate, +/- 10% jitter):
 * | New attempt_count | Delay  |
 * |-------------------|--------|
 * | 1                 | ~5 min |
 * | 2                 | ~10 min|
 * | 3                 | ~20 min|
 * | 4                 | ~40 min|
 * | 5+                | skip   |
 */
export function computeNextRetryAt(newAttemptCount: number): Date {
  const exponent = newAttemptCount - 1; // 0-indexed
  const base = BASE_DELAY_MS * Math.pow(2, exponent);
  const capped = Math.min(base, MAX_DELAY_MS);
  const jitter = capped * 0.1 * (Math.random() * 2 - 1); // ±10%
  return new Date(Date.now() + capped + jitter);
}

/**
 * Returns true if the event should be permanently abandoned (no more retries).
 *
 * @param newAttemptCount - The attempt_count AFTER the current failed attempt
 */
export function shouldAbortRetrying(newAttemptCount: number): boolean {
  return newAttemptCount >= MAX_ATTEMPTS;
}
