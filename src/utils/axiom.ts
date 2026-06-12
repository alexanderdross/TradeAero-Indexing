import { logger } from "./logger.js";

const AXIOM_TIMEOUT_MS = 5_000;
const AXIOM_INGEST_BASE = "https://api.axiom.co/v1/datasets";

/** Minimal Axiom ingest config — `token`/`dataset` empty ⇒ disabled. */
export interface AxiomConfig {
  token: string;
  dataset: string;
  /** Optional org id header (needed only for some personal API tokens). */
  orgId?: string;
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

  try {
    const res = await fetch(
      `${AXIOM_INGEST_BASE}/${encodeURIComponent(axiom.dataset)}/ingest`,
      { method: "POST", headers, body, signal: AbortSignal.timeout(AXIOM_TIMEOUT_MS) },
    );
    if (!res.ok) {
      logger.warn("Axiom ingest non-OK (non-fatal)", {
        status: res.status,
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
