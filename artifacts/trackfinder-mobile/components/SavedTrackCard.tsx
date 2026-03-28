import { MaterialIcons } from '@/components/MaterialIcons';
import { COLORS } from '@/constants/colors';
import { SavedTrack, useLibrary } from '@/hooks/use-library';
import { PlayerTrack, usePlayer } from '@/hooks/use-player';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / 1024).toFixed(0)} КБ`;
}

function getQualityLabel(source?: string): string | null {
  if (source === 'youtube') return '~160 kbps';
  if (source === 'soundcloud') return '~128 kbps';
  return null;
}

interface Props {
  track: SavedTrack;
  onSearchArtist?: (artist: string) => void;
}

export const SavedTrackCard = React.memo(function SavedTrackCard({ track, onSearchArtist }: Props) {
  const { play, currentTrack, isPlaying, isLoading } = usePlayer();
  const { remove, download, isDownloading, downloadProgress } = useLibrary();
  const swipeRef = useRef<Swipeable>(null);

  const isCurrentTrack = currentTrack?.id === track.id;
  const downloaded = !!track.localUri;
  const downloading = !!isDownloading[track.id];
  const progress = downloadProgress[track.id] ?? 0;
  const quality = getQualityLabel(track.source);

  const handlePlay = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const pt: PlayerTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      thumbnailUrl: track.thumbnailUrl,
      duration: track.duration,
      localUri: track.localUri || undefined,
    };
    await play(pt);
  };

  const handleDownload = async () => {
    swipeRef.current?.close();
    if (downloaded || downloading) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await download(track);
    } catch {
      Alert.alert('Ошибка', 'Не удалось скачать трек. Проверьте соединение.');
    }
  };

  const handleDelete = () => {
    swipeRef.current?.close();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Удалить трек',
      `Удалить «${track.title}» из библиотеки?`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => remove(track.id),
        },
      ],
    );
  };

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const options: Array<{ label: string; action: () => void; destructive?: boolean }> = [];

    if (!downloaded && !downloading) {
      options.push({ label: 'Скачать на устройство', action: handleDownload });
    }
    if (onSearchArtist) {
      options.push({ label: `Поиск по артисту: ${track.artist}`, action: () => onSearchArtist(track.artist) });
    }
    options.push({ label: 'Удалить из библиотеки', action: handleDelete, destructive: true });

    Alert.alert(track.title, track.artist, [
      ...options.map((o) => ({
        text: o.label,
        style: (o.destructive ? 'destructive' : 'default') as 'destructive' | 'default',
        onPress: o.action,
      })),
      { text: 'Отмена', style: 'cancel' },
    ]);
  };

  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>,
  ) => {
    const translateX = dragX.interpolate({
      inputRange: downloaded ? [-80, 0] : [-160, 0],
      outputRange: downloaded ? [0, 80] : [0, 160],
      extrapolate: 'clamp',
    });

    return (
      <Animated.View style={[styles.swipeActions, { transform: [{ translateX }] }]}>
        {!downloaded && !downloading && (
          <Pressable style={[styles.swipeBtn, styles.swipeBtnDownload]} onPress={handleDownload}>
            <MaterialIcons name="file-download" size={22} color={COLORS.white} />
            <Text style={styles.swipeBtnLabel}>Скачать</Text>
          </Pressable>
        )}
        <Pressable style={[styles.swipeBtn, styles.swipeBtnDelete]} onPress={handleDelete}>
          <MaterialIcons name="delete" size={22} color={COLORS.white} />
          <Text style={styles.swipeBtnLabel}>Удалить</Text>
        </Pressable>
      </Animated.View>
    );
  };

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      friction={2}
    >
      <Pressable
        style={[styles.card, isCurrentTrack && styles.cardActive]}
        onPress={handlePlay}
        onLongPress={handleLongPress}
        delayLongPress={400}
      >
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
              {isLoading ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={18} color={COLORS.white} />
              )}
            </View>
          )}
        </View>

        <View style={styles.info}>
          <Text style={[styles.title, isCurrentTrack && styles.titleActive]} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaText}>{formatDuration(track.duration)}</Text>
            {!!track.fileSize && (
              <>
                <Text style={styles.dot}>·</Text>
                <Text style={styles.metaText}>{formatFileSize(track.fileSize)}</Text>
              </>
            )}
            {quality && (
              <>
                <Text style={styles.dot}>·</Text>
                <Text style={styles.metaText}>{quality}</Text>
              </>
            )}
          </View>
        </View>

        <View style={styles.statusCol}>
          {downloading ? (
            <View style={styles.downloadingWrap}>
              <ActivityIndicator size="small" color={COLORS.accent} />
              {progress > 0 && (
                <Text style={styles.progressText}>{Math.round(progress * 100)}%</Text>
              )}
            </View>
          ) : downloaded ? (
            <View style={styles.downloadedBadge}>
              <MaterialIcons name="check-circle" size={18} color={COLORS.accent} />
            </View>
          ) : (
            <View style={styles.onlineBadge}>
              <MaterialIcons name="cloud-download" size={16} color={COLORS.textMuted} />
              <Text style={styles.onlineText}>Онлайн</Text>
            </View>
          )}
        </View>
      </Pressable>
    </Swipeable>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  cardActive: {
    backgroundColor: COLORS.accentDim,
  },
  thumb: {
    width: 50,
    height: 50,
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
    gap: 2,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  titleActive: {
    color: COLORS.accent,
  },
  artist: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 3,
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
  statusCol: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 52,
  },
  downloadingWrap: {
    alignItems: 'center',
    gap: 2,
  },
  progressText: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    color: COLORS.accent,
  },
  downloadedBadge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  onlineBadge: {
    alignItems: 'center',
    gap: 2,
  },
  onlineText: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    letterSpacing: 0.2,
  },
  swipeActions: {
    flexDirection: 'row',
  },
  swipeBtn: {
    width: 80,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    ...(Platform.OS === 'web' ? {} : {}),
  },
  swipeBtnDownload: {
    backgroundColor: '#2563eb',
  },
  swipeBtnDelete: {
    backgroundColor: COLORS.danger,
  },
  swipeBtnLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.white,
  },
});
