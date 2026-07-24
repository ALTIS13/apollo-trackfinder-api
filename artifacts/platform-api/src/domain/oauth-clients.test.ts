import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OAuthClientRegistry } from "./oauth-clients.js";

const firstSecret = "first-secret-\u03c0";
const secondSecret = "second-secret";
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function client(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientId: "apollo-tf-web",
    audience: "apollo-tf",
    redirectUris: ["https://api.tf.apollot.ru/api/auth/callback"],
    clientSecretDigest: digest(firstSecret),
    ...overrides,
  };
}

describe("OAuthClientRegistry", () => {
  it("parses and freezes 1-8 exact registered clients", () => {
    const registry = OAuthClientRegistry.parse(
      [
        client(),
        client({
          clientId: "apollo-tf-desktop",
          redirectUris: ["https://desktop.tf.apollot.ru/callback"],
          clientSecretDigest: digest(secondSecret),
        }),
      ],
      "production",
    );

    const registered = registry.get("apollo-tf-web");
    expect(registered).toEqual(client());
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered?.redirectUris)).toBe(true);
    expect(registry.get("missing")).toBeNull();
  });

  it.each([
    ["an empty registry", []],
    [
      "more than eight clients",
      Array.from({ length: 9 }, (_, index) =>
        client({
          clientId: `client-${index}`,
          redirectUris: [`https://client-${index}.example/callback`],
        }),
      ),
    ],
    ["unknown client keys", [client({ internalSecret: "leak" })]],
    ["an unknown audience", [client({ audience: "apollo-admin" })]],
    [
      "an uppercase digest",
      [client({ clientSecretDigest: digest(firstSecret).toUpperCase() })],
    ],
    ["a short digest", [client({ clientSecretDigest: "a".repeat(63) })]],
    ["an empty redirect list", [client({ redirectUris: [] })]],
    [
      "more than eight redirects",
      [
        client({
          redirectUris: Array.from(
            { length: 9 },
            (_, index) => `https://client.example/callback/${index}`,
          ),
        }),
      ],
    ],
    [
      "duplicate redirects in one client",
      [
        client({
          redirectUris: [
            "https://client.example/callback",
            "https://client.example/callback",
          ],
        }),
      ],
    ],
  ])("rejects %s", (_name, raw) => {
    expect(() => OAuthClientRegistry.parse(raw, "production")).toThrow();
  });

  it("rejects duplicate client IDs and globally duplicated redirect URIs", () => {
    expect(() =>
      OAuthClientRegistry.parse(
        [
          client(),
          client({
            redirectUris: ["https://other.example/callback"],
          }),
        ],
        "production",
      ),
    ).toThrow();
    expect(() =>
      OAuthClientRegistry.parse(
        [
          client(),
          client({
            clientId: "other-client",
            clientSecretDigest: digest(secondSecret),
          }),
        ],
        "production",
      ),
    ).toThrow();
  });

  it("requires HTTPS except for exact development loopback hosts", () => {
    expect(() =>
      OAuthClientRegistry.parse(
        [client({ redirectUris: ["http://localhost/callback"] })],
        "production",
      ),
    ).toThrow();
    expect(() =>
      OAuthClientRegistry.parse(
        [client({ redirectUris: ["http://client.example/callback"] })],
        "development",
      ),
    ).toThrow();
    expect(
      OAuthClientRegistry.parse(
        [
          client({
            redirectUris: [
              "http://localhost/callback",
              "http://localhost:3000/callback",
              "http://127.0.0.1/callback",
              "http://127.0.0.1:18082/api/auth/callback",
            ],
          }),
        ],
        "development",
      ).get("apollo-tf-web")?.redirectUris,
    ).toEqual([
      "http://localhost/callback",
      "http://localhost:3000/callback",
      "http://127.0.0.1/callback",
      "http://127.0.0.1:18082/api/auth/callback",
    ]);
  });

  it("SHA-256 digests exact UTF-8 secret bytes and compares fixed buffers", async () => {
    const registry = OAuthClientRegistry.parse([client()], "production");
    const registered = registry.get("apollo-tf-web")!;

    expect(registry.verifySecret(registered, firstSecret)).toBe(true);
    expect(registry.verifySecret(registered, "first-secret-p")).toBe(false);
    expect(registry.verifySecret(registered, `${firstSecret} `)).toBe(false);

    const source = await readFile(
      new URL("./oauth-clients.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).toMatch(
      /createHash\("sha256"\)[\s\S]*update\(rawSecret, "utf8"\)/,
    );
  });
});
