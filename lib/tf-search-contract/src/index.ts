import { z } from "zod";

export const TF_SEARCH_COMMAND_PATH = "/v1/search";
export const TF_SEARCH_SUGGESTIONS_PATH = "/v1/suggestions";

export const tfSearchSourceSchema: z.ZodEnum<["yt", "sc", "bc", "dz"]> =
  z.enum(["yt", "sc", "bc", "dz"]);

export const tfSearchResultSourceSchema: z.ZodEnum<[
  "youtube",
  "soundcloud",
  "bandcamp",
  "deezer",
]> = z.enum(["youtube", "soundcloud", "bandcamp", "deezer"]);

const canonicalUuidSchema = z
  .string()
  .uuid()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const httpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Expected an HTTPS URL",
  });

const tfSearchTypeSchema = z.enum(["original", "remix", "live", "cover"]);
const providerStatusValueSchema = z.enum(["ok", "failed", "skipped"]);
const tfSearchSourcesSchema = z
  .array(tfSearchSourceSchema)
  .min(1)
  .max(4)
  .refine((sources) => new Set(sources).size === sources.length, {
    message: "Sources must be unique",
  });

const tfSearchResultObjectSchema = z
  .object({
    id: z.string().trim().min(3).max(4096),
    title: z.string().trim().min(1).max(500),
    artist: z.string().trim().min(1).max(300),
    type: tfSearchTypeSchema,
    duration: z.number().finite().int().min(0).max(86_400),
    source: tfSearchResultSourceSchema,
    thumbnailUrl: httpsUrlSchema.nullable(),
    quality: z
      .array(z.string().trim().min(1).max(32))
      .min(1)
      .max(32)
      .refine((qualities) => new Set(qualities).size === qualities.length, {
        message: "Quality values must be unique",
      }),
    viewCount: z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    score: z.number().finite().min(0).max(1_000),
    sourceUrl: httpsUrlSchema,
  })
  .strict();

const tfSearchCommandObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: canonicalUuidSchema,
    artist: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    mode: z.enum(["auto", "manual"]),
    sources: tfSearchSourcesSchema,
    maxResults: z.number().finite().int().min(1).max(40),
  })
  .strict();

const tfSearchResponseObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: canonicalUuidSchema,
    query: z.string().trim().min(1).max(501),
    results: z.array(tfSearchResultObjectSchema).max(40),
    cached: z.boolean(),
    sources: tfSearchSourcesSchema,
    fallbackAvailable: z.boolean(),
    providerStatus: z
      .object({
        yt: providerStatusValueSchema,
        sc: providerStatusValueSchema,
        bc: providerStatusValueSchema,
        dz: providerStatusValueSchema,
      })
      .strict(),
  })
  .strict();

const tfSearchSuggestionsCommandObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: canonicalUuidSchema,
    query: z.string().trim().min(2).max(200),
    limit: z.number().finite().int().min(1).max(5),
  })
  .strict();

const tfSearchSuggestionObjectSchema = z
  .object({
    artist: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
  })
  .strict();

const tfSearchSuggestionsResponseObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: canonicalUuidSchema,
    suggestions: z.array(tfSearchSuggestionObjectSchema).max(5),
  })
  .strict();

export type TfSearchSource = z.infer<typeof tfSearchSourceSchema>;
export type TfSearchResultSource = z.infer<typeof tfSearchResultSourceSchema>;
export type TfSearchResult = z.infer<typeof tfSearchResultObjectSchema>;
export type TfSearchCommand = z.infer<typeof tfSearchCommandObjectSchema>;
export type TfSearchResponse = z.infer<typeof tfSearchResponseObjectSchema>;
export type TfSearchSuggestionsCommand = z.infer<
  typeof tfSearchSuggestionsCommandObjectSchema
>;
export type TfSearchSuggestion = z.infer<typeof tfSearchSuggestionObjectSchema>;
export type TfSearchSuggestionsResponse = z.infer<
  typeof tfSearchSuggestionsResponseObjectSchema
>;

export const tfSearchCommandSchema: z.ZodType<TfSearchCommand> =
  tfSearchCommandObjectSchema;
export const tfSearchResponseSchema: z.ZodType<TfSearchResponse> =
  tfSearchResponseObjectSchema;
export const tfSearchSuggestionsCommandSchema: z.ZodType<TfSearchSuggestionsCommand> =
  tfSearchSuggestionsCommandObjectSchema;
export const tfSearchSuggestionsResponseSchema: z.ZodType<TfSearchSuggestionsResponse> =
  tfSearchSuggestionsResponseObjectSchema;
