import type {
  TfSearchResultSource,
  TfSearchSource,
} from "@workspace/tf-search-contract";
import { searchBandcamp } from "./adapters/bandcamp.js";
import { searchDeezer } from "./adapters/deezer.js";
import { searchSoundCloud } from "./adapters/soundcloud.js";
import { searchYouTube } from "./adapters/youtube.js";
import type { SearchProvider } from "./search-service.js";

const resultSources: Readonly<Record<TfSearchSource, TfSearchResultSource>> = {
  yt: "youtube",
  sc: "soundcloud",
  bc: "bandcamp",
  dz: "deezer",
};

function fixtureProvider(source: TfSearchSource): SearchProvider {
  async function fixtureSearch() {
    return [
      {
        id: `${source}_fixture-track`,
        title: "Fixture Track",
        artist: "Fixture Artist",
        type: "original" as const,
        duration: 180,
        source: resultSources[source],
        thumbnailUrl: null,
        quality: ["fixture"],
        viewCount: 1_000,
        score: 0,
        sourceUrl: `https://fixture.invalid/${source}/fixture-track`,
      },
    ];
  }
  return { source, search: fixtureSearch };
}

export function createRuntimeProviders(
  fixtureAdapters: boolean,
): readonly SearchProvider[] {
  if (fixtureAdapters) {
    return (["yt", "sc", "bc", "dz"] as const).map(fixtureProvider);
  }
  return [
    { source: "yt", search: searchYouTube },
    { source: "sc", search: searchSoundCloud },
    { source: "bc", search: searchBandcamp },
    { source: "dz", search: searchDeezer },
  ];
}
