import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import { describe, expect, it, vi } from "vitest";

import { OAuthClientRegistry } from "../domain/oauth-clients.js";
import {
  HmacPlatformInternalAdminAuthenticator,
  PLATFORM_ADMIN_OVERVIEW_PATH,
  registerInternalAdminRoutes,
} from "./internal-admin.js";

const clientId = "apollo-tf-api";
const clientSecret = "p".repeat(32);
const fixedNow = Date.parse("2026-08-10T12:00:00.000Z");
const emptyOverview = {
  total: 0,
  activeNow: 0,
  pending: 0,
  suspended: 0,
  accounts: [],
};

function clients(): OAuthClientRegistry {
  return OAuthClientRegistry.parse(
    [
      {
        clientId,
        audience: "apollo-tf",
        redirectUris: ["https://tf.apollo.test/api/auth/callback"],
        clientSecretDigest: createHash("sha256")
          .update(clientSecret, "utf8")
          .digest("hex"),
      },
    ],
    "test",
  );
}

function nonce(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return bytes.toString("base64url");
}

function signedHeaders(
  path: string,
  rawBody: Buffer,
  options: {
    readonly timestamp?: string;
    readonly nonce?: string;
    readonly basicClientId?: string;
    readonly basicClientSecret?: string;
    readonly signingSecret?: string;
  } = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? String(Math.floor(fixedNow / 1_000));
  const requestNonce = options.nonce ?? nonce(1);
  const basicClientId = options.basicClientId ?? clientId;
  const basicClientSecret = options.basicClientSecret ?? clientSecret;
  return {
    authorization: `Basic ${Buffer.from(
      `${basicClientId}:${basicClientSecret}`,
      "utf8",
    ).toString("base64")}`,
    "content-type": "application/json",
    "x-apollo-internal-timestamp": timestamp,
    "x-apollo-internal-nonce": requestNonce,
    "x-apollo-internal-signature": createSignedBodySignature({
      method: "POST",
      path,
      timestamp,
      nonce: requestNonce,
      rawBody,
      secret: options.signingSecret ?? basicClientSecret,
    }),
  };
}

function app() {
  const instance = express();
  const router = express.Router();
  const load = vi.fn(async () => emptyOverview);
  registerInternalAdminRoutes(router, {
    overview: { load },
    auth: new HmacPlatformInternalAdminAuthenticator(
      clients(),
      clientId,
      () => fixedNow,
    ),
  });
  instance.use(router);
  return { instance, load };
}

async function request(
  instance: ReturnType<typeof app>["instance"],
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  const server = instance.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path,
          headers: { ...headers, "content-length": String(body.byteLength) },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("error", reject);
          incoming.once("end", () => {
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }
}

describe("platform internal admin overview route", () => {
  it("accepts a valid canonical signed request", async () => {
    const { instance, load } = app();
    const body = Buffer.from("{}", "utf8");

    const result = await request(
      instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body),
    );

    expect(result).toEqual({
      status: 200,
      body: JSON.stringify(emptyOverview),
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("rejects signatures whose canonical body or path was altered", async () => {
    const body = Buffer.from("{}", "utf8");
    const alteredBody = Buffer.from('{"extra":true}', "utf8");

    const bodyResult = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      alteredBody,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body),
    );
    const pathResult = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(`${PLATFORM_ADMIN_OVERVIEW_PATH}?altered=1`, body),
    );

    expect(bodyResult).toMatchObject({
      status: 401,
      body: '{"error":"unauthorized"}',
    });
    expect(pathResult).toMatchObject({
      status: 401,
      body: '{"error":"unauthorized"}',
    });
  });

  it("rejects stale and future timestamps", async () => {
    const body = Buffer.from("{}", "utf8");
    const stale = String(Math.floor((fixedNow - 60_001) / 1_000));
    const future = String(Math.floor((fixedNow + 61_000) / 1_000));

    const staleResult = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, { timestamp: stale }),
    );
    const futureResult = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, { timestamp: future }),
    );

    expect(staleResult.status).toBe(401);
    expect(futureResult.status).toBe(401);
  });

  it("rejects a replayed nonce", async () => {
    const { instance } = app();
    const body = Buffer.from("{}", "utf8");
    const headers = signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, {
      nonce: nonce(2),
    });

    const first = await request(
      instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      headers,
    );
    const replay = await request(
      instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      headers,
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
  });

  it("rejects wrong Basic client credentials", async () => {
    const body = Buffer.from("{}", "utf8");
    const wrongClient = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, {
        basicClientId: "unexpected-client",
      }),
    );
    const wrongSecret = await request(
      app().instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, {
        basicClientSecret: "w".repeat(32),
      }),
    );

    expect(wrongClient.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
  });

  it("rejects a fresh request when replay capacity is exhausted", async () => {
    const { instance } = app();
    const body = Buffer.from("{}", "utf8");

    for (let index = 1; index <= 256; index += 1) {
      const result = await request(
        instance,
        PLATFORM_ADMIN_OVERVIEW_PATH,
        body,
        signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, {
          nonce: nonce(index),
        }),
      );
      expect(result.status).toBe(200);
    }

    const overflow = await request(
      instance,
      PLATFORM_ADMIN_OVERVIEW_PATH,
      body,
      signedHeaders(PLATFORM_ADMIN_OVERVIEW_PATH, body, { nonce: nonce(257) }),
    );
    expect(overflow.status).toBe(401);
  });
});
