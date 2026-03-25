import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import { COLORS } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';

export function MiniPlayer() {
  const { currentTrack, isPlaying, isLoading, position, duration, pause, resume, stop, seek } =
    usePlayer();

  if (!currentTrack) return null;

  const progress = duration > 0 ? position / duration : 0;
  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  const handlePlayPause = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) await pause();
    else await resume();
  };

  const handleStop = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await stop();
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      exiting={FadeOutDown.duration(200)}
      style={styles.container}
    >
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>

      <View style={styles.content}>
        <View style={styles.thumb}>
          {currentTrack.thumbnailUrl ? (
            <Image
              source={{ uri: currentTrack.thumbnailUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
            />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Feather name="music" size={16} color={COLORS.textMuted} />
            </View>
          )}
        </View>

        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>{currentTrack.title}</Text>
          <Text style={styles.artist} numberOfLines={1}>{currentTrack.artist}</Text>
        </View>

        <Text style={styles.time}>{fmtTime(position)}</Text>

        <Pressable style={styles.btn} onPress={handlePlayPause}>
          {isLoading ? (
            <ActivityIndicator size="small" color={COLORS.accent} />
          ) : (
            <Feather name={isPlaying ? 'pause' : 'play'} size={22} color={COLORS.accent} />
          )}
        </Pressable>

        <Pressable style={styles.btn} onPress={handleStop}>
          <Feather name="x" size={20} color={COLORS.textSub} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  progressBar: {
    height: 2,
    backgroundColor: COLORS.border,
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.accent,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: COLORS.card,
  },
  thumbPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  artist: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  time: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    minWidth: 36,
    textAlign: 'right',
  },
  btn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
