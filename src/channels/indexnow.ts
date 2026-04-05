import { fetchWithTimeout } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/IndexNow";
/** IndexNow supports up to 10,000 URLs per request */
const MAX_URLS_PER_REQUEST = 10_000;

export interface IndexNowResult {
  success: boolean;
  httpStatus: number;
  responseBody: string;
  urlsSubmitted: number;
}

/**
 * Submit a batch of URLs to IndexNow.
 *
 * IndexNow accepts up to 10,000 URLs per POST request. If urlList exceeds
 * this limit, it is automatically chunked into multiple requests.
 *
 * Response codes:
 * - 200/202: Accepted (success)
 * - 400: Bad request (invalid payload)
 * - 403: Forbidden (key file not found or mismatch at https://{host}/{key}.txt)
 * - 422: Unprocessable (URLs don't match the declared host)
 * - 429: Rate limited (retry with backoff)
 * - 5xx: Server error (retry with backoff)
 */
export async function submitToIndexNow(
  urls: string[],
  correlationId: string,
): Promise<IndexNowResult> {
  if (urls.length === 0) {
    return { success: true, httpStatus: 0, responseBody: "", urlsSubmitted: 0 };
  }

  const key = config.indexnow.apiKey;
  // Derive host from configurable base URL so key verification file matches
  const host = new URL(config.site.baseUrl).hostname;
  const keyLocation = `https://${host}/${key}.txt`;

  // Chunk if somehow over the IndexNow limit
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
    chunks.push(urls.slice(i, i + MAX_URLS_PER_REQUEST));
  }

  let lastResult: IndexNowResult = { success: true, httpStatus: 0, responseBody: "", urlsSubmitted: 0 };

  for (const chunk of chunks) {
    const payload = {
      host,
      key,
      keyLocation,
      urlList: chunk,
    };

    try {
      const response = await fetchWithTimeout(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });

      const responseBody = await response.text();
      const success = response.status === 200 || response.status === 202;

      logger.info("IndexNow submission", {
        status: response.status,
        urlCount: chunk.length,
        correlationId,
      });

      lastResult = {
        success,
        httpStatus: response.status,
        responseBody: responseBody.slice(0, 500),
        urlsSubmitted: chunk.length,
      };

      if (!success) {
        logger.warn("IndexNow submission failed", {
          status: response.status,
          body: responseBody.slice(0, 200),
          correlationId,
        });
        return lastResult;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("IndexNow submission error", { error: msg, correlationId });
      lastResult = { success: false, httpStatus: 0, responseBody: msg.slice(0, 500), urlsSubmitted: 0 };
      return lastResult;
    }
  }

  return lastResult;
}
