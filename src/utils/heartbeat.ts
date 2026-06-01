import { logger } from "./logger.js";

const HEARTBEAT_TIMEOUT_MS = 5_000;

/**
 * Best-effort dead-man's-switch ping.
 *
 * Detects the failure mode behind the 2026-05-28 stall: a GitHub-hosted
 * `schedule:` cron can silently stop firing for days, and nothing alerts
 * because a workflow that never runs produces no logs and no error. An
 * external monitor (healthchecks.io / cronitor / Better Uptime) expects a
 * ping on every successful run and raises an alert when one doesn't arrive
 * within its grace window.
 *
 * - No-op when `url` is empty (local dev / pre-prod) — monitoring is opt-in.
 * - Never throws: a monitoring hiccup must never break or fail the indexing run.
 * - `status="fail"` pings the `<url>/fail` sub-path so a *failing* run is
 *   recorded distinctly from a *missing* run (both are actionable, differently).
 */
export async function pingHeartbeat(
  url: string,
  status: "success" | "fail",
  correlationId: string,
): Promise<void> {
  if (!url) return;
  const target = status === "fail" ? `${url.replace(/\/$/, "")}/fail` : url;
  try {
    await fetch(target, {
      method: "POST",
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    logger.debug("Heartbeat sent", { status, correlationId });
  } catch (err) {
    logger.warn("Heartbeat ping failed (non-fatal)", {
      status,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
