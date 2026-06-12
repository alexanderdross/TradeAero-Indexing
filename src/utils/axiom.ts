import { logger } from "./logger.js";

const AXIOM_TIMEOUT_MS = 5_000;
const AXIOM_DEFAULT_DOMAIN = "api.axiom.co";

/** Minimal Axiom ingest config — `token`/`dataset` empty ⇒ disabled. */
export interface AxiomConfig {
  token: string;
  dataset: string;
  /**
   * Axiom ingest domain. Default `api.axiom.co`. Orgs on a regional edge
   * deployment **must** point this at their edge domain (e.g.
   * `eu-central-1.aws.edge.axiom.co`) — ingesting to the default host returns
   * HTTP 400. Accepts a bare host or a full URL; the scheme/trailing slash are
   * normalised away.
   */
  domain?: string;
  /** Optional org id header (needed only for some personal API tokens). */
  orgId?: string;
}

/** Strip any scheme + trailing slash so we can rebuild a clean `https://` URL. */
function normaliseDomain(domain: string | undefined): string {
  const d = (domain || AXIOM_DEFAULT_DOMAIN).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return d || AXIOM_DEFAULT_DOMAIN;
}

/**
 * Best-effort ship of one structured run event to Axiom.
 *
 * Mirrors the heartbeat's contract: no-op when unconfigured, never throws,
 * short timeout — observability must never break or slow a run.
 *
 * Why it exists: the admin dashboard's freshness signal is derived from
 * `indexing_events.last_attempt_at`, which only advances when there is a due
 * event to submit. A fully-drained queue in a quiet window freezes it and the
 * pipeline falsely reads "stalled". A `run.complete` event emitted on every
 * completed run (idle ones included) is a *real* liveness signal that powers two
 * Axiom monitors the DB metric can't:
 *  - liveness: alert on "no `event: run.complete` in ~12h" (the 2026-05-28
 *    cron-stopped-firing stall — which produced no run, no logs, no error).
 *  - silent failure: alert on `hardFailures > 0` (the Apr 5–20 IndexNow 403s).
 */
export async function emitRunEvent(
  axiom: AxiomConfig,
  fields: Record<string, unknown>,
  correlationId: string,
): Promise<void> {
  if (!axiom.token || !axiom.dataset) return;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${axiom.token}`,
  };
  if (axiom.orgId) headers["X-Axiom-Org-Id"] = axiom.orgId;

  // Axiom uses the `_time` field as the event timestamp when present.
  const body = JSON.stringify([
    { _time: new Date().toISOString(), service: "indexing", ...fields },
  ]);

  // Ingest path is `/v1/ingest/{dataset}` on the deployment's (edge) domain.
  const url = `https://${normaliseDomain(axiom.domain)}/v1/ingest/${encodeURIComponent(axiom.dataset)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(AXIOM_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Surface Axiom's error body (truncated) — a 400 usually means a wrong
      // domain (regional edge) or malformed payload, both diagnosable here.
      const detail = await res.text().catch(() => "");
      logger.warn("Axiom ingest non-OK (non-fatal)", {
        status: res.status,
        body: detail.slice(0, 300),
        correlationId,
      });
    } else {
      logger.debug("Axiom run event sent", { correlationId });
    }
  } catch (err) {
    logger.warn("Axiom ingest failed (non-fatal)", {
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
