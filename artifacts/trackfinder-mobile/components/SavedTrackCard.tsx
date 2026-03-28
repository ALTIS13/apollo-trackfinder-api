import { MaterialIcons } from '@/components/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS } from '@/constants/colors';
import { SavedTrack, useLibrary } from '@/hooks/use-library';
import { PlayerTrack, usePlayer } from '@/hooks/use-player';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface Props {
  track: SavedTrack;
}

export function SavedTrackCard({ track }: Props) {
  const { play, currentTrack, isPlaying } = usePlayer();
  const { remove } = useLibrary();

  const isCurrentTrack = currentTrack?.id === track.id;

  const handlePlay = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const pt: PlayerTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      thumbnailUrl: track.thumbnailUrl,
      duration: track.duration,
      localUri: track.localUri,
    };
    await play(pt);
  };

  const handleDelete = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('Remove track', `Remove "${track.title}" from library?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => remove(track.id),
      },
    ]);
  };

  return (
    <Pressable style={[styles.card, isCurrentTrack && styles.cardActive]} onPress={handlePlay}>
      <View style={styles.thumb}>
        {track.thumbnailUrl ? (
          <Image
            source={{ uri: track.thumbnailUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        ) : (
          <View style={styles.thumbPlaceholder}>
            <MaterialIcons name="music-note" size={20} color={COLORS.textMuted} />
          </View>
        )}
        {isCurrentTrack && (
          <View style={styles.thumbOverlay}>
            <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={18} color={COLORS.white} />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>{track.title}</Text>
        <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
        <View style={styles.meta}>
          <MaterialIcons name="file-download" size={12} color={COLORS.accent} />
          <Text style={styles.metaText}>{formatDuration(track.duration)}</Text>
          {!!track.fileSize && (
            <>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.metaText}>{formatFileSize(track.fileSize)}</Text>
            </>
          )}
        </View>
      </View>

      <Pressable style={styles.deleteBtn} onPress={handleDelete} hitSlop={8}>
        <MaterialIcons name="delete" size={18} color={COLORS.textMuted} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cardActive: {
    backgroundColor: COLORS.accentDim,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.card,
    flexShrink: 0,
  },
  thumbPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
    lineHeight: 19,
  },
  artist: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  dot: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  deleteBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
