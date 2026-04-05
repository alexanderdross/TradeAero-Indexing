import { createSign } from "crypto";
import { fetchWithTimeout } from "../utils/fetch.js";
import { logger } from "../utils/logger.js";
import type { IndexingEvent } from "../types.js";

const INDEXING_API_ENDPOINT =
  "https://indexing.googleapis.com/v3/urlNotifications:publish";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
const GOOGLE_PING_ENDPOINT = "https://www.google.com/ping";
const SITEMAP_URL = "https://trade.aero/sitemap.xml";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export interface GoogleEventResult {
  eventId: string;
  success: boolean;
  httpStatus: number;
  responseBody: string;
  skipped?: boolean;
}

export interface GoogleBatchResult {
  results: GoogleEventResult[];
  /** true = used Indexing API; false = fell back to sitemap ping */
  usedIndexingApi: boolean;
}

// ---------------------------------------------------------------------------
// JWT + OAuth2
// ---------------------------------------------------------------------------

function createSignedJWT(serviceAccount: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: INDEXING_SCOPE,
      aud: TOKEN_ENDPOINT,
      exp: now + 3600,
      iat: now,
    })
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(serviceAccount.private_key, "base64url");
  return `${signingInput}.${signature}`;
}

async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccount;
  const jwt = createSignedJWT(serviceAccount);

  const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google token exchange failed: ${response.status} ${body.slice(0, 200)}`
    );
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Per-URL submission
// ---------------------------------------------------------------------------

async function submitOneUrl(
  url: string,
  accessToken: string
): Promise<{ status: number; body: string }> {
  const response = await fetchWithTimeout(INDEXING_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ url, type: "URL_UPDATED" }),
  });
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit indexing events to the Google Indexing API using a Service Account.
 *
 * Each event submits its canonical English URL (`url` field) by default.
 * Pass `allLocales = true` to submit all 14 locale URLs per event instead
 * (costs 14× quota — use only if daily limit allows it).
 *
 * Google Indexing API daily quota: 200 URL notifications per Search Console
 * property.  At 1 URL/event → up to ~200 new listings/day; at 14 URLs/event
 * → ~14 listings/day.  Quota resets at midnight Pacific time.
 *
 * Returns per-event results so the caller can mark each event individually.
 */
export async function submitGoogleEvents(
  events: IndexingEvent[],
  serviceAccountJson: string,
  allLocales: boolean,
  correlationId: string
): Promise<GoogleBatchResult> {
  let accessToken: string;
  try {
    accessToken = await getAccessToken(serviceAccountJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Google Indexing API: failed to get access token", {
      error: msg,
      correlationId,
    });
    return {
      usedIndexingApi: true,
      results: events.map((e) => ({
        eventId: e.id,
        success: false,
        httpStatus: 0,
        responseBody: msg.slice(0, 500),
      })),
    };
  }

  const results: GoogleEventResult[] = [];
  let quotaExceeded = false;

  for (const event of events) {
    if (quotaExceeded) {
      results.push({
        eventId: event.id,
        success: false,
        httpStatus: 429,
        responseBody: "quota exceeded earlier in this batch",
      });
      continue;
    }

    const urls = allLocales
      ? ((event.submitted_urls as string[]) ?? [event.url])
      : [event.url];

    let eventSuccess = true;
    let lastStatus = 200;
    let lastBody = "";

    for (const url of urls) {
      try {
        const { status, body } = await submitOneUrl(url, accessToken);
        lastStatus = status;
        lastBody = body;

        if (status === 200) {
          logger.debug("Google Indexing API: submitted", { url, correlationId });
        } else if (status === 429 || status >= 500) {
          quotaExceeded = status === 429;
          eventSuccess = false;
          logger.warn("Google Indexing API: rate limited / server error", {
            url,
            status,
            correlationId,
          });
          break;
        } else {
          // 400-level errors (except 429) are permanent — mark event as failed
          eventSuccess = false;
          logger.warn("Google Indexing API: submission rejected", {
            url,
            status,
            body: body.slice(0, 200),
            correlationId,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        eventSuccess = false;
        lastBody = msg.slice(0, 500);
        logger.warn("Google Indexing API: request error", {
          url,
          error: msg,
          correlationId,
        });
      }
    }

    results.push({
      eventId: event.id,
      success: eventSuccess,
      httpStatus: lastStatus,
      responseBody: lastBody,
    });
  }

  const submitted = results.filter((r) => r.success).length;
  logger.info("Google Indexing API: batch complete", {
    submitted,
    failed: results.length - submitted,
    allLocales,
    correlationId,
  });

  return { usedIndexingApi: true, results };
}

/**
 * Fallback: notify Google by pinging the sitemap endpoint (no auth required).
 * One ping per run covers all listings via hreflang tags in the sitemap.
 * Used automatically when GOOGLE_SERVICE_ACCOUNT_JSON is not configured.
 *
 * NOTE: Google deprecated and removed this endpoint in January 2024.
 * A 404 response is expected — events are marked 'skipped' rather than
 * 'failed' so they do not keep retrying. Set GOOGLE_SERVICE_ACCOUNT_JSON
 * to use the proper Google Indexing API instead.
 */
export async function pingGoogleSitemap(
  events: IndexingEvent[],
  correlationId: string
): Promise<GoogleBatchResult> {
  const pingUrl = `${GOOGLE_PING_ENDPOINT}?sitemap=${encodeURIComponent(SITEMAP_URL)}`;

  try {
    const response = await fetchWithTimeout(pingUrl, { method: "GET" });
    const responseBody = (await response.text()).slice(0, 500);

    // Google removed the ping endpoint in Jan 2024 — 404 is expected.
    // Treat as skipped (not failed) so events don't retry indefinitely.
    const isDeprecated = response.status === 404;
    if (isDeprecated) {
      logger.warn(
        "Google sitemap ping: endpoint deprecated (404) — mark events skipped. Add GOOGLE_SERVICE_ACCOUNT_JSON for proper indexing.",
        { correlationId }
      );
    } else {
      logger.info("Google sitemap ping", {
        status: response.status,
        correlationId,
      });
    }

    return {
      usedIndexingApi: false,
      results: events.map((e) => ({
        eventId: e.id,
        success: response.ok,
        skipped: isDeprecated,
        httpStatus: response.status,
        responseBody,
      })),
    };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.warn("Google sitemap ping error", { error: msg, correlationId });
    return {
      usedIndexingApi: false,
      results: events.map((e) => ({
        eventId: e.id,
        success: false,
        httpStatus: 0,
        responseBody: msg,
      })),
    };
  }
}
