import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export interface RegisteredOAuthClient {
  readonly clientId: string;
  readonly audience: "apollo-tf";
  readonly redirectUris: readonly string[];
  readonly clientSecretDigest: string;
}

const clientSchema = z
  .object({
    clientId: z.string().min(1).max(128),
    audience: z.literal("apollo-tf"),
    redirectUris: z.array(z.string().url().max(2048)).min(1).max(8),
    clientSecretDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const registrySchema = z.array(clientSchema).min(1).max(8);

function redirectIsAllowed(redirectUri: string, nodeEnv: string): boolean {
  const url = new URL(redirectUri);
  if (url.protocol === "https:") return true;
  if (nodeEnv !== "development" || url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function freezeClient(
  client: z.infer<typeof clientSchema>,
): RegisteredOAuthClient {
  return Object.freeze({
    ...client,
    redirectUris: Object.freeze([...client.redirectUris]),
  });
}

export class OAuthClientRegistry {
  readonly #clients: ReadonlyMap<string, RegisteredOAuthClient>;

  private constructor(clients: readonly RegisteredOAuthClient[]) {
    this.#clients = new Map(clients.map((client) => [client.clientId, client]));
  }

  static parse(raw: unknown, nodeEnv: string): OAuthClientRegistry {
    const clients = registrySchema.parse(raw);
    const clientIds = new Set<string>();
    const redirectUris = new Set<string>();

    for (const client of clients) {
      if (clientIds.has(client.clientId)) {
        throw new TypeError("Duplicate OAuth client ID");
      }
      clientIds.add(client.clientId);

      const clientRedirects = new Set<string>();
      for (const redirectUri of client.redirectUris) {
        if (clientRedirects.has(redirectUri) || redirectUris.has(redirectUri)) {
          throw new TypeError("Duplicate OAuth redirect URI");
        }
        if (!redirectIsAllowed(redirectUri, nodeEnv)) {
          throw new TypeError("OAuth redirect URI is not allowed");
        }
        clientRedirects.add(redirectUri);
        redirectUris.add(redirectUri);
      }
    }

    return new OAuthClientRegistry(clients.map(freezeClient));
  }

  get(clientId: string): RegisteredOAuthClient | null {
    return this.#clients.get(clientId) ?? null;
  }

  verifySecret(client: RegisteredOAuthClient, rawSecret: string): boolean {
    const actual = createHash("sha256").update(rawSecret, "utf8").digest();
    const expected = Buffer.from(client.clientSecretDigest, "hex");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}
