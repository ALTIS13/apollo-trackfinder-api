import { Buffer } from "node:buffer";

import { createSignedBodySignature } from "@workspace/module-runtime-contract";
import { describe, expect, it } from "vitest";

import {
  HmacInternalRequestAuthenticator,
  type InternalAuthenticationInput,
} from "./internal-auth.js";

const secret = "c".repeat(32);
const rawBody = Buffer.from(
  '{"schemaVersion":1,"requestId":"10000000-0000-4000-8000-000000000001"}',
  "utf8",
);
const nonce = "A".repeat(43);
const accountId = "20000000-0000-4000-8000-000000000002";
const otherAccountId = "30000000-0000-4000-8000-000000000003";

function signedInput(
  overrides: Partial<InternalAuthenticationInput> = {},
): InternalAuthenticationInput {
  const input = {
    method: "POST",
    path: "/v1/commands",
    timestamp: "1000",
    nonce,
    rawBody,
    ...overrides,
  };
  return {
    ...input,
    signature:
      overrides.signature ??
      createSignedBodySignature({
        method: input.method,
        path: input.path,
        timestamp: input.timestamp ?? "",
        nonce: input.nonce ?? "",
        rawBody: input.rawBody,
        secret,
      }),
  };
}

function authenticator(now = 1_000_000) {
  return new HmacInternalRequestAuthenticator({
    secret,
    now: () => now,
    monotonicNow: () => now,
  });
}

function nonceFor(index: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(index, 28);
  return bytes.toString("base64url");
}

function accountFor(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
}

function verified(
  auth: HmacInternalRequestAuthenticator,
  input: InternalAuthenticationInput,
) {
  const proof = auth.verify(input);
  expect(proof).toBeDefined();
  return proof!;
}

describe("TF integrations internal authentication", () => {
  it("accepts a valid signed raw JSON body once within 60 seconds", () => {
    const auth = authenticator(1_060_000);
    const proof = verified(auth, signedInput());

    expect(auth.claim(accountId, proof)).toBe("accepted");
    expect(auth.claim(accountId, proof)).toBe("replayed");
  });

  it("authenticates exact raw bytes and time before any replay claim", () => {
    expect(authenticator(1_060_001).verify(signedInput())).toBeUndefined();
    expect(
      authenticator(939_999).verify(signedInput({ timestamp: "1000" })),
    ).toBeUndefined();
    expect(
      authenticator().verify(signedInput({ nonce: "A".repeat(42) })),
    ).toBeUndefined();
    expect(
      authenticator().verify(
        signedInput({ signature: `v1=${"0".repeat(63)}` }),
      ),
    ).toBeUndefined();

    const original = signedInput();
    expect(
      authenticator().verify({
        ...original,
        path: "/v1/commands/",
      }),
    ).toBeUndefined();
    expect(
      authenticator().verify({
        ...original,
        rawBody: Buffer.from(`${rawBody.toString("utf8")} `, "utf8"),
      }),
    ).toBeUndefined();
  });

  it("admits the configured account capacity and classifies overflow as backpressure", async () => {
    const auth = authenticator();
    let firstProof: ReturnType<typeof verified> | undefined;

    for (let index = 0; index < 256; index += 1) {
      const proof = verified(auth, signedInput({ nonce: nonceFor(index) }));
      firstProof ??= proof;
      expect(auth.claim(accountId, proof)).toBe("accepted");
    }
    expect(
      auth.claim(
        accountId,
        verified(auth, signedInput({ nonce: nonceFor(256) })),
      ),
    ).toBe("capacity_exhausted");
    expect(auth.claim(accountId, firstProof!)).toBe("replayed");
    expect(
      auth.claim(
        otherAccountId,
        verified(auth, signedInput({ nonce: nonceFor(257) })),
      ),
    ).toBe("accepted");

    const concurrentProof = verified(
      auth,
      signedInput({ nonce: nonceFor(258) }),
    );
    const concurrent = await Promise.all(
      Array.from({ length: 16 }, async () =>
        auth.claim(otherAccountId, concurrentProof),
      ),
    );
    expect(concurrent.filter((result) => result === "accepted")).toHaveLength(
      1,
    );
    expect(concurrent.filter((result) => result === "replayed")).toHaveLength(
      15,
    );
  });

  it("bounds account partitions without evicting or blocking an existing partition", () => {
    const auth = authenticator();
    let firstProof: ReturnType<typeof verified> | undefined;

    for (let index = 0; index < 256; index += 1) {
      const proof = verified(
        auth,
        signedInput({ nonce: nonceFor(1_000 + index) }),
      );
      firstProof ??= proof;
      expect(auth.claim(accountFor(index), proof)).toBe("accepted");
    }
    expect(
      auth.claim(
        "ffffffff-0000-4000-8000-000000000001",
        verified(auth, signedInput({ nonce: nonceFor(1_300) })),
      ),
    ).toBe("capacity_exhausted");
    expect(
      auth.claim(
        accountFor(0),
        verified(auth, signedInput({ nonce: nonceFor(1_301) })),
      ),
    ).toBe("accepted");
    expect(auth.claim(accountFor(0), firstProof!)).toBe("replayed");
  });

  it("retains each nonce exactly through its signed 60-second validity window", () => {
    let wallNow = 1_000_000;
    let monotonicNow = 5_000;
    const auth = new HmacInternalRequestAuthenticator({
      secret,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });
    const futureProof = verified(
      auth,
      signedInput({ timestamp: "1060", nonce: nonceFor(400) }),
    );
    expect(auth.claim(accountId, futureProof)).toBe("accepted");

    for (let index = 1; index < 256; index += 1) {
      expect(
        auth.claim(
          accountId,
          verified(
            auth,
            signedInput({
              timestamp: "1060",
              nonce: nonceFor(400 + index),
            }),
          ),
        ),
      ).toBe("accepted");
    }

    wallNow = 1_120_000;
    monotonicNow = 125_000;
    const stillReplayValid = verified(
      auth,
      signedInput({ timestamp: "1060", nonce: nonceFor(400) }),
    );
    expect(auth.claim(accountId, stillReplayValid)).toBe("replayed");

    wallNow = 1_120_001;
    monotonicNow = 125_001;
    expect(
      auth.verify(signedInput({ timestamp: "1060", nonce: nonceFor(400) })),
    ).toBeUndefined();
    expect(
      auth.claim(
        accountId,
        verified(
          auth,
          signedInput({ timestamp: "1120", nonce: nonceFor(700) }),
        ),
      ),
    ).toBe("accepted");
  });
});
