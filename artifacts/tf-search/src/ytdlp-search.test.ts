import { describe, expect, it } from "vitest";
import * as ytdlpSearch from "./ytdlp-search.js";

describe("yt-dlp search environment", () => {
  it("exports only the child environment allowlist and UTF-8 encoding", () => {
    const environmentBuilder = (ytdlpSearch as Record<string, unknown>)["createYtDlpEnvironment"];
    expect(environmentBuilder).toBeTypeOf("function");
    if (typeof environmentBuilder !== "function") return;

    const environment = (environmentBuilder as (input: NodeJS.ProcessEnv) => NodeJS.ProcessEnv)({
      PATH: "/safe/path",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      TF_SEARCH_INTERNAL_AUTH_SECRET: "must-not-reach-child",
      TF_SEARCH_HEARTBEAT_SECRET: "must-not-reach-child",
      UNRELATED_VARIABLE: "must-not-reach-child",
    });

    expect(environment).toEqual({
      PATH: "/safe/path",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      PYTHONIOENCODING: "utf-8",
    });
  });
});
