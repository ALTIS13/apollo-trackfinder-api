import { z } from "zod";

export const TF_INTEGRATIONS_COMMAND_PATH = "/v1/commands";

const MAX_URL_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_COLLECTION_ITEMS = 50;
const MAX_OFFSET = 1_000_000;
const MAX_PLAYLIST_PART = 2_147_483_647;

const canonicalUuidSchema = z
  .string()
  .uuid()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const boundedTextSchema = (max: number) => z.string().trim().min(1).max(max);
const identifierSchema = boundedTextSchema(MAX_IDENTIFIER_LENGTH);
const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};
const nullableHttpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LENGTH)
  .url()
  .refine(isHttpsUrl, {
    message: "Expected an HTTPS URL",
  })
  .nullable();
const paginationInputSchema = z
  .object({
    offset: z.number().finite().int().min(0).max(MAX_OFFSET),
    limit: z.number().finite().int().min(1).max(MAX_COLLECTION_ITEMS),
  })
  .strict();

const spotifyCallbackUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LENGTH)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.pathname === "/api/spotify/callback" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "Expected an exact HTTPS Spotify callback URI");

export const tfIntegrationOperationSchema = z.enum([
  "spotify.oauth.authorize",
  "spotify.oauth.complete",
  "spotify.status",
  "spotify.disconnect",
  "spotify.liked.list",
  "spotify.playlists.list",
  "spotify.playlist-tracks.list",
  "spotify.top-tracks.list",
  "yandex.token.upsert",
  "yandex.status",
  "yandex.disconnect",
  "yandex.liked.list",
  "yandex.playlists.list",
  "yandex.playlist-tracks.list",
]);

const spotifyAuthorizeInputSchema = z
  .object({
    state: boundedTextSchema(8_192),
    callbackUri: spotifyCallbackUriSchema,
  })
  .strict();
const spotifyCompleteInputSchema = z
  .object({
    code: boundedTextSchema(8_192),
    callbackUri: spotifyCallbackUriSchema,
  })
  .strict();
const emptyInputSchema = z.object({}).strict();
const spotifyPlaylistTracksInputSchema = paginationInputSchema
  .extend({ playlistId: identifierSchema })
  .strict();
const spotifyTopTracksInputSchema = z
  .object({ timeRange: z.enum(["short_term", "medium_term", "long_term"]) })
  .strict();
const yandexTokenInputSchema = z
  .object({ token: z.string().min(10).max(8_192) })
  .strict();
const yandexPlaylistTracksInputSchema = paginationInputSchema
  .extend({
    uid: z.number().finite().int().min(1).max(MAX_PLAYLIST_PART),
    kind: z.number().finite().int().min(1).max(MAX_PLAYLIST_PART),
  })
  .strict();

const commandBaseSchema = {
  schemaVersion: z.literal(1),
  requestId: canonicalUuidSchema,
  accountId: canonicalUuidSchema,
};

const tfIntegrationsCommandObjectSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.oauth.authorize"),
      input: spotifyAuthorizeInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.oauth.complete"),
      input: spotifyCompleteInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.status"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.disconnect"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.liked.list"),
      input: paginationInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.playlists.list"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.playlist-tracks.list"),
      input: spotifyPlaylistTracksInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("spotify.top-tracks.list"),
      input: spotifyTopTracksInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.token.upsert"),
      input: yandexTokenInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.status"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.disconnect"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.liked.list"),
      input: paginationInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.playlists.list"),
      input: emptyInputSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseSchema,
      operation: z.literal("yandex.playlist-tracks.list"),
      input: yandexPlaylistTracksInputSchema,
    })
    .strict(),
]);

const normalizedTrackObjectSchema = z
  .object({
    id: identifierSchema,
    title: boundedTextSchema(500),
    artist: boundedTextSchema(300),
    album: boundedTextSchema(500),
    duration: z.number().finite().int().min(0).max(86_400),
    thumbnailUrl: nullableHttpsUrlSchema,
    providerUrl: nullableHttpsUrlSchema.unwrap(),
  })
  .strict();

const spotifyPlaylistObjectSchema = z
  .object({
    id: identifierSchema,
    name: boundedTextSchema(500),
    description: z.string().trim().max(4_096),
    trackCount: z.number().finite().int().min(0).max(MAX_OFFSET),
    thumbnailUrl: nullableHttpsUrlSchema,
    owner: boundedTextSchema(500),
  })
  .strict();

const yandexPlaylistObjectSchema = z
  .object({
    uid: z.number().finite().int().min(1).max(MAX_PLAYLIST_PART),
    kind: z.number().finite().int().min(1).max(MAX_PLAYLIST_PART),
    title: boundedTextSchema(500),
    description: z.string().trim().max(4_096),
    trackCount: z.number().finite().int().min(0).max(MAX_OFFSET),
    thumbnailUrl: nullableHttpsUrlSchema,
    owner: boundedTextSchema(500),
  })
  .strict();

const connectedAccountSchema = (provider: "spotify" | "yandex") =>
  z
    .object({
      provider: z.literal(provider),
      connected: z.literal(true),
      account: z
        .object({
          id: identifierSchema,
          displayName: boundedTextSchema(500),
        })
        .strict(),
    })
    .strict();

const disconnectedAccountSchema = (provider: "spotify" | "yandex") =>
  z
    .object({ provider: z.literal(provider), connected: z.literal(false) })
    .strict();

const spotifyConnectedAccountSchema = connectedAccountSchema("spotify");
const yandexConnectedAccountSchema = connectedAccountSchema("yandex");
const spotifyAccountSummaryObjectSchema = z.union([
  spotifyConnectedAccountSchema,
  disconnectedAccountSchema("spotify"),
]);
const yandexAccountSummaryObjectSchema = z.union([
  yandexConnectedAccountSchema,
  disconnectedAccountSchema("yandex"),
]);

const tracksPageSchema = z
  .object({
    offset: z.number().finite().int().min(0).max(MAX_OFFSET),
    limit: z.number().finite().int().min(1).max(MAX_COLLECTION_ITEMS),
    total: z.number().finite().int().min(0).max(MAX_OFFSET),
    tracks: z.array(normalizedTrackObjectSchema).max(MAX_COLLECTION_ITEMS),
  })
  .strict();
const spotifyPlaylistsResultSchema = z
  .object({
    playlists: z.array(spotifyPlaylistObjectSchema).max(MAX_COLLECTION_ITEMS),
    total: z.number().finite().int().min(0).max(MAX_OFFSET),
  })
  .strict();
const yandexPlaylistsResultSchema = z
  .object({
    playlists: z.array(yandexPlaylistObjectSchema).max(MAX_COLLECTION_ITEMS),
    total: z.number().finite().int().min(0).max(MAX_OFFSET),
  })
  .strict();
const tracksResultSchema = z
  .object({
    tracks: z.array(normalizedTrackObjectSchema).max(MAX_COLLECTION_ITEMS),
  })
  .strict();
const connectedSpotifyResultSchema = z
  .object({ account: spotifyConnectedAccountSchema })
  .strict();
const connectedYandexResultSchema = z
  .object({ account: yandexConnectedAccountSchema })
  .strict();
const spotifyStatusResultSchema = z
  .object({ account: spotifyAccountSummaryObjectSchema })
  .strict();
const yandexStatusResultSchema = z
  .object({ account: yandexAccountSummaryObjectSchema })
  .strict();
const disconnectResultSchema = z.object({ ok: z.literal(true) }).strict();
const spotifyAuthorizationResultSchema = z
  .object({ authorizationUrl: nullableHttpsUrlSchema.unwrap() })
  .strict();

const responseBaseSchema = {
  schemaVersion: z.literal(1),
  requestId: canonicalUuidSchema,
};

const tfIntegrationsSuccessResponseObjectSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.oauth.authorize"),
        result: spotifyAuthorizationResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.oauth.complete"),
        result: connectedSpotifyResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.status"),
        result: spotifyStatusResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.disconnect"),
        result: disconnectResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.liked.list"),
        result: tracksPageSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.playlists.list"),
        result: spotifyPlaylistsResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.playlist-tracks.list"),
        result: tracksPageSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("spotify.top-tracks.list"),
        result: tracksResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.token.upsert"),
        result: connectedYandexResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.status"),
        result: yandexStatusResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.disconnect"),
        result: disconnectResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.liked.list"),
        result: tracksPageSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.playlists.list"),
        result: yandexPlaylistsResultSchema,
      })
      .strict(),
    z
      .object({
        ...responseBaseSchema,
        operation: z.literal("yandex.playlist-tracks.list"),
        result: tracksPageSchema,
      })
      .strict(),
  ],
);

export const tfIntegrationErrorCodeSchema = z.enum([
  "not_connected",
  "provider_rejected",
  "provider_unavailable",
  "storage_unavailable",
  "invalid_provider_response",
]);

const tfIntegrationsErrorResponseObjectSchema = z
  .object({
    ...responseBaseSchema,
    operation: tfIntegrationOperationSchema,
    error: z.object({ code: tfIntegrationErrorCodeSchema }).strict(),
  })
  .strict();

export type TfIntegrationOperation = z.infer<
  typeof tfIntegrationOperationSchema
>;
export type NormalizedTrack = z.infer<typeof normalizedTrackObjectSchema>;
export type SpotifyPlaylist = z.infer<typeof spotifyPlaylistObjectSchema>;
export type YandexPlaylist = z.infer<typeof yandexPlaylistObjectSchema>;
export type TfIntegrationsAccountSummary =
  | z.infer<typeof spotifyAccountSummaryObjectSchema>
  | z.infer<typeof yandexAccountSummaryObjectSchema>;
export type TfIntegrationsCommand = z.infer<
  typeof tfIntegrationsCommandObjectSchema
>;
export type TfIntegrationsSuccessResponse = z.infer<
  typeof tfIntegrationsSuccessResponseObjectSchema
>;
export type TfIntegrationsErrorResponse = z.infer<
  typeof tfIntegrationsErrorResponseObjectSchema
>;

export const tfIntegrationsCommandSchema: z.ZodType<TfIntegrationsCommand> =
  tfIntegrationsCommandObjectSchema;
export const tfIntegrationsSuccessResponseSchema: z.ZodType<TfIntegrationsSuccessResponse> =
  tfIntegrationsSuccessResponseObjectSchema;
export const tfIntegrationsErrorResponseSchema: z.ZodType<TfIntegrationsErrorResponse> =
  tfIntegrationsErrorResponseObjectSchema;
