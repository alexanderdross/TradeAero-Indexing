import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../db/client.js", () => ({
  supabase: { from: vi.fn() },
}));

import { fetchRecentlyPublishedListings } from "../db/listings.js";
import { supabase } from "../db/client.js";

const SLUG_COLS = [
  "slug_en", "slug_de", "slug_fr", "slug_es", "slug_it", "slug_pl", "slug_cs",
  "slug_sv", "slug_nl", "slug_pt", "slug_ru", "slug_tr", "slug_el", "slug_no",
];

function makeRow(id: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id,
    updated_at: "2026-05-22T10:00:00.000Z",
  };
  for (const col of SLUG_COLS) row[col] = `${id}-${col}`;
  return row;
}

type QueryResult = {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
};

interface QueryBuilder {
  select: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  then: (resolve: (value: QueryResult) => unknown) => Promise<unknown>;
}

// A thenable stand-in for the Supabase query builder: every filter method is
// chainable, and awaiting the builder resolves to { data, error }.
function makeQueryBuilder(result: QueryResult): QueryBuilder {
  const builder = {} as QueryBuilder;
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.limit = vi.fn(chain);
  builder.not = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.then = (resolve) => Promise.resolve(result).then(resolve);
  return builder;
}

describe("fetchRecentlyPublishedListings", () => {
  let builders: Record<string, QueryBuilder>;

  function wireBuilders() {
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        builders[table] as unknown as ReturnType<typeof supabase.from>,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    builders = {
      aircraft_listings: makeQueryBuilder({ data: [makeRow("ac-1")], error: null }),
      parts_listings: makeQueryBuilder({
        data: [makeRow("pt-1"), makeRow("pt-2")],
        error: null,
      }),
      search_requests: makeQueryBuilder({ data: [makeRow("wt-1")], error: null }),
    };
    wireBuilders();
  });

  it("maps rows from all three tables into DiscoveredListing entries", async () => {
    const result = await fetchRecentlyPublishedListings(
      new Date("2026-05-22T09:00:00.000Z"),
    );
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.entityType).sort()).toEqual([
      "aircraft",
      "part",
      "part",
      "wanted",
    ]);
    expect(result.map((r) => r.entityId).sort()).toEqual([
      "ac-1",
      "pt-1",
      "pt-2",
      "wt-1",
    ]);
  });

  it("does not query the rentals table (hidden post-MVP)", async () => {
    await fetchRecentlyPublishedListings(new Date());
    const queried = vi.mocked(supabase.from).mock.calls.map((c) => c[0]);
    expect(queried).toEqual(
      expect.arrayContaining([
        "aircraft_listings",
        "parts_listings",
        "search_requests",
      ]),
    );
    expect(queried).not.toContain("rental_listings");
  });

  it("applies the translation gate: every slug column must be non-null", async () => {
    await fetchRecentlyPublishedListings(new Date());
    const notCalls = builders.aircraft_listings.not.mock.calls;
    expect(notCalls).toHaveLength(SLUG_COLS.length);
    expect(notCalls.map((c) => c[0]).sort()).toEqual([...SLUG_COLS].sort());
    for (const call of notCalls) {
      expect(call[1]).toBe("is");
      expect(call[2]).toBeNull();
    }
  });

  it("filters within the lookback window via updated_at", async () => {
    const since = new Date("2026-05-22T08:30:00.000Z");
    await fetchRecentlyPublishedListings(since);
    expect(builders.aircraft_listings.gte).toHaveBeenCalledWith(
      "updated_at",
      since.toISOString(),
    );
  });

  it("applies status + publish_as_wanted filters per table", async () => {
    await fetchRecentlyPublishedListings(new Date());
    expect(builders.aircraft_listings.eq).toHaveBeenCalledWith("status", "active");
    expect(builders.parts_listings.eq).toHaveBeenCalledWith("status", "active");
    expect(builders.search_requests.eq).toHaveBeenCalledWith("status", "active");
    expect(builders.search_requests.eq).toHaveBeenCalledWith(
      "publish_as_wanted",
      true,
    );
  });

  it("maps all 14 locale slugs onto each listing", async () => {
    const result = await fetchRecentlyPublishedListings(new Date());
    const aircraft = result.find((r) => r.entityType === "aircraft");
    expect(Object.keys(aircraft!.slugs).sort()).toEqual([
      "cs", "de", "el", "en", "es", "fr", "it",
      "nl", "no", "pl", "pt", "ru", "sv", "tr",
    ]);
    expect(aircraft!.slugs.en).toBe("ac-1-slug_en");
    expect(aircraft!.slugs.no).toBe("ac-1-slug_no");
  });

  it("returns an empty slice for a table that errors, keeping the others", async () => {
    builders.parts_listings = makeQueryBuilder({
      data: null,
      error: { message: "boom" },
    });
    wireBuilders();
    const result = await fetchRecentlyPublishedListings(new Date());
    // aircraft (1) + parts (0, errored) + wanted (1)
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.entityType === "part")).toBe(false);
  });
});
