import { Buffer } from "node:buffer";
import {
  createTfDownloadFileSignature,
  type TfDownloadFileSignatureInput,
} from "@workspace/tf-download-contract";
import { describe, expect, it, vi } from "vitest";

import {
  HmacFileRequestAuthenticator,
  type FileAuthenticationInput,
} from "./internal-auth.js";

const SECRET = Buffer.from("s".repeat(32), "utf8");
const RAW_BODY = Buffer.from('{"schemaVersion":1}', "utf8");
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const NONCE = "0".repeat(64);

function signedInput(
  overrides: Partial<FileAuthenticationInput> = {},
): FileAuthenticationInput {
  const input = {
    method: "POST",
    path: "/v1/files",
    timestamp: "1000",
    nonce: NONCE,
    rawBody: RAW_BODY,
    ...overrides,
  };
  const signatureInput: TfDownloadFileSignatureInput = {
    method: input.method,
    path: input.path,
    timestamp:
      typeof input.timestamp === "string" ? input.timestamp : "",
    nonce: typeof input.nonce === "string" ? input.nonce : "",
    rawBody: input.rawBody,
    secret: SECRET,
  };
  return {
    ...input,
    signature:
      overrides.signature ?? createTfDownloadFileSignature(signatureInput),
  };
}

function authenticator(
  wallNow = 1_000_000,
  monotonicNow = wallNow,
  limits: {
    readonly maxAccountPartitions?: number;
    readonly maxNoncesPerAccount?: number;
  } = {},
): HmacFileRequestAuthenticator {
  return new HmacFileRequestAuthenticator({
    secret: SECRET,
    now: () => wallNow,
    monotonicNow: () => monotonicNow,
    ...limits,
  });
}

function nonceFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function accountFor(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
}

function verified(
  auth: HmacFileRequestAuthenticator,
  input: FileAuthenticationInput,
) {
  const proof = auth.verifySignature(input);
  expect(proof).toBeDefined();
  return proof!;
}

describe("TF download file signing", () => {
  it("uses the exact raw-byte canonical HMAC without normalizing fields", () => {
    expect(
      createTfDownloadFileSignature({
        method: "POST",
        path: "/v1/files",
        timestamp: "1000",
        nonce: NONCE,
        rawBody: RAW_BODY,
        secret: SECRET,
      }),
    ).toBe(
      "0955b3056843da9314146ad9b9dc2c1e05b5275ad67663852fb03f09de8a7b89",
    );

    expect(
      createTfDownloadFileSignature({
        method: "post",
        path: "/v1/files",
        timestamp: "1000",
        nonce: NONCE,
        rawBody: RAW_BODY,
        secret: SECRET,
      }),
    ).not.toBe(
      "0955b3056843da9314146ad9b9dc2c1e05b5275ad67663852fb03f09de8a7b89",
    );
  });
});

describe("TF download internal file authentication", () => {
  it("verifies the signature before consulting timestamp and nonce state", () => {
    const now = vi.fn(() => 1_000_000);
    const monotonicNow = vi.fn(() => 5_000);
    const auth = new HmacFileRequestAuthenticator({
      secret: SECRET,
      now,
      monotonicNow,
    });

    expect(
      auth.verifySignature({
        ...signedInput(),
        timestamp: ["1000", "1001"],
        nonce: ["0".repeat(64), "1".repeat(64)],
        signature: "f".repeat(64),
      }),
    ).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    expect(monotonicNow).not.toHaveBeenCalled();
  });

  it.each([
    ["method case", { method: "post" }],
    ["other method", { method: "GET" }],
    ["other path", { path: "/v1/file" }],
    ["query", { path: "/v1/files?job=1" }],
    ["trailing slash", { path: "/v1/files/" }],
  ] satisfies ReadonlyArray<
    readonly [string, Partial<FileAuthenticationInput>]
  >)("rejects a matching HMAC on an invalid exact %s", (_label, mutation) => {
    expect(
      authenticator().verifySignature(signedInput(mutation)),
    ).toBeUndefined();
  });

  it("rejects any raw-byte mutation after the body was signed", () => {
    const original = signedInput();
    expect(
      authenticator().verifySignature({
        ...original,
        rawBody: Buffer.from('{"schemaVersion":1} ', "utf8"),
      }),
    ).toBeUndefined();
  });

  it("accepts only integer Unix seconds within the inclusive 60-second window", () => {
    for (const timestamp of ["940", "1000", "1060"]) {
      expect(
        authenticator().verifySignature(signedInput({ timestamp })),
      ).toBeDefined();
    }
    for (const timestamp of [
      "939",
      "1061",
      "1000.0",
      "-1000",
      "not-a-time",
      "9".repeat(33),
    ]) {
      expect(
        authenticator().verifySignature(signedInput({ timestamp })),
      ).toBeUndefined();
    }
  });

  it("requires exact single-valued bounded headers and a lowercase 32-byte nonce", () => {
    for (const mutation of [
      { timestamp: ["1000"] },
      { nonce: ["0".repeat(64)] },
      { signature: ["0".repeat(64)] },
      { nonce: "a".repeat(63) },
      { nonce: "a".repeat(65) },
      { nonce: "A".repeat(64) },
      { nonce: `${"a".repeat(63)}g` },
      { signature: "a".repeat(63) },
      { signature: "A".repeat(64) },
    ] satisfies ReadonlyArray<Partial<FileAuthenticationInput>>) {
      expect(
        authenticator().verifySignature(signedInput(mutation)),
      ).toBeUndefined();
    }
  });

  it("rejects replay only within the claimed canonical account partition", () => {
    const auth = authenticator();
    const proof = verified(auth, signedInput());

    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: proof.nonce })).toBe(
      "accepted",
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: proof.nonce })).toBe(
      "replayed",
    );
    expect(auth.claim({ accountId: OTHER_ACCOUNT_ID, nonce: proof.nonce })).toBe(
      "accepted",
    );
    expect(
      auth.claim({
        accountId: "A0000000-0000-4000-8000-000000000001",
        nonce: proof.nonce,
      }),
    ).toBe("invalid");
  });

  it("retains a future-signed nonce through its complete accepted window", () => {
    let wallNow = 1_000_000;
    let monotonicNow = 5_000;
    const auth = new HmacFileRequestAuthenticator({
      secret: SECRET,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
      maxNoncesPerAccount: 1,
    });
    const future = verified(
      auth,
      signedInput({ timestamp: "1060", nonce: nonceFor(1) }),
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: future.nonce })).toBe(
      "accepted",
    );

    wallNow = 1_120_000;
    monotonicNow = 125_000;
    const boundaryReplay = verified(
      auth,
      signedInput({ timestamp: "1060", nonce: nonceFor(1) }),
    );
    expect(
      auth.claim({ accountId: ACCOUNT_ID, nonce: boundaryReplay.nonce }),
    ).toBe("replayed");
    const full = verified(
      auth,
      signedInput({ timestamp: "1120", nonce: nonceFor(2) }),
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: full.nonce })).toBe(
      "capacity_exhausted",
    );

    wallNow += 1;
    monotonicNow += 1;
    const admitted = verified(
      auth,
      signedInput({ timestamp: "1120", nonce: nonceFor(2) }),
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: admitted.nonce })).toBe(
      "accepted",
    );
  });

  it("reports per-account capacity without evicting a live replay", () => {
    const auth = authenticator(1_000_000, 5_000, {
      maxNoncesPerAccount: 2,
    });
    const first = verified(auth, signedInput({ nonce: nonceFor(1) }));
    const second = verified(auth, signedInput({ nonce: nonceFor(2) }));
    const overflow = verified(auth, signedInput({ nonce: nonceFor(3) }));

    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: first.nonce })).toBe(
      "accepted",
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: second.nonce })).toBe(
      "accepted",
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: overflow.nonce })).toBe(
      "capacity_exhausted",
    );
    expect(auth.claim({ accountId: ACCOUNT_ID, nonce: first.nonce })).toBe(
      "replayed",
    );
  });

  it("bounds global account partitions while preserving existing partitions", () => {
    const auth = authenticator(1_000_000, 5_000, {
      maxAccountPartitions: 2,
      maxNoncesPerAccount: 2,
    });
    const first = verified(auth, signedInput({ nonce: nonceFor(10) }));
    expect(
      auth.claim({ accountId: accountFor(1), nonce: first.nonce }),
    ).toBe("accepted");
    expect(
      auth.claim({
        accountId: accountFor(2),
        nonce: verified(auth, signedInput({ nonce: nonceFor(20) })).nonce,
      }),
    ).toBe("accepted");
    expect(
      auth.claim({
        accountId: accountFor(3),
        nonce: verified(auth, signedInput({ nonce: nonceFor(30) })).nonce,
      }),
    ).toBe("capacity_exhausted");
    expect(
      auth.claim({
        accountId: accountFor(1),
        nonce: verified(auth, signedInput({ nonce: nonceFor(11) })).nonce,
      }),
    ).toBe("accepted");
    expect(
      auth.claim({ accountId: accountFor(1), nonce: first.nonce }),
    ).toBe("replayed");
  });

  it("rejects weak secrets before accepting any request", () => {
    expect(
      () =>
        new HmacFileRequestAuthenticator({
          secret: Buffer.alloc(31),
        }),
    ).toThrow("invalid internal authentication secret");
  });
});
