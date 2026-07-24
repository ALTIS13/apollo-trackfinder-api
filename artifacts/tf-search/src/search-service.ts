import type {
  TfSearchCommand,
  TfSearchResponse,
  TfSearchResult,
  TfSearchSource,
  TfSearchSuggestionsCommand,
  TfSearchSuggestionsResponse,
} from "@workspace/tf-search-contract";
import { BoundedSearchCache } from "./cache.js";
import { rank } from "./ranker.js";

export type InternalTrack = TfSearchResult;

export interface SearchProvider {
  readonly source: TfSearchSource;
  search(query: string, limit: number): Promise<readonly InternalTrack[]>;
}

export interface SearchService {
  search(command: TfSearchCommand): Promise<TfSearchResponse>;
  suggestions(command: TfSearchSuggestionsCommand): Promise<TfSearchSuggestionsResponse>;
  telemetry(): {
    readonly requestsPerMinute: number;
    readonly status: "healthy" | "warning" | "degraded";
  };
}

interface SearchLogger {
  warn(event: { readonly source: TfSearchSource; readonly errorClass: "provider_failure" }): void;
}

interface SearchServiceOptions {
  readonly providers: readonly SearchProvider[];
  readonly cache?: BoundedSearchCache;
  readonly now?: () => number;
  readonly logger?: SearchLogger;
}

const ALL_SOURCES: readonly TfSearchSource[] = ["yt", "sc", "bc", "dz"];
const ROLLING_WINDOW_SECONDS = 60;

function isCacheable(command: TfSearchCommand): boolean {
  return command.maxResults <= 20
    && command.sources.length === ALL_SOURCES.length
    && ALL_SOURCES.every((source) => command.sources.includes(source));
}

function providerLimit(source: TfSearchSource, maxResults: number): number {
  return source === "yt" || source === "sc" ? maxResults : Math.ceil(maxResults / 2);
}

function initialProviderStatus(): Record<TfSearchSource, "ok" | "failed" | "skipped"> {
  return { yt: "skipped", sc: "skipped", bc: "skipped", dz: "skipped" };
}

function medianOriginalDuration(results: readonly InternalTrack[]): number | undefined {
  const durations = results
    .filter((result) => result.type === "original" && result.duration > 0)
    .map((result) => result.duration)
    .sort((left, right) => left - right);
  return durations.length > 0 ? durations[Math.floor(durations.length / 2)] : undefined;
}

export function toPublicSearchResult(result: InternalTrack): Omit<InternalTrack, "sourceUrl"> {
  const { sourceUrl: _, ...publicResult } = result;
  return publicResult;
}

class SearchServiceImpl implements SearchService {
  private readonly providers: ReadonlyMap<TfSearchSource, SearchProvider>;
  private readonly cache: BoundedSearchCache;
  private readonly now: () => number;
  private readonly logger?: SearchLogger;
  private readonly requestBuckets = new Int32Array(ROLLING_WINDOW_SECONDS);
  private readonly bucketSeconds = new Int32Array(ROLLING_WINDOW_SECONDS).fill(-1);

  constructor(options: SearchServiceOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.source, provider]));
    this.cache = options.cache ?? new BoundedSearchCache();
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  async search(command: TfSearchCommand): Promise<TfSearchResponse> {
    this.recordRequest();
    const query = `${command.artist} ${command.title}`;
    const cacheable = isCacheable(command);

    if (cacheable) {
      const cached = this.cache.get(command.artist, command.title);
      if (cached) {
        return {
          schemaVersion: 1,
          requestId: command.requestId,
          query,
          results: cached.slice(0, command.maxResults),
          cached: true,
          sources: command.sources,
          fallbackAvailable: false,
          providerStatus: { yt: "ok", sc: "ok", bc: "ok", dz: "ok" },
        };
      }
    }

    const providerStatus = initialProviderStatus();
    const selectedProviders = command.sources.map((source) => ({ source, provider: this.providers.get(source) }));
    const settled = await Promise.allSettled(selectedProviders.map(async ({ source, provider }) => {
      if (!provider) throw { source };
      const results = await provider.search(query, providerLimit(source, command.maxResults));
      return { source, results };
    }));

    const results: InternalTrack[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const source = selectedProviders[index]!.source;
      if (outcome.status === "fulfilled") {
        providerStatus[source] = "ok";
        results.push(...outcome.value.results);
      } else {
        providerStatus[source] = "failed";
        this.logger?.warn({ source, errorClass: "provider_failure" });
      }
    }

    const ranked = rank(results, { artist: command.artist, title: command.title }, medianOriginalDuration(results), {
      mode: command.mode,
      queryText: query,
    }).slice(0, command.maxResults);

    if (cacheable) this.cache.set(command.artist, command.title, ranked);

    return {
      schemaVersion: 1,
      requestId: command.requestId,
      query,
      results: ranked,
      cached: false,
      sources: command.sources,
      fallbackAvailable: command.mode === "manual" && ranked.length === 0 && command.sources.length < ALL_SOURCES.length,
      providerStatus,
    };
  }

  async suggestions(command: TfSearchSuggestionsCommand): Promise<TfSearchSuggestionsResponse> {
    return {
      schemaVersion: 1,
      requestId: command.requestId,
      suggestions: [...this.cache.suggestions(command.query, command.limit)],
    };
  }

  telemetry(): { readonly requestsPerMinute: number; readonly status: "healthy" | "warning" | "degraded" } {
    const nowSecond = Math.floor(this.now() / 1_000);
    let requestsPerMinute = 0;
    for (let index = 0; index < ROLLING_WINDOW_SECONDS; index += 1) {
      if (nowSecond - this.bucketSeconds[index]! >= ROLLING_WINDOW_SECONDS) {
        this.requestBuckets[index] = 0;
        continue;
      }
      requestsPerMinute += this.requestBuckets[index]!;
    }

    return { requestsPerMinute, status: "healthy" };
  }

  private recordRequest(): void {
    const second = Math.floor(this.now() / 1_000);
    const bucketIndex = ((second % ROLLING_WINDOW_SECONDS) + ROLLING_WINDOW_SECONDS) % ROLLING_WINDOW_SECONDS;
    if (this.bucketSeconds[bucketIndex] !== second) {
      this.bucketSeconds[bucketIndex] = second;
      this.requestBuckets[bucketIndex] = 0;
    }
    this.requestBuckets[bucketIndex] += 1;
  }
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  return new SearchServiceImpl(options);
}
