/**
 * Atlas Search index for finding Mandals by name / city (join flow).
 * Created by `npm run db:search-index` (or in the Atlas UI → Search → JSON editor).
 * Only available on Atlas (and the mongodb-atlas-local image); the service falls back to a
 * regex search elsewhere, e.g. in tests on mongodb-memory-server.
 */
export const ORG_SEARCH_INDEX = "org_search";

export const ORG_SEARCH_DEFINITION = {
  mappings: {
    dynamic: false,
    fields: {
      name: [
        { type: "string" },
        { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true },
      ],
      nameLatin: [
        { type: "string" },
        { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15 },
      ],
      city: [
        { type: "string" },
        { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true },
      ],
      status: { type: "token" },
      settings: {
        type: "document",
        fields: {
          membership: { type: "document", fields: { discoverable: { type: "boolean" } } },
        },
      },
    },
  },
};
