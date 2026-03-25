export const COLORS = {
  bg: '#0a0a0a',
  surface: '#141414',
  card: '#1c1c1c',
  border: '#272727',
  borderLight: '#333333',

  text: '#ffffff',
  textSub: '#8a8a8a',
  textMuted: '#4a4a4a',

  accent: '#1DB954',
  accentDim: 'rgba(29,185,84,0.15)',

  original: '#22c55e',
  originalBg: 'rgba(34,197,94,0.15)',
  remix: '#a855f7',
  remixBg: 'rgba(168,85,247,0.15)',
  live: '#f97316',
  liveBg: 'rgba(249,115,22,0.15)',
  cover: '#3b82f6',
  coverBg: 'rgba(59,130,246,0.15)',

  youtube: '#ff0000',
  youtubeBg: 'rgba(255,0,0,0.12)',
  soundcloud: '#ff5500',
  soundcloudBg: 'rgba(255,85,0,0.12)',

  spotifyGreen: '#1DB954',
  spotifyBg: 'rgba(29,185,84,0.12)',
  yandexYellow: '#FFCC00',
  yandexBg: 'rgba(255,204,0,0.12)',

  danger: '#ef4444',
  dangerBg: 'rgba(239,68,68,0.12)',

  white: '#ffffff',
  black: '#000000',
};

export type TrackType = 'original' | 'remix' | 'live' | 'cover';
export type TrackSource = 'youtube' | 'soundcloud';

export const TYPE_COLORS: Record<TrackType, { text: string; bg: string; label: string }> = {
  original:  { text: COLORS.original,   bg: COLORS.originalBg,   label: 'Original' },
  remix:     { text: COLORS.remix,      bg: COLORS.remixBg,      label: 'Remix' },
  live:      { text: COLORS.live,       bg: COLORS.liveBg,       label: 'Live' },
  cover:     { text: COLORS.cover,      bg: COLORS.coverBg,      label: 'Cover' },
};

export const SOURCE_COLORS: Record<TrackSource, { text: string; bg: string; label: string }> = {
  youtube:    { text: COLORS.youtube,    bg: COLORS.youtubeBg,    label: 'YouTube' },
  soundcloud: { text: COLORS.soundcloud, bg: COLORS.soundcloudBg, label: 'SoundCloud' },
};
