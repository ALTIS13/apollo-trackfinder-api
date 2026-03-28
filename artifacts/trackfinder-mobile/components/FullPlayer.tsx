import { MaterialIcons } from '@/components/MaterialIcons';
import { Image } from 'expo-image';
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
const ARTWORK_SIZE = SCREEN_W - 80;

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
    pause,
    resume,
    stop,
    seek,
    closeFullPlayer,
  } = usePlayer();

  const seekBarRef = useRef<View>(null);
  const touchStartY = useRef(0);
  const lyricsScrollRef = useRef<ScrollView>(null);

  const [activeTab, setActiveTab] = useState<'artwork' | 'lyrics'>('artwork');
  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsTrackId, setLyricsTrackId] = useState<string | null>(null);

  const fetchLyrics = useCallback(async (track: typeof currentTrack) => {
    if (!track) return;
    if (lyricsTrackId === track.id && lyrics !== null) return;
    setLyricsLoading(true);
    try {
      const params = new URLSearchParams({
        artist: track.artist,
        title: track.title,
      });
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
    if (activeTab === 'lyrics' && currentTrack) {
      fetchLyrics(currentTrack);
    }
  }, [activeTab, currentTrack?.id]);

  useEffect(() => {
    if (currentTrack?.id !== lyricsTrackId) {
      setLyrics(null);
      setLyricsTrackId(null);
    }
  }, [currentTrack?.id]);

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
      lyricsScrollRef.current.scrollTo({ y: activeLyricIndex * 36, animated: true });
    }
  }, [activeLyricIndex]);

  const handlePlayPause = async () => {
    if (isPlaying) await pause();
    else await resume();
  };

  const handleStop = async () => {
    closeFullPlayer();
    await stop();
  };

  const handleSeek = (e: any) => {
    seekBarRef.current?.measure((_x, _y, width, _h, _pageX, _pageY) => {
      const touch = e.nativeEvent.pageX - _pageX;
      const ratio = Math.max(0, Math.min(1, touch / width));
      seek(ratio * duration);
    });
  };

  const progress = duration > 0 ? position / duration : 0;

  const typeInfo = currentTrack?.type
    ? TYPE_COLORS[currentTrack.type as keyof typeof TYPE_COLORS]
    : null;
  const srcInfo = currentTrack?.source
    ? SOURCE_COLORS[currentTrack.source as keyof typeof SOURCE_COLORS]
    : null;

  if (!showFullPlayer || !currentTrack) return null;

  const lyricsText = syncedLines
    ? syncedLines.map((l) => l.text).filter(Boolean)
    : (lyrics?.plainLyrics?.split('\n') ?? []);

  return (
    <Modal
      visible={showFullPlayer}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={closeFullPlayer}
    >
      <View
        style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
        onTouchStart={(e) => { touchStartY.current = e.nativeEvent.pageY; }}
        onTouchEnd={(e) => {
          const delta = e.nativeEvent.pageY - touchStartY.current;
          if (delta > 80 && activeTab === 'artwork') closeFullPlayer();
        }}
      >
        <View style={styles.handle} />

        <View style={styles.header}>
          <Pressable style={styles.closeBtn} onPress={closeFullPlayer} hitSlop={12}>
            <MaterialIcons name="keyboard-arrow-down" size={28} color={COLORS.textSub} />
          </Pressable>
          <View style={styles.tabs}>
            <Pressable
              style={[styles.tab, activeTab === 'artwork' && styles.tabActive]}
              onPress={() => setActiveTab('artwork')}
            >
              <Text style={[styles.tabText, activeTab === 'artwork' && styles.tabTextActive]}>Обложка</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, activeTab === 'lyrics' && styles.tabActive]}
              onPress={() => { setActiveTab('lyrics'); fetchLyrics(currentTrack); }}
            >
              <Text style={[styles.tabText, activeTab === 'lyrics' && styles.tabTextActive]}>Текст</Text>
            </Pressable>
          </View>
          <View style={{ width: 44 }} />
        </View>

        {activeTab === 'artwork' ? (
          <>
            <View style={styles.artworkWrap}>
              {currentTrack.thumbnailUrl ? (
                <Image
                  source={{ uri: currentTrack.thumbnailUrl }}
                  style={styles.artwork}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.artwork, styles.artworkPlaceholder]}>
                  <MaterialIcons name="music-note" size={80} color={COLORS.textMuted} />
                </View>
              )}
            </View>

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

            <View style={styles.info}>
              <Text style={styles.title} numberOfLines={2}>{currentTrack.title}</Text>
              <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>
            </View>
          </>
        ) : (
          <View style={styles.lyricsContainer}>
            {lyricsLoading ? (
              <View style={styles.lyricsCenter}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.lyricsHint}>Ищем текст песни...</Text>
              </View>
            ) : !lyrics?.plainLyrics && !lyrics?.syncedLyrics ? (
              <View style={styles.lyricsCenter}>
                <MaterialIcons name="music-note" size={40} color={COLORS.textMuted} />
                <Text style={styles.lyricsNotFound}>Текст не найден</Text>
                <Text style={styles.lyricsHint}>Для этого трека текст в базе недоступен</Text>
              </View>
            ) : (
              <ScrollView
                ref={lyricsScrollRef}
                style={styles.lyricsScroll}
                contentContainerStyle={styles.lyricsScrollContent}
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.lyricsMeta}>{currentTrack.artist} — {currentTrack.title}</Text>
                {syncedLines ? (
                  syncedLines.map((line, i) => (
                    <Text
                      key={i}
                      style={[
                        styles.lyricLine,
                        i === activeLyricIndex && styles.lyricLineActive,
                        !line.text && styles.lyricLineEmpty,
                      ]}
                    >
                      {line.text || '·'}
                    </Text>
                  ))
                ) : (
                  lyricsText.map((line, i) => (
                    <Text
                      key={i}
                      style={[styles.lyricLine, !line && styles.lyricLineEmpty]}
                    >
                      {line || '·'}
                    </Text>
                  ))
                )}
              </ScrollView>
            )}
          </View>
        )}

        <View style={styles.seekSection}>
          <View
            ref={seekBarRef}
            style={styles.seekBarTrack}
            onTouchEnd={handleSeek}
          >
            <View style={[styles.seekBarFill, { width: `${progress * 100}%` }]} />
            <View style={[styles.seekThumb, { left: `${progress * 100}%` }]} />
          </View>
          <View style={styles.times}>
            <Text style={styles.timeText}>{fmt(position)}</Text>
            <Text style={styles.timeText}>{fmt(duration)}</Text>
          </View>
        </View>

        <View style={styles.controls}>
          <Pressable style={styles.controlBtn} onPress={handleStop}>
            <MaterialIcons name="stop" size={28} color={COLORS.textSub} />
          </Pressable>

          <Pressable style={styles.playBtn} onPress={handlePlayPause}>
            {isLoading ? (
              <ActivityIndicator size="large" color={COLORS.bg} />
            ) : (
              <MaterialIcons
                name={isPlaying ? 'pause' : 'play-arrow'}
                size={40}
                color={COLORS.bg}
              />
            )}
          </Pressable>

          <Pressable style={styles.controlBtn} onPress={closeFullPlayer}>
            <MaterialIcons name="close" size={28} color={COLORS.textSub} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 24,
  },
  closeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: COLORS.bg,
  },
  tabText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textMuted,
  },
  tabTextActive: {
    color: COLORS.text,
    fontFamily: 'Inter_600SemiBold',
  },
  artworkWrap: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 12,
    marginBottom: 24,
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
  badges: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  info: {
    alignItems: 'center',
    gap: 4,
    marginBottom: 20,
    paddingHorizontal: 8,
    width: '100%',
    flex: 1,
    justifyContent: 'center',
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
  lyricsContainer: {
    flex: 1,
    width: '100%',
    marginBottom: 4,
  },
  lyricsCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  lyricsNotFound: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
  lyricsHint: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  lyricsScroll: {
    flex: 1,
  },
  lyricsScrollContent: {
    paddingBottom: 16,
  },
  lyricsMeta: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
    marginBottom: 16,
  },
  lyricLine: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    textAlign: 'center',
    lineHeight: 36,
    paddingHorizontal: 4,
  },
  lyricLineActive: {
    color: COLORS.text,
    fontFamily: 'Inter_700Bold',
    fontSize: 18,
  },
  lyricLineEmpty: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  seekSection: {
    width: '100%',
    marginBottom: 24,
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
    justifyContent: 'center',
    gap: 32,
  },
  controlBtn: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
