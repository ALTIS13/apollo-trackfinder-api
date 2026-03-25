export type TrackType = "original" | "remix" | "live" | "cover";

const REMIX_PATTERNS = /\b(remix|rmx|re-?mix|bootleg|flip|edit|rework|revamp|version|vip|extended|club mix|radio edit|instrumental)\b/i;
const LIVE_PATTERNS = /\b(live|concert|tour|performance|acoustic|unplugged|session|in studio|at .+|@)\b/i;
const COVER_PATTERNS = /\b(cover|tribute|cover version|originally by|sung by)\b/i;

export function classify(title: string): TrackType {
  const t = title.toLowerCase();

  if (REMIX_PATTERNS.test(t)) return "remix";
  if (LIVE_PATTERNS.test(t)) return "live";
  if (COVER_PATTERNS.test(t)) return "cover";

  return "original";
}
