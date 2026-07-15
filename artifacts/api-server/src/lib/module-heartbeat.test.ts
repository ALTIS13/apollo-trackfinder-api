import { describe, expect, it } from "vitest";
import {
  createModuleHeartbeatSignature,
  ModuleHeartbeatService,
  parseModuleHeartbeatKeys,
} from "./module-heartbeat";

const SEARCH_MEDIA_SECRET = "s".repeat(32);
const ACCOUNT_INTEGRATIONS_SECRET = "a".repeat(32);
const INITIAL_NOW = Date.parse("2026-07-15T04:31:02.000Z");

const validPayload = {
  schemaVersion: 1,
  status: "healthy",
  version: "2.15.0",
  deployedAt: "2026-07-15T04:30:00.000Z",
  requestsPerMinute: 42,
};

function createService(now = INITIAL_NOW) {
  let currentNow = now;
  const service = new ModuleHeartbeatService({
    keys: new Map([
      ["search-media", SEARCH_MEDIA_SECRET],
      ["account-integrations", ACCOUNT_INTEGRATIONS_SECRET],
    ]),
    now: () => currentNow,
  });

  return {
    service,
    get now() {
      return currentNow;
    },
    set now(value: number) {
      currentNow = value;
    },
  };
}

function createHeartbeatInput(
  options: {
    moduleId?: string;
    timestamp?: string;
    nonce?: string;
    secret?: string;
    rawBody?: Buffer;
    signature?: string;
  } = {},
) {
  const moduleId = options.moduleId ?? "search-media";
  const timestamp = options.timestamp ?? new Date(INITIAL_NOW).toISOString();
  const nonce = options.nonce ?? "nonce-1";
  const rawBody = options.rawBody ?? Buffer.from(JSON.stringify(validPayload));
  const secret = options.secret ?? SEARCH_MEDIA_SECRET;
  const hasExplicitSignature = Object.hasOwn(options, "signature");

  return {
    moduleId,
    timestamp,
    nonce,
    rawBody,
    signature: hasExplicitSignature
      ? options.signature
      : createModuleHeartbeatSignature({
          moduleId,
          timestamp,
          nonce,
          rawBody,
          secret,
        }),
  };
}

describe("ModuleHeartbeatService", () => {
  it("disables ingestion when no module keys are configured", () => {
    const service = new ModuleHeartbeatService({ keys: new Map() });

    expect(service.ingest(createHeartbeatInput())).toEqual({
      kind: "disabled",
    });
  });

  it("accepts a valid signed heartbeat and exposes its observation", () => {
    const { service } = createService();

    expect(service.ingest(createHeartbeatInput())).toEqual({
      kind: "accepted",
      receivedAt: "2026-07-15T04:31:02.000Z",
    });
    expect(service.snapshot()).toEqual([
      {
        moduleId: "search-media",
        managed: true,
        status: "healthy",
        version: "2.15.0",
        deployedAt: "2026-07-15T04:30:00.000Z",
        lastHeartbeatAt: "2026-07-15T04:31:02.000Z",
        requestsPerMinute: 42,
      },
      {
        moduleId: "account-integrations",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      },
    ]);
  });

  it("rejects a signature when the signed raw body changes", () => {
    const { service } = createService();
    const signed = createHeartbeatInput();

    expect(
      service.ingest({
        ...signed,
        rawBody: Buffer.from(
          JSON.stringify({ ...validPayload, requestsPerMinute: 43 }),
        ),
      }),
    ).toEqual({ kind: "unauthorized" });
  });

  it("does not let one configured module report another configured module", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          moduleId: "account-integrations",
          secret: SEARCH_MEDIA_SECRET,
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("returns unauthorized for an unknown module", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          moduleId: "unknown-module",
          secret: "u".repeat(32),
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it.each([
    ["missing", undefined],
    ["wrong", "v1=" + "0".repeat(64)],
    ["malformed", "not-a-signature"],
  ])("returns unauthorized for a %s signature", (_label, signature) => {
    const { service } = createService();

    expect(service.ingest(createHeartbeatInput({ signature }))).toEqual({
      kind: "unauthorized",
    });
  });

  it.each([-60_001, 60_001])(
    "rejects a signed timestamp outside the 60-second window",
    (offset) => {
      const { service } = createService();
      const timestamp = new Date(INITIAL_NOW + offset).toISOString();

      expect(
        service.ingest(
          createHeartbeatInput({
            timestamp,
            nonce: `outside-${offset}`,
          }),
        ),
      ).toEqual({ kind: "invalid" });
    },
  );

  it("rejects a replayed nonce", () => {
    const { service } = createService();
    const input = createHeartbeatInput();

    expect(service.ingest(input)).toMatchObject({ kind: "accepted" });
    expect(service.ingest(input)).toEqual({ kind: "invalid" });
  });

  it("rejects the 129th live nonce without evicting replay records", () => {
    const { service } = createService();
    let firstInput: ReturnType<typeof createHeartbeatInput> | undefined;

    for (let index = 0; index < 128; index += 1) {
      const input = createHeartbeatInput({ nonce: `nonce-${index}` });
      if (index === 0) firstInput = input;
      expect(service.ingest(input)).toMatchObject({ kind: "accepted" });
    }

    expect(
      service.ingest(createHeartbeatInput({ nonce: "nonce-128" })),
    ).toEqual({ kind: "invalid" });
    expect(service.ingest(firstInput!)).toEqual({ kind: "invalid" });
  });

  it("prunes nonce records only after they are older than five minutes", () => {
    const state = createService();

    for (let index = 0; index < 128; index += 1) {
      expect(
        state.service.ingest(createHeartbeatInput({ nonce: `nonce-${index}` })),
      ).toMatchObject({ kind: "accepted" });
    }

    state.now += 5 * 60_000 + 1;
    expect(
      state.service.ingest(
        createHeartbeatInput({
          nonce: "nonce-after-expiry",
          timestamp: new Date(state.now).toISOString(),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("accepts equal signed timestamps with distinct nonces", () => {
    const { service } = createService();
    const timestamp = new Date(INITIAL_NOW).toISOString();

    expect(
      service.ingest(createHeartbeatInput({ timestamp, nonce: "nonce-a" })),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(createHeartbeatInput({ timestamp, nonce: "nonce-b" })),
    ).toMatchObject({ kind: "accepted" });
  });

  it("marks a lower signed timestamp as stale after accepting a newer heartbeat", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: new Date(INITIAL_NOW + 1).toISOString(),
          nonce: "newer",
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: new Date(INITIAL_NOW).toISOString(),
          nonce: "older",
        }),
      ),
    ).toEqual({ kind: "stale" });
  });

  it.each([
    [
      "unknown field",
      Buffer.from(JSON.stringify({ ...validPayload, extra: true })),
    ],
    [
      "non-finite RPM",
      Buffer.from(
        '{"schemaVersion":1,"status":"healthy","version":"2.15.0","requestsPerMinute":1e400}',
      ),
    ],
    [
      "negative RPM",
      Buffer.from(JSON.stringify({ ...validPayload, requestsPerMinute: -1 })),
    ],
    [
      "over-one-million RPM",
      Buffer.from(
        JSON.stringify({ ...validPayload, requestsPerMinute: 1_000_001 }),
      ),
    ],
  ])("rejects a strict payload with %s", (_label, rawBody) => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({ rawBody, nonce: `invalid-${_label}` }),
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("keeps a heartbeat fresh through 90 seconds", () => {
    const state = createService();

    expect(state.service.ingest(createHeartbeatInput())).toMatchObject({
      kind: "accepted",
    });
    state.now += 90_000;

    expect(
      state.service
        .snapshot()
        .find((observation) => observation.moduleId === "search-media"),
    ).toMatchObject({
      moduleId: "search-media",
      status: "healthy",
      requestsPerMinute: 42,
    });
  });

  it("expires a heartbeat after 90 seconds while retaining its history", () => {
    const state = createService();

    expect(state.service.ingest(createHeartbeatInput())).toMatchObject({
      kind: "accepted",
    });
    state.now += 90_001;

    expect(
      state.service
        .snapshot()
        .find((observation) => observation.moduleId === "search-media"),
    ).toMatchObject({
      moduleId: "search-media",
      managed: true,
      status: "unknown",
      version: "2.15.0",
      deployedAt: "2026-07-15T04:30:00.000Z",
      lastHeartbeatAt: "2026-07-15T04:31:02.000Z",
      requestsPerMinute: 0,
    });
  });

  it("returns unknown managed entries without receipt times after restart", () => {
    const { service } = createService();

    expect(service.snapshot()).toEqual([
      {
        moduleId: "search-media",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      },
      {
        moduleId: "account-integrations",
        managed: true,
        status: "unknown",
        version: "unknown",
        requestsPerMinute: 0,
      },
    ]);
  });
});

describe("parseModuleHeartbeatKeys", () => {
  it("parses configured module secrets", () => {
    expect(
      parseModuleHeartbeatKeys(
        JSON.stringify({
          "search-media": SEARCH_MEDIA_SECRET,
          "account-integrations": ACCOUNT_INTEGRATIONS_SECRET,
        }),
      ),
    ).toEqual(
      new Map([
        ["search-media", SEARCH_MEDIA_SECRET],
        ["account-integrations", ACCOUNT_INTEGRATIONS_SECRET],
      ]),
    );
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["non-object JSON", "[]"],
    ["unknown module ID", JSON.stringify({ "unknown-module": "u".repeat(32) })],
    [
      "over 128 entries",
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [
            `module-${index}`,
            "s".repeat(32),
          ]),
        ),
      ),
    ],
    ["short secret", JSON.stringify({ "search-media": "s".repeat(31) })],
    ["long secret", JSON.stringify({ "search-media": "s".repeat(513) })],
  ])("returns no keys for %s", (_label, raw) => {
    expect(parseModuleHeartbeatKeys(raw)).toEqual(new Map());
  });
});
