import "dotenv/config";

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
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
    /** Lookback window in minutes for detecting newly published listings */
    lookbackMinutes: Number(process.env.INDEXING_LOOKBACK_MINUTES ?? 60),
    /** When true, skip external API calls — useful for validating URL generation */
    dryRun: process.env.INDEXING_DRY_RUN === "true",
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
    // Quick sanity-check that the value is parseable JSON
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
  if (config.indexing.dryRun) {
    console.log("[CONFIG] DRY RUN mode — external submissions will be skipped");
  }
}
