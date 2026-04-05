import { describe, it, expect } from "vitest";
import {
  buildAllLocaleUrls,
  buildEnglishUrl,
  ALL_LANGS,
} from "../utils/url-builder.js";
import type { SupportedLang } from "../types.js";

/** Generate a set of test slugs with a locale suffix for easy assertion */
function makeTestSlugs(suffix = "test-listing-123"): Record<SupportedLang, string> {
  return Object.fromEntries(
    ALL_LANGS.map((l) => [l, `${suffix}-${l}`]),
  ) as Record<SupportedLang, string>;
}

describe("buildAllLocaleUrls", () => {
  it("returns exactly 14 URLs per listing", () => {
    const urls = buildAllLocaleUrls("aircraft", makeTestSlugs());
    expect(urls).toHaveLength(14);
  });

  it("all URLs start with https://trade.aero", () => {
    const urls = buildAllLocaleUrls("aircraft", makeTestSlugs());
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/trade\.aero/);
    }
  });

  describe("aircraft URLs", () => {
    const slugs = makeTestSlugs();
    const urls = buildAllLocaleUrls("aircraft", slugs);

    it("English has no locale prefix", () => {
      expect(urls[0]).toBe("https://trade.aero/aircraft/test-listing-123-en");
    });
    it("German uses /de/flugzeuge/", () => {
      expect(urls[1]).toBe("https://trade.aero/de/flugzeuge/test-listing-123-de");
    });
    it("French uses /fr/aeronefs/", () => {
      expect(urls[2]).toBe("https://trade.aero/fr/aeronefs/test-listing-123-fr");
    });
    it("Spanish uses /es/aeronaves/", () => {
      expect(urls[3]).toBe("https://trade.aero/es/aeronaves/test-listing-123-es");
    });
    it("Norwegian uses /no/fly/", () => {
      expect(urls[13]).toBe("https://trade.aero/no/fly/test-listing-123-no");
    });
  });

  describe("parts URLs", () => {
    const slugs = makeTestSlugs();
    const urls = buildAllLocaleUrls("part", slugs);

    it("English uses /parts/listing/", () => {
      expect(urls[0]).toBe("https://trade.aero/parts/listing/test-listing-123-en");
    });
    it("German uses /de/teile/inserat/", () => {
      expect(urls[1]).toBe("https://trade.aero/de/teile/inserat/test-listing-123-de");
    });
    it("Dutch uses /nl/onderdelen/advertentie/", () => {
      const nlIndex = ALL_LANGS.indexOf("nl");
      expect(urls[nlIndex]).toBe(
        "https://trade.aero/nl/onderdelen/advertentie/test-listing-123-nl",
      );
    });
  });

  describe("wanted URLs", () => {
    const slugs = makeTestSlugs();
    const urls = buildAllLocaleUrls("wanted", slugs);

    it("English uses /parts/wanted/", () => {
      expect(urls[0]).toBe("https://trade.aero/parts/wanted/test-listing-123-en");
    });
    it("German uses /de/teile/gesuche/", () => {
      expect(urls[1]).toBe("https://trade.aero/de/teile/gesuche/test-listing-123-de");
    });
    it("Norwegian uses /no/deler/onskes/", () => {
      expect(urls[13]).toBe("https://trade.aero/no/deler/onskes/test-listing-123-no");
    });
  });

  describe("rental URLs", () => {
    const slugs = makeTestSlugs();
    const urls = buildAllLocaleUrls("rental", slugs);

    it("English uses /rentals/", () => {
      expect(urls[0]).toBe("https://trade.aero/rentals/test-listing-123-en");
    });
    it("German uses /de/vermietung/", () => {
      expect(urls[1]).toBe("https://trade.aero/de/vermietung/test-listing-123-de");
    });
    it("Russian uses /ru/arenda/", () => {
      const ruIndex = ALL_LANGS.indexOf("ru");
      expect(urls[ruIndex]).toBe("https://trade.aero/ru/arenda/test-listing-123-ru");
    });
  });
});

describe("buildEnglishUrl", () => {
  it("builds correct English aircraft URL", () => {
    expect(buildEnglishUrl("aircraft", "cessna-172-for-sale")).toBe(
      "https://trade.aero/aircraft/cessna-172-for-sale",
    );
  });
  it("builds correct English parts URL", () => {
    expect(buildEnglishUrl("part", "avionics-garmin-gns430")).toBe(
      "https://trade.aero/parts/listing/avionics-garmin-gns430",
    );
  });
  it("builds correct English rental URL", () => {
    expect(buildEnglishUrl("rental", "cessna-172-rental-eddf")).toBe(
      "https://trade.aero/rentals/cessna-172-rental-eddf",
    );
  });
  it("builds correct English wanted URL", () => {
    expect(buildEnglishUrl("wanted", "looking-for-piper-pa28")).toBe(
      "https://trade.aero/parts/wanted/looking-for-piper-pa28",
    );
  });
});
