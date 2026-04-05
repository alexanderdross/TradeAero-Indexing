import { config } from "../config.js";
import type { EntityType, SupportedLang } from "../types.js";

export const ALL_LANGS: SupportedLang[] = [
  "en", "de", "fr", "es", "it", "pl",
  "cs", "sv", "nl", "pt", "ru", "tr", "el", "no",
];

/**
 * Locale-specific path segments per entity type.
 * Source of truth: tradeaero-refactor/src/i18n/routing.ts
 *
 * Note: English uses `localePrefix: "as-needed"` so there is no /en/ prefix.
 * All other locales use /{locale}/{translated-path}/{localized-slug}.
 */
const PATHS: Record<EntityType, Record<SupportedLang, string>> = {
  aircraft: {
    en: "aircraft",
    de: "flugzeuge",
    fr: "aeronefs",
    es: "aeronaves",
    it: "aeromobili",
    pl: "samoloty",
    cs: "letadla",
    sv: "flygplan",
    nl: "vliegtuigen",
    pt: "aeronaves",
    ru: "samolety",
    tr: "ucaklar",
    el: "aeroskafi",
    no: "fly",
  },
  part: {
    en: "parts/listing",
    de: "teile/inserat",
    fr: "pieces/annonce",
    es: "piezas/anuncio",
    it: "ricambi/annuncio",
    pl: "czesci/ogloszenie",
    cs: "dily/inzerat",
    sv: "delar/annons",
    nl: "onderdelen/advertentie",
    pt: "pecas/anuncio",
    ru: "zapchasti/obyavlenie",
    tr: "parcalar/ilan",
    el: "antallaktika/katagoria",
    no: "deler/annonse",
  },
  wanted: {
    en: "parts/wanted",
    de: "teile/gesuche",
    fr: "pieces/recherches",
    es: "piezas/buscados",
    it: "ricambi/cercasi",
    pl: "czesci/poszukiwane",
    cs: "dily/hledane",
    sv: "delar/eftersokes",
    nl: "onderdelen/gezocht",
    pt: "pecas/procurados",
    ru: "zapchasti/razyskivaemye",
    tr: "parcalar/arananlar",
    el: "antallaktika/anazitountai",
    no: "deler/onskes",
  },
  rental: {
    en: "rentals",
    de: "vermietung",
    fr: "locations",
    es: "alquileres",
    it: "noleggio",
    pl: "wynajem",
    cs: "pronajem",
    sv: "uthyrning",
    nl: "verhuur",
    pt: "alugueis",
    ru: "arenda",
    tr: "kiralama",
    el: "enoikiaseis",
    no: "utleie",
  },
};

/**
 * Build all 14 locale-specific URLs for a listing.
 * Returns URLs in ALL_LANGS order (en, de, fr, es, it, pl, cs, sv, nl, pt, ru, tr, el, no).
 */
export function buildAllLocaleUrls(
  entityType: EntityType,
  slugs: Record<SupportedLang, string>,
): string[] {
  const base = config.site.baseUrl;
  return ALL_LANGS.map((locale) => {
    const path = PATHS[entityType][locale];
    const slug = slugs[locale];
    const prefix = locale === "en" ? "" : `/${locale}`;
    return `${base}${prefix}/${path}/${slug}`;
  });
}

/**
 * Build the English canonical URL for a listing.
 * Used as the primary reference URL stored in indexing_events.url.
 */
export function buildEnglishUrl(entityType: EntityType, slugEn: string): string {
  return `${config.site.baseUrl}/${PATHS[entityType].en}/${slugEn}`;
}
