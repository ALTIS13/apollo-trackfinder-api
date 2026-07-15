import { describe, expect, it } from "vitest";
import {
  createModuleHeartbeatSignature,
  ModuleHeartbeatService,
  parseModuleHeartbeatKeys,
} from "./module-heartbeat";

const SEARCH_MEDIA_SECRET = "s".repeat(32);
const ACCOUNT_INTEGRATIONS_SECRET = "a".repeat(32);
const INITIAL_NOW = Date.parse("2026-07-15T04:31:02.000Z");
const INITIAL_TIMESTAMP = String(Math.floor(INITIAL_NOW / 1_000));

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

function timestampFor(time: number): string {
  return String(Math.floor(time / 1_000));
}

function nonceFor(value: string | number): string {
  return `nonce-${String(value).padStart(16, "0")}`;
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
  const timestamp = options.timestamp ?? INITIAL_TIMESTAMP;
  const nonce = options.nonce ?? nonceFor("default");
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

  it("accepts a signed Unix-second heartbeat and exposes its observation", () => {
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

  it.each([-61_000, 61_000])(
    "returns unauthorized for a signed timestamp outside the 60-second window",
    (offset) => {
      const { service } = createService();
      const timestamp = timestampFor(INITIAL_NOW + offset);

      expect(
        service.ingest(
          createHeartbeatInput({
            timestamp,
            nonce: nonceFor(`outside-${offset}`),
          }),
        ),
      ).toEqual({ kind: "unauthorized" });
    },
  );

  it("prioritizes expired timestamp authentication over JSON validation", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: timestampFor(INITIAL_NOW - 61_000),
          nonce: nonceFor("expired-json"),
          rawBody: Buffer.from("{"),
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("rejects an ISO timestamp even when its signature is valid", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: new Date(INITIAL_NOW).toISOString(),
          nonce: nonceFor("iso-timestamp"),
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it.each([
    ["short", "short-nonce"],
    ["long", "a".repeat(65)],
    ["non-ASCII", `${nonceFor("unicode")}é`],
    ["control-character", `${nonceFor("control")}\n`],
  ])("returns unauthorized for a %s nonce", (_label, nonce) => {
    const { service } = createService();

    expect(service.ingest(createHeartbeatInput({ nonce }))).toEqual({
      kind: "unauthorized",
    });
  });

  it("rejects a replayed nonce", () => {
    const { service } = createService();
    const input = createHeartbeatInput();

    expect(service.ingest(input)).toMatchObject({ kind: "accepted" });
    expect(service.ingest(input)).toEqual({ kind: "unauthorized" });
  });

  it("prioritizes a replayed nonce over malformed JSON", () => {
    const { service } = createService();
    const nonce = nonceFor("replay-malformed");

    expect(service.ingest(createHeartbeatInput({ nonce }))).toMatchObject({
      kind: "accepted",
    });
    expect(
      service.ingest(
        createHeartbeatInput({ nonce, rawBody: Buffer.from("{") }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("allows the same nonce from different configured modules", () => {
    const { service } = createService();
    const nonce = nonceFor("shared");

    expect(service.ingest(createHeartbeatInput({ nonce }))).toMatchObject({
      kind: "accepted",
    });
    expect(
      service.ingest(
        createHeartbeatInput({
          moduleId: "account-integrations",
          secret: ACCOUNT_INTEGRATIONS_SECRET,
          nonce,
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("rejects the 129th live nonce without evicting replay records", () => {
    const { service } = createService();
    let firstInput: ReturnType<typeof createHeartbeatInput> | undefined;

    for (let index = 0; index < 128; index += 1) {
      const input = createHeartbeatInput({ nonce: nonceFor(index) });
      if (index === 0) firstInput = input;
      expect(service.ingest(input)).toMatchObject({ kind: "accepted" });
    }

    expect(
      service.ingest(createHeartbeatInput({ nonce: nonceFor(128) })),
    ).toEqual({ kind: "unauthorized" });
    expect(service.ingest(firstInput!)).toEqual({ kind: "unauthorized" });
  });

  it("prioritizes full nonce capacity over strict payload validation", () => {
    const { service } = createService();

    for (let index = 0; index < 128; index += 1) {
      expect(
        service.ingest(createHeartbeatInput({ nonce: nonceFor(index) })),
      ).toMatchObject({ kind: "accepted" });
    }

    expect(
      service.ingest(
        createHeartbeatInput({
          nonce: nonceFor(128),
          rawBody: Buffer.from(
            JSON.stringify({ ...validPayload, extra: true }),
          ),
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("keeps replay records and nonce capacity independent for each module", () => {
    const { service } = createService();

    for (let index = 0; index < 128; index += 1) {
      expect(
        service.ingest(createHeartbeatInput({ nonce: nonceFor(index) })),
      ).toMatchObject({ kind: "accepted" });
    }

    expect(
      service.ingest(
        createHeartbeatInput({
          moduleId: "account-integrations",
          secret: ACCOUNT_INTEGRATIONS_SECRET,
          nonce: nonceFor("account-module"),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({
          moduleId: "account-integrations",
          secret: ACCOUNT_INTEGRATIONS_SECRET,
          nonce: nonceFor("account-module"),
        }),
      ),
    ).toEqual({ kind: "unauthorized" });
  });

  it("prunes nonce records only after they are older than five minutes", () => {
    const state = createService();

    for (let index = 0; index < 128; index += 1) {
      expect(
        state.service.ingest(createHeartbeatInput({ nonce: nonceFor(index) })),
      ).toMatchObject({ kind: "accepted" });
    }

    state.now += 5 * 60_000 + 1;
    expect(
      state.service.ingest(
        createHeartbeatInput({
          nonce: nonceFor("after-expiry"),
          timestamp: timestampFor(state.now),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("accepts equal signed timestamps with distinct nonces", () => {
    const { service } = createService();
    const timestamp = INITIAL_TIMESTAMP;

    expect(
      service.ingest(
        createHeartbeatInput({ timestamp, nonce: nonceFor("equal-a") }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({ timestamp, nonce: nonceFor("equal-b") }),
      ),
    ).toMatchObject({ kind: "accepted" });
  });

  it("marks a lower signed timestamp as stale after accepting a newer heartbeat", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: timestampFor(INITIAL_NOW + 1_000),
          nonce: nonceFor("newer"),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: INITIAL_TIMESTAMP,
          nonce: nonceFor("older"),
        }),
      ),
    ).toEqual({ kind: "stale" });
  });

  it("prioritizes a lower signed timestamp over malformed JSON", () => {
    const { service } = createService();

    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: timestampFor(INITIAL_NOW + 1_000),
          nonce: nonceFor("newer-malformed"),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: INITIAL_TIMESTAMP,
          nonce: nonceFor("older-malformed"),
          rawBody: Buffer.from("{"),
        }),
      ),
    ).toEqual({ kind: "stale" });
  });

  it("prioritizes a replayed nonce over stale timestamp ordering", () => {
    const { service } = createService();
    const first = createHeartbeatInput({
      timestamp: INITIAL_TIMESTAMP,
      nonce: nonceFor("first-overlap"),
    });

    expect(service.ingest(first)).toMatchObject({ kind: "accepted" });
    expect(
      service.ingest(
        createHeartbeatInput({
          timestamp: timestampFor(INITIAL_NOW + 1_000),
          nonce: nonceFor("newer-overlap"),
        }),
      ),
    ).toMatchObject({ kind: "accepted" });
    expect(service.ingest(first)).toEqual({ kind: "unauthorized" });
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
        createHeartbeatInput({ rawBody, nonce: nonceFor(`invalid-${_label}`) }),
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
