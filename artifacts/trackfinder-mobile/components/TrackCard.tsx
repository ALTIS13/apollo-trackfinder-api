import { MaterialIcons } from '@/components/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { COLORS, SOURCE_COLORS, TYPE_COLORS, TrackSource, TrackType } from '@/constants/colors';
import { useLibrary } from '@/hooks/use-library';
import { PlayerTrack, usePlayer } from '@/hooks/use-player';

export interface Track {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnailUrl: string | null;
  source: TrackSource;
  type: TrackType;
  viewCount?: number;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

interface Props {
  track: Track;
  onFindVariants?: (track: Track) => void;
}

export function TrackCard({ track, onFindVariants }: Props) {
  const { play, currentTrack, isPlaying, isLoading } = usePlayer();
  const { download, isDownloading, downloadProgress, isSaved } = useLibrary();
  const [downloadError, setDownloadError] = useState(false);

  const isCurrentTrack = currentTrack?.id === track.id;
  const typeC = TYPE_COLORS[track.type];
  const srcC = SOURCE_COLORS[track.source];
  const saved = isSaved(track.id);
  const downloading = !!isDownloading[track.id];
  const progress = downloadProgress[track.id] ?? 0;

  const handlePlay = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const pt: PlayerTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      thumbnailUrl: track.thumbnailUrl,
      duration: track.duration,
      source: track.source,
      type: track.type,
    };
    await play(pt);
  };

  const handleDownload = async () => {
    if (saved || downloading) return;
    setDownloadError(false);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await download(track);
    } catch {
      setDownloadError(true);
    }
  };

  return (
    <View style={[styles.card, isCurrentTrack && styles.cardActive]}>
      <View style={styles.left}>
        <View style={styles.thumb}>
          {track.thumbnailUrl ? (
            <Image
              source={{ uri: track.thumbnailUrl }}
              style={styles.thumbImg}
              contentFit="cover"
              transition={200}
            />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <MaterialIcons name="music-note" size={20} color={COLORS.textMuted} />
            </View>
          )}
          {isCurrentTrack && (
            <View style={styles.thumbOverlay}>
              {isLoading ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={18} color={COLORS.white} />
              )}
            </View>
          )}
        </View>
      </View>

      <Pressable style={styles.center} onPress={handlePlay} testID={`play-${track.id}`}>
        <View style={styles.badges}>
          <View style={[styles.badge, { backgroundColor: typeC.bg }]}>
            <Text style={[styles.badgeText, { color: typeC.text }]}>{typeC.label}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: srcC.bg }]}>
            <Text style={[styles.badgeText, { color: srcC.text }]}>{srcC.label}</Text>
          </View>
        </View>
        <Text style={styles.title} numberOfLines={2}>{track.title}</Text>
        <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
        <View style={styles.meta}>
          <Text style={styles.metaText}>{formatDuration(track.duration)}</Text>
          {!!track.viewCount && (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.metaText}>{formatViews(track.viewCount)} views</Text>
            </>
          )}
        </View>
      </Pressable>

      <View style={styles.right}>
        <Pressable
          style={[styles.iconBtn, isCurrentTrack && styles.iconBtnActive]}
          onPress={handlePlay}
          testID={`play-btn-${track.id}`}
        >
          {isCurrentTrack && isLoading ? (
            <ActivityIndicator size="small" color={COLORS.accent} />
          ) : (
            <MaterialIcons
              name={isCurrentTrack && isPlaying ? 'pause' : 'play-arrow'}
              size={20}
              color={isCurrentTrack ? COLORS.accent : COLORS.textSub}
            />
          )}
        </Pressable>

        <Pressable
          style={styles.iconBtn}
          onPress={handleDownload}
          disabled={saved || downloading}
          testID={`download-${track.id}`}
        >
          {downloading ? (
            <View style={styles.progressRing}>
              <ActivityIndicator size="small" color={COLORS.accent} />
            </View>
          ) : (
            <MaterialIcons
              name={saved ? 'check-circle' : downloadError ? 'error' : 'file-download'}
              size={20}
              color={
                saved ? COLORS.accent
                : downloadError ? COLORS.danger
                : COLORS.textSub
              }
            />
          )}
        </Pressable>

        {onFindVariants && (
          <Pressable
            style={styles.iconBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onFindVariants(track);
            }}
          >
            <MaterialIcons name="search" size={20} color={COLORS.textSub} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  cardActive: {
    borderColor: COLORS.accent + '40',
    backgroundColor: COLORS.accentDim,
  },
  left: {},
  thumb: {
    width: 60,
    height: 60,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
  },
  thumbImg: {
    width: '100%',
    height: '100%',
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
  center: {
    flex: 1,
    gap: 3,
  },
  badges: {
    flexDirection: 'row',
    gap: 5,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
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
    gap: 4,
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  metaDot: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  right: {
    gap: 4,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: COLORS.accentDim,
  },
  progressRing: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
