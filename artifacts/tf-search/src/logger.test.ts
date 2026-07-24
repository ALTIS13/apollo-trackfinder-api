import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTfSearchLogger } from "./logger.js";

describe("TF search logger", () => {
  it("redacts command and provider-sensitive values", () => {
    const destination = new PassThrough();
    let output = "";
    destination.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const logger = createTfSearchLogger(destination);

    logger.warn(
      {
        query: "private artist private title",
        sourceUrl: "https://provider.example.test/private",
        body: '{"private":"body"}',
        headers: { "x-apollo-internal-signature": "v1=secret" },
        err: new Error("raw provider failure"),
      },
      "search provider unavailable",
    );

    expect(output).not.toContain("private artist");
    expect(output).not.toContain("provider.example.test");
    expect(output).not.toContain("v1=secret");
    expect(output).not.toContain("raw provider failure");
    expect(output).toContain("[REDACTED]");
  });
});
