/**
 * Field limits for the v2 persona model.
 *
 * These mirror the com.cultureblocs.creative.* lexicons (and the shared
 * com.cultureblocs.defs types) exactly, so anything that is valid locally can
 * always be published. If a lexicon changes, change it here and nowhere else.
 *
 * Source: cultureblocs-string/lexicons/com/cultureblocs/{defs.json,creative/*.json}
 */

export const LEXICON_LIMITS = {
  profile: {
    name: 300, // graphemes
    bio: 2000,
    disciplines: 8, // items
    discipline: 64, // graphemes per item
    links: 8,
    externalIds: 20,
  },
  work: {
    title: 300,
    completionDate: 100,
    description: 2000,
    credits: 20,
    links: 8,
    externalIds: 20,
    tags: 8,
    tag: 64,
  },
  connection: {
    relationship: 64,
    role: 100,
    note: 500,
  },
  defs: {
    placeName: 300,
    linkTitle: 300,
    externalIdScheme: 64,
    externalIdId: 200,
    creditName: 300,
    creditRole: 100,
    didRefName: 300,
  },
} as const;

/**
 * Advisory relationship vocabulary: the lexicon's knownValues plus "curated".
 * Any string up to the limit is accepted; these only seed the UI.
 */
export const KNOWN_RELATIONSHIPS = [
  "created",
  "collaborated_on",
  "performed",
  "exhibited",
  "curated",
  "released",
  "represented_by",
  "attests_to",
  "references",
  "member_of",
] as const;

/** Advisory external-identifier schemes, from com.cultureblocs.defs#externalId. */
export const KNOWN_ID_SCHEMES = [
  "isni",
  "ipi",
  "ipn",
  "orcid",
  "wikidata",
  "musicbrainz",
  "auracle",
  "isrc",
  "iswc",
  "isan",
  "doi",
  "viaf",
  "discogs",
  "rsl",
  "isbn",
  "olid",
  "tmdb",
  "linkedArt",
  "accession",
] as const;
