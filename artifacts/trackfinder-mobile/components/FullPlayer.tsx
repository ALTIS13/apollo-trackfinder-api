import { MaterialIcons } from '@/components/MaterialIcons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS, SOURCE_COLORS, TYPE_COLORS } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';
import { apiFetch } from '@/hooks/use-session';

const { width: SCREEN_W } = Dimensions.get('window');
const ARTWORK_SIZE = Math.min(SCREEN_W - 80, 280);

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

interface LyricsData {
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

function parseSyncedLyrics(lrc: string): { time: number; text: string }[] {
  const lines: { time: number; text: string }[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
    if (match) {
      const mins = Number(match[1]);
      const secs = Number(match[2]);
      const text = match[3]?.trim() ?? '';
      lines.push({ time: mins * 60 + secs, text });
    }
  }
  return lines;
}

export function FullPlayer() {
  const insets = useSafeAreaInsets();
  const {
    currentTrack,
    isPlaying,
    isLoading,
    position,
    duration,
    showFullPlayer,
    shuffle,
    repeat,
    pause,
    resume,
    seek,
    playNext,
    playPrev,
    toggleShuffle,
    cycleRepeat,
    closeFullPlayer,
  } = usePlayer();

  const seekBarRef = useRef<View>(null);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const lyricsScrollRef = useRef<ScrollView>(null);

  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsTrackId, setLyricsTrackId] = useState<string | null>(null);

  const fetchLyrics = useCallback(async (track: typeof currentTrack) => {
    if (!track) return;
    if (lyricsTrackId === track.id && lyrics !== null) return;
    setLyricsLoading(true);
    try {
      const params = new URLSearchParams({ artist: track.artist, title: track.title });
      if (track.duration) params.set('duration', String(Math.round(track.duration)));
      const data = await apiFetch<LyricsData>(`/tracks/lyrics?${params}`);
      setLyrics(data);
      setLyricsTrackId(track.id);
    } catch {
      setLyrics({ plainLyrics: null, syncedLyrics: null });
    } finally {
      setLyricsLoading(false);
    }
  }, [lyricsTrackId, lyrics]);

  useEffect(() => {
    if (currentTrack?.id !== lyricsTrackId) {
      setLyrics(null);
      setLyricsTrackId(null);
    }
  }, [currentTrack?.id]);

  // Auto-fetch lyrics when track changes
  useEffect(() => {
    if (currentTrack && showFullPlayer) fetchLyrics(currentTrack);
  }, [currentTrack?.id, showFullPlayer]);

  const syncedLines = lyrics?.syncedLyrics ? parseSyncedLyrics(lyrics.syncedLyrics) : null;
  const activeLyricIndex = syncedLines
    ? (() => {
        let idx = -1;
        for (let i = 0; i < syncedLines.length; i++) {
          if (syncedLines[i].time <= position) idx = i;
        }
        return idx;
      })()
    : -1;

  useEffect(() => {
    if (syncedLines && activeLyricIndex >= 0 && lyricsScrollRef.current) {
      lyricsScrollRef.current.scrollTo({ y: Math.max(0, activeLyricIndex * 36 - 72), animated: true });
    }
  }, [activeLyricIndex]);

  const handlePlayPause = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) await pause();
    else await resume();
  };

  const handleNext = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await playNext();
  };

  const handlePrev = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await playPrev();
  };

  const handleShuffle = () => {
    Haptics.selectionAsync();
    toggleShuffle();
  };

  const handleRepeat = () => {
    Haptics.selectionAsync();
    cycleRepeat();
  };

  const handleSeek = (e: any) => {
    seekBarRef.current?.measure((_x, _y, width, _h, _pageX, _pageY) => {
      const touch = e.nativeEvent.pageX - _pageX;
      const ratio = Math.max(0, Math.min(1, touch / width));
      seek(ratio * duration);
    });
  };

  const progress = duration > 0 ? position / duration : 0;

  const typeInfo = currentTrack?.type ? TYPE_COLORS[currentTrack.type as keyof typeof TYPE_COLORS] : null;
  const srcInfo = currentTrack?.source ? SOURCE_COLORS[currentTrack.source as keyof typeof SOURCE_COLORS] : null;

  const repeatIcon = repeat === 'one' ? 'repeat-one' : 'repeat';
  const repeatActive = repeat !== 'none';

  if (!showFullPlayer || !currentTrack) return null;

  const lyricsLines = syncedLines
    ? syncedLines
    : (lyrics?.plainLyrics?.split('\n').map((text) => ({ time: -1, text })) ?? []);

  const hasLyrics = (syncedLines && syncedLines.length > 0) || !!lyrics?.plainLyrics;

  return (
    <Modal
      visible={showFullPlayer}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={closeFullPlayer}
    >
      <View
        style={[styles.root, { paddingTop: insets.top + 8 }]}
        onTouchStart={(e) => {
          touchStartY.current = e.nativeEvent.pageY;
          touchStartX.current = e.nativeEvent.pageX;
        }}
        onTouchEnd={(e) => {
          const dy = e.nativeEvent.pageY - touchStartY.current;
          const dx = Math.abs(e.nativeEvent.pageX - touchStartX.current);
          // Swipe down (vertical > horizontal) to close
          if (dy > 80 && dx < 60) closeFullPlayer();
        }}
      >
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <Pressable style={styles.closeBtn} onPress={closeFullPlayer} hitSlop={12}>
            <MaterialIcons name="keyboard-arrow-down" size={28} color={COLORS.textSub} />
          </Pressable>
          <View style={styles.badges}>
            {srcInfo && (
              <View style={[styles.badge, { backgroundColor: srcInfo.bg }]}>
                <Text style={[styles.badgeText, { color: srcInfo.text }]}>{srcInfo.label}</Text>
              </View>
            )}
            {typeInfo && (
              <View style={[styles.badge, { backgroundColor: typeInfo.bg }]}>
                <Text style={[styles.badgeText, { color: typeInfo.text }]}>{typeInfo.label}</Text>
              </View>
            )}
          </View>
          <View style={{ width: 44 }} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {/* Artwork */}
          <View style={styles.artworkWrap}>
            {currentTrack.thumbnailUrl ? (
              <Image source={{ uri: currentTrack.thumbnailUrl }} style={styles.artwork} contentFit="cover" />
            ) : (
              <View style={[styles.artwork, styles.artworkPlaceholder]}>
                <MaterialIcons name="music-note" size={64} color={COLORS.textMuted} />
              </View>
            )}
          </View>

          {/* Title & Artist */}
          <View style={styles.info}>
            <Text style={styles.title} numberOfLines={2}>{currentTrack.title}</Text>
            <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>
          </View>

          {/* Seek bar */}
          <View style={styles.seekSection}>
            <View ref={seekBarRef} style={styles.seekBarTrack} onTouchEnd={handleSeek}>
              <View style={[styles.seekBarFill, { width: `${progress * 100}%` }]} />
              <View style={[styles.seekThumb, { left: `${progress * 100}%` }]} />
            </View>
            <View style={styles.times}>
              <Text style={styles.timeText}>{fmt(position)}</Text>
              <Text style={styles.timeText}>{fmt(duration)}</Text>
            </View>
          </View>

          {/* Main controls: shuffle | prev | play/pause | next | repeat */}
          <View style={styles.controls}>
            <Pressable style={styles.sideBtn} onPress={handleShuffle} hitSlop={8}>
              <MaterialIcons
                name="shuffle"
                size={22}
                color={shuffle ? COLORS.accent : COLORS.textMuted}
              />
              {shuffle && <View style={styles.activeDot} />}
            </Pressable>

            <Pressable style={styles.skipBtn} onPress={handlePrev} hitSlop={8}>
              <MaterialIcons name="skip-previous" size={34} color={COLORS.text} />
            </Pressable>

            <Pressable style={styles.playBtn} onPress={handlePlayPause}>
              {isLoading ? (
                <ActivityIndicator size="large" color={COLORS.bg} />
              ) : (
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={42} color={COLORS.bg} />
              )}
            </Pressable>

            <Pressable style={styles.skipBtn} onPress={handleNext} hitSlop={8}>
              <MaterialIcons name="skip-next" size={34} color={COLORS.text} />
            </Pressable>

            <Pressable style={styles.sideBtn} onPress={handleRepeat} hitSlop={8}>
              <MaterialIcons
                name={repeatIcon}
                size={22}
                color={repeatActive ? COLORS.accent : COLORS.textMuted}
              />
              {repeatActive && <View style={styles.activeDot} />}
            </Pressable>
          </View>

          {/* Lyrics section */}
          <View style={styles.lyricsSection}>
            <View style={styles.lyricsDivider}>
              <View style={styles.dividerLine} />
              <Text style={styles.lyricsLabel}>Текст песни</Text>
              <View style={styles.dividerLine} />
            </View>

            {lyricsLoading ? (
              <View style={styles.lyricsCenter}>
                <ActivityIndicator color={COLORS.accent} size="small" />
                <Text style={styles.lyricsHint}>Ищем текст...</Text>
              </View>
            ) : !hasLyrics && lyrics !== null ? (
              <View style={styles.lyricsCenter}>
                <Text style={styles.lyricsNotFound}>Текст не найден</Text>
              </View>
            ) : hasLyrics ? (
              <ScrollView
                ref={lyricsScrollRef}
                style={styles.lyricsScroll}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                {lyricsLines.map((line, i) => (
                  <Text
                    key={i}
                    style={[
                      styles.lyricLine,
                      syncedLines && i === activeLyricIndex && styles.lyricLineActive,
                      !line.text && styles.lyricLineEmpty,
                    ]}
                  >
                    {line.text || '·'}
                  </Text>
                ))}
              </ScrollView>
            ) : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
    alignSelf: 'center',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  closeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badges: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  artworkWrap: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 12,
    marginBottom: 20,
    marginTop: 4,
  },
  artwork: {
    width: ARTWORK_SIZE,
    height: ARTWORK_SIZE,
    borderRadius: 16,
  },
  artworkPlaceholder: {
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    alignItems: 'center',
    gap: 4,
    marginBottom: 20,
    width: '100%',
    paddingHorizontal: 8,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
    textAlign: 'center',
    lineHeight: 26,
  },
  artist: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    textAlign: 'center',
  },
  seekSection: {
    width: '100%',
    marginBottom: 20,
  },
  seekBarTrack: {
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    marginBottom: 8,
    position: 'relative',
  },
  seekBarFill: {
    height: '100%',
    backgroundColor: COLORS.accent,
    borderRadius: 2,
  },
  seekThumb: {
    position: 'absolute',
    top: -6,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    marginLeft: -8,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  timeText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
    marginBottom: 28,
  },
  sideBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    bottom: 6,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.accent,
  },
  skipBtn: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  lyricsSection: {
    width: '100%',
    minHeight: 120,
  },
  lyricsDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  lyricsLabel: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  lyricsCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  lyricsNotFound: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  lyricsHint: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  lyricsScroll: {
    maxHeight: 320,
  },
  lyricLine: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    textAlign: 'center',
    lineHeight: 36,
    paddingHorizontal: 4,
  },
  lyricLineActive: {
    color: COLORS.text,
    fontFamily: 'Inter_700Bold',
    fontSize: 17,
  },
  lyricLineEmpty: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
});
