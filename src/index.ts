// Initialise Sentry before anything else so the SDK is ready before app code
// runs. No-op when SENTRY_DSN is unset.
import "./instrument.js";
import * as Sentry from "@sentry/node";

import { validateConfig, config } from "./config.js";
import { discoverAndEnqueue } from "./jobs/discover.js";
import { submitPendingEvents } from "./jobs/submit.js";
import { logger } from "./utils/logger.js";
import { pingHeartbeat, isRunUnhealthy } from "./utils/heartbeat.js";
import { emitRunEvent } from "./utils/axiom.js";

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
    // A completed-but-failing run emits no exception, so it would never reach
    // Sentry via the fatal-error path. Capture it explicitly (tagged so it
    // groups separately from crashes) — the Apr 5–20 IndexNow-403 silent-failure
    // mode the dead-man's-switch alone can't see.
    Sentry.captureMessage(
      "Indexing run completed but hard-failure rate crossed alert threshold",
      {
        level: "error",
        tags: { signal: "silent-failure" },
        extra: { correlationId, threshold: config.monitoring.failureAlertThreshold, ...stats },
      },
    );
  }
  await pingHeartbeat(
    config.monitoring.heartbeatUrl,
    unhealthy ? "fail" : "success",
    correlationId,
  );

  // Ship a real "the worker ran" signal to Axiom (no-op when unconfigured). The
  // dashboard's DB-derived heartbeat freezes on a drained queue and false-reads
  // "stalled"; this event advances on every completed run, idle included.
  await emitRunEvent(
    config.monitoring.axiom,
    {
      event: "run.complete",
      correlationId,
      enqueued,
      durationMs,
      dryRun: config.indexing.dryRun,
      healthy: !unhealthy,
      release: process.env.GITHUB_SHA,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.GITHUB_REF_NAME,
      ...stats,
    },
    correlationId,
  );

  // Flush buffered Sentry events before this short-lived process exits, or the
  // captureMessage above (and any breadcrumbs) are lost. No-op when DSN unset.
  await Sentry.flush(2000);
}

main().catch(async (err) => {
  logger.error("Fatal error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  const correlationId = process.env.GITHUB_RUN_ID ?? "unknown";
  // Report to Sentry (no-op when unset) before exiting. flush() must complete
  // or the buffered event is lost when the short-lived process dies.
  Sentry.captureException(err);
  await pingHeartbeat(config.monitoring.heartbeatUrl, "fail", correlationId);
  await emitRunEvent(
    config.monitoring.axiom,
    {
      event: "run.error",
      correlationId,
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    },
    correlationId,
  );
  await Sentry.flush(2000);
  process.exit(1);
});
