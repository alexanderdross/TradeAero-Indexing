import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config.ts reads process.env at import time, so each scenario sets the
// environment, drops the module cache, and re-imports a fresh copy.
async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import("../config.js");
}

const REQUIRED = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  INDEXNOW_API_KEY: "indexnow-key",
  GOOGLE_SERVICE_ACCOUNT_JSON: "",
};

describe("validateConfig", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes when all required vars are present", async () => {
    const { validateConfig } = await loadConfig(REQUIRED);
    expect(() => validateConfig()).not.toThrow();
  });

  it("throws when SUPABASE_URL is missing", async () => {
    const { validateConfig } = await loadConfig({ ...REQUIRED, SUPABASE_URL: "" });
    expect(() => validateConfig()).toThrow("SUPABASE_URL is required");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    const { validateConfig } = await loadConfig({
      ...REQUIRED,
      SUPABASE_SERVICE_ROLE_KEY: "",
    });
    expect(() => validateConfig()).toThrow("SUPABASE_SERVICE_ROLE_KEY is required");
  });

  it("throws when INDEXNOW_API_KEY is missing", async () => {
    const { validateConfig } = await loadConfig({ ...REQUIRED, INDEXNOW_API_KEY: "" });
    expect(() => validateConfig()).toThrow("INDEXNOW_API_KEY is required");
  });

  it("accepts a well-formed GOOGLE_SERVICE_ACCOUNT_JSON", async () => {
    const { validateConfig } = await loadConfig({
      ...REQUIRED,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
      }),
    });
    expect(() => validateConfig()).not.toThrow();
  });

  it("throws when GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON", async () => {
    const { validateConfig } = await loadConfig({
      ...REQUIRED,
      GOOGLE_SERVICE_ACCOUNT_JSON: "{not json",
    });
    expect(() => validateConfig()).toThrow("not valid JSON");
  });

  it("throws when GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email / private_key", async () => {
    const { validateConfig } = await loadConfig({
      ...REQUIRED,
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "only@example.com" }),
    });
    expect(() => validateConfig()).toThrow("client_email and private_key");
  });
});

describe("config defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies documented defaults when optional vars are unset", async () => {
    const { config } = await loadConfig(REQUIRED);
    expect(config.indexnow.batchSize).toBe(100);
    expect(config.indexing.lookbackMinutes).toBe(1440);
    expect(config.indexing.dryRun).toBe(false);
    expect(config.site.baseUrl).toBe("https://trade.aero");
    expect(config.google.allLocales).toBe(false);
  });

  it("strips a trailing slash from SITE_BASE_URL", async () => {
    const { config } = await loadConfig({
      ...REQUIRED,
      SITE_BASE_URL: "https://example.com/",
    });
    expect(config.site.baseUrl).toBe("https://example.com");
  });

  it("reads overrides from the environment", async () => {
    const { config } = await loadConfig({
      ...REQUIRED,
      INDEXNOW_BATCH_SIZE: "250",
      INDEXING_LOOKBACK_MINUTES: "720",
      INDEXING_DRY_RUN: "true",
      GOOGLE_INDEXING_ALL_LOCALES: "true",
    });
    expect(config.indexnow.batchSize).toBe(250);
    expect(config.indexing.lookbackMinutes).toBe(720);
    expect(config.indexing.dryRun).toBe(true);
    expect(config.google.allLocales).toBe(true);
  });
});
