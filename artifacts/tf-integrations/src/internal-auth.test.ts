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

    expect(auth.claim(accountId, proof)).toBe(true);
    expect(auth.claim(accountId, proof)).toBe(false);
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

  it("partitions bounded replay capacity by canonical account without evicting live nonces", async () => {
    const auth = authenticator();

    for (let index = 0; index < 32; index += 1) {
      expect(
        auth.claim(
          accountId,
          verified(auth, signedInput({ nonce: nonceFor(index) })),
        ),
      ).toBe(true);
    }
    expect(
      auth.claim(
        accountId,
        verified(auth, signedInput({ nonce: nonceFor(32) })),
      ),
    ).toBe(false);
    expect(
      auth.claim(
        otherAccountId,
        verified(auth, signedInput({ nonce: nonceFor(33) })),
      ),
    ).toBe(true);

    const concurrentProof = verified(
      auth,
      signedInput({ nonce: nonceFor(34) }),
    );
    const concurrent = await Promise.all(
      Array.from({ length: 16 }, async () =>
        auth.claim(otherAccountId, concurrentProof),
      ),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(1);

    const full = authenticator();
    let firstProof: ReturnType<typeof verified> | undefined;
    for (let account = 0; account < 8; account += 1) {
      const partition =
        `${String(account).padStart(8, "0")}-0000-4000-8000-000000000001`;
      for (let entry = 0; entry < 32; entry += 1) {
        const proof = verified(
          full,
          signedInput({ nonce: nonceFor(account * 32 + entry) }),
        );
        firstProof ??= proof;
        expect(full.claim(partition, proof)).toBe(true);
      }
    }
    const ninthAccount = "90000000-0000-4000-8000-000000000009";
    expect(
      full.claim(
        ninthAccount,
        verified(full, signedInput({ nonce: nonceFor(300) })),
      ),
    ).toBe(false);
    expect(
      full.claim(
        "00000000-0000-4000-8000-000000000001",
        firstProof!,
      ),
    ).toBe(false);
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
    expect(auth.claim(accountId, futureProof)).toBe(true);

    wallNow += 60_001;
    monotonicNow += 60_001;
    const stillReplayValid = verified(
      auth,
      signedInput({ timestamp: "1060", nonce: nonceFor(400) }),
    );
    expect(auth.claim(accountId, stillReplayValid)).toBe(false);

    wallNow = 1_120_001;
    monotonicNow = 125_002;
    expect(
      auth.verify(
        signedInput({ timestamp: "1060", nonce: nonceFor(400) }),
      ),
    ).toBeUndefined();

    for (let index = 0; index < 32; index += 1) {
      expect(
        auth.claim(
          accountId,
          verified(
            auth,
            signedInput({
              timestamp: "1120",
              nonce: nonceFor(500 + index),
            }),
          ),
        ),
      ).toBe(true);
    }
    expect(
      auth.claim(
        accountId,
        verified(
          auth,
          signedInput({ timestamp: "1120", nonce: nonceFor(600) }),
        ),
      ),
    ).toBe(
      false,
    );
  });
});
