import { logger } from "./logger.js";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch a URL with a hard timeout. Throws on network errors or non-2xx responses.
 */
export async function fetchWithTimeout(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`fetchWithTimeout failed for ${url}`, { error: msg });
    throw err;
  }
}
