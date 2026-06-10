// Sentry init for the indexing batch job. Imported FIRST in src/index.ts —
// before any other module — so the SDK is initialised before the app code
// runs. Inert when SENTRY_DSN is unset (the service stays fully functional
// without it).
//
// This is a short-lived GitHub Actions CLI run, not a long-lived server, so we
// only want exception capture (errors + breadcrumbs) — tracing is disabled.
// Always call `Sentry.flush()` before the process exits or buffered events are
// lost (see src/index.ts).

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tracesSampleRate: 0,
  release: process.env.GITHUB_SHA,
  environment:
    process.env.SENTRY_ENVIRONMENT ??
    process.env.GITHUB_REF_NAME ??
    process.env.NODE_ENV ??
    "production",
  // All four TradeAero services share the single `tradeaero` Sentry project;
  // tag the service so indexing events separate from crawler/refactor/cachewarmer
  // (env alone can't — crawler and indexing both report environment from the
  // git ref).
  initialScope: { tags: { service: "indexing" } },
});
