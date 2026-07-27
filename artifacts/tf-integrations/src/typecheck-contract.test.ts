import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("tf-integrations typecheck contract", () => {
  it("typechecks without build mode or emitted project artifacts", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const tsconfig = JSON.parse(
      await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
    ) as {
      readonly references?: readonly unknown[];
    };

    expect(packageJson.scripts?.typecheck).toBe(
      "tsc -p tsconfig.json --noEmit",
    );
    expect(packageJson.scripts?.typecheck).not.toMatch(/--build|-b\b/);
    expect(packageJson.scripts?.test).toBe("vitest run src");
    expect(tsconfig.references).toBeUndefined();
  });
});
