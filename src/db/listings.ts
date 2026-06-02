import { supabase } from "./client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { DiscoveredListing, EntityType, SupportedLang } from "../types.js";

const SLUG_COLS = [
  "slug_en", "slug_de", "slug_fr", "slug_es", "slug_it",
  "slug_pl", "slug_cs", "slug_sv", "slug_nl", "slug_pt",
  "slug_ru", "slug_tr", "slug_el", "slug_no",
] as const;

const SELECT_COLS = `id, updated_at, ${SLUG_COLS.join(", ")}`;

/** PostgREST caps a single response at ~1000 rows, so we page in 1000s. */
const PAGE_SIZE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSlugs(row: Record<string, any>): Record<SupportedLang, string> {
  return {
    en: row.slug_en as string,
    de: row.slug_de as string,
    fr: row.slug_fr as string,
    es: row.slug_es as string,
    it: row.slug_it as string,
    pl: row.slug_pl as string,
    cs: row.slug_cs as string,
    sv: row.slug_sv as string,
    nl: row.slug_nl as string,
    pt: row.slug_pt as string,
    ru: row.slug_ru as string,
    tr: row.slug_tr as string,
    el: row.slug_el as string,
    no: row.slug_no as string,
  };
}

/**
 * Fetch listings from a single table that:
 * 1. Have status = 'active' (or equivalent for search_requests)
 * 2. Have ALL 14 locale slug columns populated (translation gate)
 * 3. Were updated within the lookback window
 */
async function fetchFromTable(
  table: string,
  entityType: EntityType,
  since: Date,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraFilters?: (query: any) => any,
): Promise<DiscoveredListing[]> {
  // Page through with .range() instead of a single .limit(): PostgREST caps any
  // one response at ~1000 rows server-side, so .limit(5000) silently returns
  // only 1000 and the older backlog (rank >1000 by updated_at) is unreachable.
  // We keep paging until a short page (exhausted) or INDEXING_DISCOVERY_LIMIT.
  // Normal runs use the small default and stop after one page.
  const results: DiscoveredListing[] = [];

  for (let from = 0; from < config.indexing.discoveryLimit; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, config.indexing.discoveryLimit) - 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
      .from(table)
      .select(SELECT_COLS)
      .gte("updated_at", since.toISOString())
      .order("updated_at", { ascending: false })
      .range(from, to);

    // Apply translation gate: all 14 slug columns must be non-null
    for (const col of SLUG_COLS) {
      query = query.not(col, "is", null);
    }

    // Apply table-specific filters
    if (extraFilters) {
      query = extraFilters(query);
    }

    const { data, error } = await query;

    if (error) {
      logger.warn(`fetchFromTable(${table}) error`, {
        error: error.message,
        from,
        to,
      });
      break;
    }

    const rows = data ?? [];
    results.push(
      ...rows.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row: Record<string, any>): DiscoveredListing => ({
          entityType,
          entityId: String(row.id),
          slugs: rowToSlugs(row),
          publishedAt: row.updated_at as string,
        }),
      ),
    );

    // Short page = no more rows to fetch.
    if (rows.length < to - from + 1) break;
  }

  return results;
}

/**
 * Find listings across all 4 entity types that:
 * - Are active/published
 * - Have all 14 locale translations complete (slug_en through slug_no non-null)
 * - Were updated within the lookback window
 *
 * Uses `updated_at` (not `created_at`) to catch draft-to-active transitions.
 */
export async function fetchRecentlyPublishedListings(
  since: Date,
): Promise<DiscoveredListing[]> {
  // Rentals discovery hidden post-MVP — see TradeAero-Refactor's
  // docs/MVP_HIDDEN_SECTIONS.md §2. Rental listings are still written
  // to the DB (admins, direct-URL access), but they shouldn't be
  // submitted to IndexNow / Google while public surfaces don't link
  // to them.
  //
  // Re-enable by uncommenting the four `// rentals …` lines + the
  // `fetchFromTable("rental_listings", ...)` call below, and
  // re-commenting the matching marketplace-only lines that replace
  // them.
  const [
    aircraft,
    parts,
    // rentals,
    wanted,
  ] = await Promise.all([
    fetchFromTable("aircraft_listings", "aircraft", since, (q) =>
      q.eq("status", "active"),
    ),
    fetchFromTable("parts_listings", "part", since, (q) =>
      q.eq("status", "active"),
    ),
    // fetchFromTable("rental_listings", "rental", since, (q) =>
    //   q.eq("status", "active"),
    // ),
    // Wanted ads come from search_requests with publish_as_wanted = true
    fetchFromTable("search_requests", "wanted", since, (q) =>
      q.eq("status", "active").eq("publish_as_wanted", true),
    ),
  ]);

  // const total = aircraft.length + parts.length + rentals.length + wanted.length;
  const total = aircraft.length + parts.length + wanted.length;
  logger.info("Discovered recently published listings", {
    aircraft: aircraft.length,
    parts: parts.length,
    // rentals: rentals.length,
    rentals: 0, // hidden post-MVP
    wanted: wanted.length,
    total,
    since: since.toISOString(),
  });

  // return [...aircraft, ...parts, ...rentals, ...wanted];
  return [...aircraft, ...parts, ...wanted];
}
