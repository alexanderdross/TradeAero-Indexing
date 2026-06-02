import { validateConfig, config } from "./config.js";
import { discoverAndEnqueue } from "./jobs/discover.js";
import { submitPendingEvents } from "./jobs/submit.js";
import { logger } from "./utils/logger.js";
import { pingHeartbeat, isRunUnhealthy } from "./utils/heartbeat.js";

async function main(): Promise<void> {
  // Pre-prod kill switch. The `production` GitHub Environment leaves
  // INDEXING_ENABLED unset so the workflow exits cleanly without touching
  // external search engines while trade.aero is still gated. Flip it on
  // once trade.aero goes public.
  if (process.env.INDEXING_ENABLED !== "true") {
    logger.info("INDEXING_ENABLED is not 'true'; exiting without submitting.", {
      branch: process.env.GITHUB_REF_NAME ?? "(unknown)",
    });
    return;
  }

  validateConfig();

  // Use GitHub Actions run ID as correlation ID for easy log tracing
  const correlationId = process.env.GITHUB_RUN_ID ?? `manual-${Date.now()}`;
  const startTime = Date.now();

  logger.info("TradeAero Indexing starting", {
    correlationId,
    lookbackMinutes: config.indexing.lookbackMinutes,
    dryRun: config.indexing.dryRun,
  });

  // Phase 1: find newly published listings and insert pending indexing events
  const enqueued = await discoverAndEnqueue(correlationId);

  // Phase 2: submit all pending events (new + retry-due) to IndexNow and Google
  const stats = await submitPendingEvents(correlationId);

  const durationMs = Date.now() - startTime;
  logger.info("TradeAero Indexing complete", {
    correlationId,
    enqueued,
    ...stats,
    durationMs,
  });

  // Dead-man's-switch: signal a healthy completed run so an external monitor
  // can alert if the GitHub Actions schedule ever stops firing (no-op unless
  // HEARTBEAT_URL is configured). A run that *completes* but had a channel
  // reject (nearly) every URL pings `/fail` instead — otherwise a silent
  // misconfiguration (e.g. an unverified IndexNow domain) would keep the
  // monitor green while nothing actually gets indexed.
  const unhealthy = isRunUnhealthy(stats, config.monitoring.failureAlertThreshold);
  if (unhealthy) {
    logger.warn(
      "Run completed but hard-failure rate crossed alert threshold — pinging /fail",
      { correlationId, threshold: config.monitoring.failureAlertThreshold, ...stats },
    );
  }
  await pingHeartbeat(
    config.monitoring.heartbeatUrl,
    unhealthy ? "fail" : "success",
    correlationId,
  );
}

main().catch(async (err) => {
  logger.error("Fatal error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  await pingHeartbeat(
    config.monitoring.heartbeatUrl,
    "fail",
    process.env.GITHUB_RUN_ID ?? "unknown",
  );
  process.exit(1);
});
