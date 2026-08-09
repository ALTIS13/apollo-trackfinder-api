import { describe, expect, it } from "vitest";
import type { InternalTrack } from "./search-service.js";
import {
  assessMediaCompleteness,
  filterCompleteMedia,
} from "./media-completeness.js";

function track(overrides: Partial<InternalTrack> = {}): InternalTrack {
  return {
    id: "yt_full",
    title: "Track",
    artist: "Artist",
    type: "original",
    duration: 210,
    source: "youtube",
    thumbnailUrl: null,
    quality: ["128"],
    viewCount: 1_000,
    score: 0,
    sourceUrl: "https://www.youtube.com/watch?v=full",
    ...overrides,
  };
}

describe("media completeness gate", () => {
  it.each([
    [
      "provider preview URL",
      track({
        id: "dz_preview",
        source: "deezer",
        sourceUrl:
          "https://cdns-preview-a.dzcdn.net/stream/c-a-preview.mp3",
      }),
      210,
      "provider_preview_url",
    ],
    [
      "title marker",
      track({ id: "yt_demo", title: "Track (30 sec preview)" }),
      210,
      "title_marker",
    ],
    [
      "duration outlier",
      track({ id: "sc_short", source: "soundcloud", duration: 72 }),
      210,
      "duration_outlier",
    ],
    ["full track", track(), 210, undefined],
  ] as const)("classifies %s", (_label, candidate, referenceDuration, reason) => {
    expect(assessMediaCompleteness(candidate, referenceDuration)).toEqual(
      reason === undefined
        ? { complete: true }
        : { complete: false, reason },
    );
  });

  it("filters rejected media and reports bounded counts by source and reason", () => {
    const result = filterCompleteMedia([
      track(),
      track({
        id: "dz_preview",
        source: "deezer",
        sourceUrl:
          "https://cdns-preview-a.dzcdn.net/stream/c-a-preview.mp3",
      }),
      track({
        id: "sc_short",
        source: "soundcloud",
        duration: 72,
      }),
    ]);

    expect(result.accepted.map((candidate) => candidate.id)).toEqual([
      "yt_full",
    ]);
    expect(result.rejected).toEqual([
      {
        source: "soundcloud",
        reason: "duration_outlier",
        count: 1,
      },
      {
        source: "deezer",
        reason: "provider_preview_url",
        count: 1,
      },
    ]);
  });
});
