import { describe, expect, it } from "vitest";
import { SearchTracksBody } from "./generated/api";

describe("generated public search schema", () => {
  it("trims valid artist/title values and rejects whitespace-only values", () => {
    expect(
      SearchTracksBody.parse({
        artist: "  Artist  ",
        title: "  Track  ",
      }),
    ).toMatchObject({
      artist: "Artist",
      title: "Track",
    });
    expect(
      SearchTracksBody.safeParse({ artist: "   ", title: "Track" }).success,
    ).toBe(false);
    expect(
      SearchTracksBody.safeParse({ artist: "Artist", title: "\t\r\n" }).success,
    ).toBe(false);
  });

  it("enforces integer maxResults and unique sources in the generated contract", () => {
    expect(
      SearchTracksBody.safeParse({
        artist: "Artist",
        title: "Track",
        maxResults: 1.5,
      }).success,
    ).toBe(false);
    expect(
      SearchTracksBody.safeParse({
        artist: "Artist",
        title: "Track",
        sources: ["yt", "yt"],
      }).success,
    ).toBe(false);
    expect(
      SearchTracksBody.safeParse({
        artist: "Artist",
        title: "Track",
        maxResults: 40,
        sources: ["yt", "sc", "bc", "dz"],
      }).success,
    ).toBe(true);
  });
});
