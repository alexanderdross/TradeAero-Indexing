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
  if (config.indexing.dryRun) {
    console.log("[CONFIG] DRY RUN mode — external submissions will be skipped");
  }
}
