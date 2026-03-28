import { MaterialIcons } from '@/components/MaterialIcons';
import { Image } from 'expo-image';
import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS, SOURCE_COLORS, TYPE_COLORS } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';

const { width: SCREEN_W } = Dimensions.get('window');
const ARTWORK_SIZE = SCREEN_W - 80;

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
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
          if (delta > 80) closeFullPlayer();
        }}
      >
        <View style={styles.handle} />

        <View style={styles.header}>
          <Pressable style={styles.closeBtn} onPress={closeFullPlayer} hitSlop={12}>
            <MaterialIcons name="keyboard-arrow-down" size={28} color={COLORS.textSub} />
          </Pressable>
          <Text style={styles.headerTitle}>Now Playing</Text>
          <View style={{ width: 44 }} />
        </View>

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
    marginBottom: 32,
  },
  closeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  artworkWrap: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 12,
    marginBottom: 32,
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
    marginBottom: 28,
    paddingHorizontal: 8,
    width: '100%',
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
    marginBottom: 32,
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
