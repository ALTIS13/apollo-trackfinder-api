import type { TfSearchResultSource } from "@workspace/tf-search-contract";
import type { InternalTrack } from "./search-service.js";

export type MediaRejectionReason =
  | "provider_preview_url"
  | "title_marker"
  | "duration_outlier";

export type MediaCompletenessAssessment =
  | { readonly complete: true }
  | {
      readonly complete: false;
      readonly reason: MediaRejectionReason;
    };

export interface RejectedMediaSummary {
  readonly source: TfSearchResultSource;
  readonly reason: MediaRejectionReason;
  readonly count: number;
}

const TITLE_MARKER_PATTERN =
  /(?:\b(?:demo|preview|snippet|teaser|sample)\b|\b(?:30|45|60)\s*(?:s|sec|secs|second|seconds)\b|\b(?:демо|превью|отрывок|фрагмент|тизер)\b)/iu;
const SOURCE_ORDER: readonly TfSearchResultSource[] = [
  "youtube",
  "soundcloud",
  "bandcamp",
  "deezer",
];
const REASON_ORDER: readonly MediaRejectionReason[] = [
  "provider_preview_url",
  "title_marker",
  "duration_outlier",
];

function isProviderPreviewUrl(track: InternalTrack): boolean {
  if (track.source !== "deezer") return false;
  try {
    const url = new URL(track.sourceUrl);
    return (
      url.hostname.endsWith(".dzcdn.net") &&
      (url.hostname.includes("preview") || url.pathname.includes("preview"))
    );
  } catch {
    return false;
  }
}

function hasExplicitPreviewSignal(track: InternalTrack): boolean {
  return isProviderPreviewUrl(track) || TITLE_MARKER_PATTERN.test(track.title);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function referenceOriginalDuration(
  tracks: readonly InternalTrack[],
): number | undefined {
  return median(
    tracks
      .filter(
        (track) =>
          track.type === "original" &&
          track.duration > 0 &&
          !hasExplicitPreviewSignal(track),
      )
      .map((track) => track.duration),
  );
}

export function assessMediaCompleteness(
  track: InternalTrack,
  referenceDuration?: number,
): MediaCompletenessAssessment {
  if (isProviderPreviewUrl(track)) {
    return { complete: false, reason: "provider_preview_url" };
  }
  if (TITLE_MARKER_PATTERN.test(track.title)) {
    return { complete: false, reason: "title_marker" };
  }
  if (
    referenceDuration !== undefined &&
    referenceDuration >= 120 &&
    track.duration > 0 &&
    track.duration <= 90 &&
    track.duration / referenceDuration <= 0.55
  ) {
    return { complete: false, reason: "duration_outlier" };
  }
  return { complete: true };
}

export function filterCompleteMedia(
  tracks: readonly InternalTrack[],
): {
  readonly accepted: InternalTrack[];
  readonly rejected: RejectedMediaSummary[];
} {
  const referenceDuration = referenceOriginalDuration(tracks);
  const accepted: InternalTrack[] = [];
  const counts = new Map<string, number>();

  for (const track of tracks) {
    const assessment = assessMediaCompleteness(track, referenceDuration);
    if (assessment.complete) {
      accepted.push(track);
      continue;
    }
    const key = `${track.source}\u0000${assessment.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rejected: RejectedMediaSummary[] = [];
  for (const source of SOURCE_ORDER) {
    for (const reason of REASON_ORDER) {
      const count = counts.get(`${source}\u0000${reason}`) ?? 0;
      if (count > 0) rejected.push({ source, reason, count });
    }
  }
  return { accepted, rejected };
}
