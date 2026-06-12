import "dotenv/config";

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },
  site: {
    /**
     * Base URL of the live production site.
     * All submitted URLs are built from this base.
     * Only set this to the domain that is publicly live — search engines
     * will attempt to crawl the submitted URLs immediately.
     */
    baseUrl: (process.env.SITE_BASE_URL ?? "https://trade.aero").replace(/\/$/, ""),
  },
  indexnow: {
    apiKey: process.env.INDEXNOW_API_KEY ?? "",
    /** Max listings per IndexNow batch (each listing = 14 locale URLs) */
    batchSize: Number(process.env.INDEXNOW_BATCH_SIZE ?? 100),
  },
  google: {
    /**
     * Full Google Service Account JSON string (from GCP → IAM → Service Accounts).
     * When set, the indexer submits URLs directly to the Google Indexing API (fast).
     * When empty, falls back to a sitemap ping (slower — Google decides when to crawl).
     */
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
    /**
     * When true, submit all 14 locale URLs per listing to the Indexing API.
     * Default false = submit only the canonical English URL (~200 listings/day quota).
     * Set true only if you have increased quota from Google (200 URL/day default limit).
     */
    allLocales: process.env.GOOGLE_INDEXING_ALL_LOCALES === "true",
  },
  indexing: {
    /**
     * Lookback window in minutes for detecting newly published listings.
     * Default 1440 (24h), not 60: the GitHub Actions schedule is throttled to
     * runs hours apart, so a 60-minute window dropped listings updated between
     * runs. Must exceed the worst-case inter-run gap. dedupe_key keeps the wider
     * re-scan idempotent (already-indexed listings are skipped at insert).
     */
    lookbackMinutes: Number(process.env.INDEXING_LOOKBACK_MINUTES ?? 1440),
    /** When true, skip external API calls — useful for validating URL generation */
    dryRun: process.env.INDEXING_DRY_RUN === "true",
    /**
     * Max rows fetched per source table per run (ordered by updated_at DESC).
     * Default 500 keeps normal runs bounded. Raise it (e.g. for a historical
     * backfill) so the older, never-indexed backlog isn't crowded out below the
     * cap. dedupe_key keeps the wider scan idempotent.
     */
    discoveryLimit: Number(process.env.INDEXING_DISCOVERY_LIMIT ?? 500),
  },
  monitoring: {
    /**
     * Optional dead-man's-switch URL (healthchecks.io / cronitor / Better Uptime).
     * Pinged after every healthy run; `<url>/fail` is pinged on a fatal error OR
     * a completed-but-silently-failing run (see failureAlertThreshold).
     * When unset, the heartbeat is a no-op. Lets an external monitor alert when
     * the GitHub Actions schedule silently stops firing — the failure mode behind
     * the 2026-05-28 stall (no run = no logs = no alert without this).
     */
    heartbeatUrl: process.env.HEARTBEAT_URL ?? "",
    /**
     * Hard-failure ratio (0–1) at or above which a *completed* run is treated as
     * unhealthy and pings `<url>/fail` instead of the success URL. Catches the
     * "ran but a channel rejects every URL" failure mode (e.g. the Apr 5–20
     * IndexNow 403s) that the dead-man's-switch alone can't see.
     *
     * Default 0.5: since every listing enqueues exactly one IndexNow + one Google
     * event, a single channel wiping out is ~50% of attempts — so 0.5 fires on a
     * full single-channel outage but not on isolated transient failures. Only
     * `hardFailures` count toward the ratio, so Google quota 429s never trip it.
     */
    failureAlertThreshold: Number(
      process.env.INDEXING_FAILURE_ALERT_THRESHOLD ?? 0.5,
    ),
    /**
     * Optional Axiom ingest for one structured `run.complete` event per run.
     * Gives the admin dashboard a *real* liveness signal (the event advances on
     * every completed run, idle runs included) instead of inferring it from
     * `indexing_events.last_attempt_at`, which freezes when the queue is drained
     * — the false "stalled" alarm. Also lets an Axiom monitor alert on
     * `hardFailures > 0` (the Apr 5–20 silent-failure mode). No-op when
     * `AXIOM_TOKEN` is unset; shares one dataset across services, tagged
     * `service: "indexing"` (mirrors the shared Sentry project).
     */
    axiom: {
      token: process.env.AXIOM_TOKEN ?? "",
      dataset: process.env.AXIOM_DATASET ?? "tradeaero",
      orgId: process.env.AXIOM_ORG_ID ?? "",
    },
  },
} as const;

export function validateConfig(): void {
  if (!config.supabase.url) {
    throw new Error("SUPABASE_URL is required");
  }
  if (!config.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  }
  if (!config.indexnow.apiKey) {
    throw new Error("INDEXNOW_API_KEY is required");
  }
  if (config.google.serviceAccountJson) {
    try {
      const sa = JSON.parse(config.google.serviceAccountJson) as Record<string, unknown>;
      if (!sa.client_email || !sa.private_key) {
        throw new Error(
          "GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key"
        );
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
      }
      throw e;
    }
  } else {
    console.log(
      "[CONFIG] GOOGLE_SERVICE_ACCOUNT_JSON not set — will use sitemap ping fallback"
    );
  }
  console.log(`[CONFIG] Site base URL: ${config.site.baseUrl}`);
  if (config.indexing.dryRun) {
    console.log("[CONFIG] DRY RUN mode — external submissions will be skipped");
  }
}
