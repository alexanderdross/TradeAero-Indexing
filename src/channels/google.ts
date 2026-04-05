import { fetchWithTimeout } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";

const GOOGLE_PING_ENDPOINT = "https://www.google.com/ping";
const SITEMAP_URL = "https://trade.aero/2d6a9a/sitemap.xml";

export interface GooglePingResult {
  success: boolean;
  httpStatus: number;
  responseBody: string;
}

/**
 * Notify Google that the sitemap has been updated by pinging the sitemap
 * submission endpoint. This is called ONCE per run (not per listing).
 *
 * Google’s ping signals it to re-crawl the sitemap, which covers all locale
 * variants via hreflang alternate links already present in the sitemap.
 *
 * Note: Google deprecated per-URL pinging (google.com/ping?url=) —
 * sitemap pinging (google.com/ping?sitemap=) is the compliant approach.
 */
export async function pingGoogleSitemap(
  correlationId: string,
): Promise<GooglePingResult> {
  const url = `${GOOGLE_PING_ENDPOINT}?sitemap=${encodeURIComponent(SITEMAP_URL)}`;

  try {
    const response = await fetchWithTimeout(url, { method: "GET" });
    const responseBody = await response.text();

    logger.info("Google sitemap ping", {
      status: response.status,
      correlationId,
    });

    return {
      success: response.ok,
      httpStatus: response.status,
      responseBody: responseBody.slice(0, 500),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Google sitemap ping error", { error: msg, correlationId });
    return { success: false, httpStatus: 0, responseBody: msg.slice(0, 500) };
  }
}
