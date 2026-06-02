import { logger } from "./logger.js";
import type { SubmitStats } from "../types.js";

const HEARTBEAT_TIMEOUT_MS = 5_000;

/**
 * Decide whether a *completed* run should be reported as unhealthy (ping
 * `/fail`) rather than healthy. True when the run did real work and the share
 * of hard (unexpected) failures meets the threshold.
 *
 * Why this exists: the heartbeat proves the job *ran*, but a run can finish
 * "successfully" while a channel rejects every URL (the Apr 5–20 IndexNow 403
 * episode emitted no error and no missing ping). Only `hardFailures` count, so
 * idle runs (0 attempts) and Google's expected quota 429s never flip a run to
 * unhealthy.
 *
 * @param threshold hard-failure ratio in [0, 1]; >1 effectively disables it.
 */
export function isRunUnhealthy(stats: SubmitStats, threshold: number): boolean {
  const attempted =
    stats.indexnowSuccess +
    stats.indexnowFailed +
    stats.googleSuccess +
    stats.googleFailed;
  if (attempted === 0 || stats.hardFailures === 0) return false;
  return stats.hardFailures / attempted >= threshold;
}

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
