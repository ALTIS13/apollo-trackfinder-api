import type {
  TfSearchArtistDiscoveryCommand,
  TfSearchArtistDiscoveryResponse,
  TfSearchCommand,
  TfSearchResponse,
  TfSearchResult,
  TfSearchSource,
  TfSearchSuggestionsCommand,
  TfSearchSuggestionsResponse,
} from "@workspace/tf-search-contract";
import { BoundedSearchCache, type SearchCacheIdentity } from "./cache.js";
import { filterCompleteMedia } from "./media-completeness.js";
import { rank } from "./ranker.js";

export type InternalTrack = TfSearchResult;

export interface SearchProvider {
  readonly source: TfSearchSource;
  search(query: string, limit: number): Promise<readonly InternalTrack[]>;
}

export interface SearchService {
  search(command: TfSearchCommand): Promise<TfSearchResponse>;
  discoverArtist(
    command: TfSearchArtistDiscoveryCommand,
  ): Promise<TfSearchArtistDiscoveryResponse>;
  suggestions(command: TfSearchSuggestionsCommand): Promise<TfSearchSuggestionsResponse>;
  telemetry(): {
    readonly requestsPerMinute: number;
    readonly status: "healthy" | "warning" | "degraded";
  };
  parserTelemetry?: () => readonly ParserTelemetrySnapshot[];
}

export interface RuntimeSearchService extends SearchService {
  parserTelemetry(): readonly ParserTelemetrySnapshot[];
}

export interface ParserTelemetrySnapshot {
  readonly source: TfSearchSource;
  readonly status: "healthy" | "warning" | "degraded" | "unknown";
  readonly requestsPerMinute: number;
  readonly failuresPerMinute: number;
  readonly previewsRejectedPerMinute: number;
  readonly lastCheckedAt?: string;
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
type ProviderStatus = "ok" | "failed" | "skipped";

const RESULT_SOURCE_TO_PROVIDER: Readonly<
  Record<InternalTrack["source"], TfSearchSource>
> = {
  youtube: "yt",
  soundcloud: "sc",
  bandcamp: "bc",
  deezer: "dz",
};

interface ParserRollingTelemetry {
  readonly bucketSeconds: Int32Array;
  readonly requests: Int32Array;
  readonly failures: Int32Array;
  readonly previewsRejected: Int32Array;
  lastCheckedAt?: number;
}

function createParserRollingTelemetry(): ParserRollingTelemetry {
  return {
    bucketSeconds: new Int32Array(ROLLING_WINDOW_SECONDS).fill(-1),
    requests: new Int32Array(ROLLING_WINDOW_SECONDS),
    failures: new Int32Array(ROLLING_WINDOW_SECONDS),
    previewsRejected: new Int32Array(ROLLING_WINDOW_SECONDS),
  };
}

function cacheIdentity(command: TfSearchCommand): SearchCacheIdentity {
  return {
    artist: command.artist,
    title: command.title,
    mode: command.mode,
    sources: command.sources,
    maxResults: command.maxResults,
  };
}

function isCacheable(command: TfSearchCommand): boolean {
  return command.maxResults <= 20
    && command.sources.length === ALL_SOURCES.length
    && ALL_SOURCES.every((source) => command.sources.includes(source));
}

function providerLimit(source: TfSearchSource, maxResults: number): number {
  return source === "yt" || source === "sc" ? maxResults : Math.ceil(maxResults / 2);
}

function initialProviderStatus(): Record<TfSearchSource, ProviderStatus> {
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

class SearchServiceImpl implements RuntimeSearchService {
  private readonly providers: ReadonlyMap<TfSearchSource, SearchProvider>;
  private readonly cache: BoundedSearchCache;
  private readonly now: () => number;
  private readonly logger?: SearchLogger;
  private readonly requestBuckets = new Int32Array(ROLLING_WINDOW_SECONDS);
  private readonly partialFailureBuckets = new Int32Array(ROLLING_WINDOW_SECONDS);
  private readonly totalFailureBuckets = new Int32Array(ROLLING_WINDOW_SECONDS);
  private readonly bucketSeconds = new Int32Array(ROLLING_WINDOW_SECONDS).fill(-1);
  private readonly parserBuckets = new Map<TfSearchSource, ParserRollingTelemetry>(
    ALL_SOURCES.map((source) => [source, createParserRollingTelemetry()]),
  );

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
      const cached = this.cache.get(cacheIdentity(command));
      if (cached) {
        return {
          schemaVersion: 1,
          requestId: command.requestId,
          query,
          results: cached.slice(0, command.maxResults),
          cached: true,
          sources: command.sources,
          fallbackAvailable: false,
          providerStatus: initialProviderStatus(),
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
    let succeededProviders = 0;
    let failedProviders = 0;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const source = selectedProviders[index]!.source;
      if (outcome.status === "fulfilled") {
        providerStatus[source] = "ok";
        succeededProviders += 1;
        results.push(...outcome.value.results);
        this.recordParserAttempt(source, false);
      } else {
        providerStatus[source] = "failed";
        failedProviders += 1;
        this.recordParserAttempt(source, true);
        this.logger?.warn({ source, errorClass: "provider_failure" });
      }
    }

    if (failedProviders > 0) this.recordFailure(succeededProviders === 0);

    const completeMedia = filterCompleteMedia(results);
    for (const rejection of completeMedia.rejected) {
      this.recordParserRejections(
        RESULT_SOURCE_TO_PROVIDER[rejection.source],
        rejection.count,
      );
    }
    const ranked = rank(completeMedia.accepted, { artist: command.artist, title: command.title }, medianOriginalDuration(completeMedia.accepted), {
      mode: command.mode,
      queryText: query,
    }).slice(0, command.maxResults);

    if (cacheable && failedProviders === 0) {
      this.cache.set(cacheIdentity(command), ranked);
    }

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

  async discoverArtist(
    command: TfSearchArtistDiscoveryCommand,
  ): Promise<TfSearchArtistDiscoveryResponse> {
    this.recordRequest();
    const providerStatus = initialProviderStatus();
    const selectedProviders = command.sources.map((source) => ({
      source,
      provider: this.providers.get(source),
    }));
    const settled = await Promise.allSettled(
      selectedProviders.map(async ({ source, provider }) => {
        if (!provider) throw { source };
        const results = await provider.search(
          command.artist,
          command.limitPerSource,
        );
        return { source, results };
      }),
    );

    const results: InternalTrack[] = [];
    let succeededProviders = 0;
    let failedProviders = 0;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const source = selectedProviders[index]!.source;
      if (outcome.status === "fulfilled") {
        providerStatus[source] = "ok";
        succeededProviders += 1;
        results.push(...outcome.value.results.slice(0, command.limitPerSource));
        this.recordParserAttempt(source, false);
      } else {
        providerStatus[source] = "failed";
        failedProviders += 1;
        this.recordParserAttempt(source, true);
        this.logger?.warn({ source, errorClass: "provider_failure" });
      }
    }

    if (failedProviders > 0) this.recordFailure(succeededProviders === 0);

    const completeMedia = filterCompleteMedia(results);
    for (const rejection of completeMedia.rejected) {
      this.recordParserRejections(
        RESULT_SOURCE_TO_PROVIDER[rejection.source],
        rejection.count,
      );
    }

    return {
      schemaVersion: 1,
      requestId: command.requestId,
      query: command.artist,
      results: completeMedia.accepted.slice(0, 40),
      sources: command.sources,
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
    let partialFailures = 0;
    let totalFailures = 0;
    for (let index = 0; index < ROLLING_WINDOW_SECONDS; index += 1) {
      if (this.bucketSeconds[index]! < nowSecond - (ROLLING_WINDOW_SECONDS - 1)
        || this.bucketSeconds[index]! > nowSecond) {
        this.requestBuckets[index] = 0;
        this.partialFailureBuckets[index] = 0;
        this.totalFailureBuckets[index] = 0;
        continue;
      }
      requestsPerMinute += this.requestBuckets[index]!;
      partialFailures += this.partialFailureBuckets[index]!;
      totalFailures += this.totalFailureBuckets[index]!;
    }

    const status = totalFailures >= 3
      ? "degraded"
      : partialFailures + totalFailures > 0
        ? "warning"
        : "healthy";
    return { requestsPerMinute, status };
  }

  parserTelemetry(): readonly ParserTelemetrySnapshot[] {
    const now = this.now();
    const nowSecond = Math.floor(now / 1_000);
    return ALL_SOURCES.map((source) => {
      const telemetry = this.parserBuckets.get(source)!;
      let requestsPerMinute = 0;
      let failuresPerMinute = 0;
      let previewsRejectedPerMinute = 0;
      for (let index = 0; index < ROLLING_WINDOW_SECONDS; index += 1) {
        if (
          telemetry.bucketSeconds[index]! <
            nowSecond - (ROLLING_WINDOW_SECONDS - 1) ||
          telemetry.bucketSeconds[index]! > nowSecond
        ) {
          telemetry.requests[index] = 0;
          telemetry.failures[index] = 0;
          telemetry.previewsRejected[index] = 0;
          continue;
        }
        requestsPerMinute += telemetry.requests[index]!;
        failuresPerMinute += telemetry.failures[index]!;
        previewsRejectedPerMinute += telemetry.previewsRejected[index]!;
      }
      const status =
        requestsPerMinute === 0
          ? "unknown"
          : failuresPerMinute >= 3
            ? "degraded"
            : failuresPerMinute > 0 || previewsRejectedPerMinute > 0
              ? "warning"
              : "healthy";
      return {
        source,
        status,
        requestsPerMinute,
        failuresPerMinute,
        previewsRejectedPerMinute,
        ...(telemetry.lastCheckedAt === undefined
          ? {}
          : { lastCheckedAt: new Date(telemetry.lastCheckedAt).toISOString() }),
      };
    });
  }

  private recordRequest(): void {
    const second = Math.floor(this.now() / 1_000);
    const bucketIndex = this.ensureBucket(second);
    this.requestBuckets[bucketIndex] += 1;
  }

  private recordFailure(total: boolean): void {
    const bucketIndex = this.ensureBucket(Math.floor(this.now() / 1_000));
    if (total) {
      this.totalFailureBuckets[bucketIndex] += 1;
    } else {
      this.partialFailureBuckets[bucketIndex] += 1;
    }
  }

  private recordParserAttempt(source: TfSearchSource, failed: boolean): void {
    const now = this.now();
    const telemetry = this.parserBuckets.get(source)!;
    const bucketIndex = this.ensureParserBucket(
      telemetry,
      Math.floor(now / 1_000),
    );
    telemetry.requests[bucketIndex] += 1;
    if (failed) telemetry.failures[bucketIndex] += 1;
    telemetry.lastCheckedAt = now;
  }

  private recordParserRejections(source: TfSearchSource, count: number): void {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const telemetry = this.parserBuckets.get(source)!;
    const bucketIndex = this.ensureParserBucket(
      telemetry,
      Math.floor(this.now() / 1_000),
    );
    telemetry.previewsRejected[bucketIndex] += count;
  }

  private ensureParserBucket(
    telemetry: ParserRollingTelemetry,
    second: number,
  ): number {
    const bucketIndex =
      ((second % ROLLING_WINDOW_SECONDS) + ROLLING_WINDOW_SECONDS) %
      ROLLING_WINDOW_SECONDS;
    if (telemetry.bucketSeconds[bucketIndex] !== second) {
      telemetry.bucketSeconds[bucketIndex] = second;
      telemetry.requests[bucketIndex] = 0;
      telemetry.failures[bucketIndex] = 0;
      telemetry.previewsRejected[bucketIndex] = 0;
    }
    return bucketIndex;
  }

  private ensureBucket(second: number): number {
    const bucketIndex = ((second % ROLLING_WINDOW_SECONDS) + ROLLING_WINDOW_SECONDS) % ROLLING_WINDOW_SECONDS;
    if (this.bucketSeconds[bucketIndex] !== second) {
      this.bucketSeconds[bucketIndex] = second;
      this.requestBuckets[bucketIndex] = 0;
      this.partialFailureBuckets[bucketIndex] = 0;
      this.totalFailureBuckets[bucketIndex] = 0;
    }
    return bucketIndex;
  }
}

export function createSearchService(options: SearchServiceOptions): RuntimeSearchService {
  return new SearchServiceImpl(options);
}
