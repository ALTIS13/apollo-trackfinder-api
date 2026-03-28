import { MaterialIcons } from '@/components/MaterialIcons';
import { SavedTrackCard } from '@/components/SavedTrackCard';
import { COLORS } from '@/constants/colors';
import { useLibrary } from '@/hooks/use-library';
import { usePlayer } from '@/hooks/use-player';
import { router } from 'expo-router';
import React, { useCallback } from 'react';
import { FlatList, ListRenderItemInfo, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PLAYER_HEIGHT = 62;
const TAB_BAR = Platform.OS === 'web' ? 84 : 50;
const ROW_HEIGHT = 71;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

function pluralTracks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} треков`;
  if (mod10 === 1) return `${n} трек`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} трека`;
  return `${n} треков`;
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const { tracks } = useLibrary();
  const { currentTrack } = usePlayer();

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const downloadedTracks = tracks.filter((t) => !!t.localUri);
  const onlineTracks = tracks.filter((t) => !t.localUri);
  const totalSize = downloadedTracks.reduce((sum, t) => sum + (t.fileSize ?? 0), 0);

  const handleSearchArtist = useCallback((artist: string) => {
    router.navigate({ pathname: '/', params: { artist } });
  }, []);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<(typeof tracks)[0]>) => (
      <SavedTrackCard track={item} onSearchArtist={handleSearchArtist} />
    ),
    [handleSearchArtist],
  );

  const keyExtractor = useCallback((item: (typeof tracks)[0]) => item.id, []);

  return (
    <View style={[styles.root, { backgroundColor: COLORS.bg }]}>
      <View style={[styles.header, { paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="headphones" size={22} color={COLORS.accent} />
          <Text style={styles.headerTitle}>Библиотека</Text>
        </View>
        {tracks.length > 0 && (
          <View style={styles.statsRow}>
            <Text style={styles.statChip}>{pluralTracks(tracks.length)}</Text>
            {downloadedTracks.length > 0 && (
              <Text style={styles.statChip}>
                {downloadedTracks.length} скачано · {formatBytes(totalSize)}
              </Text>
            )}
            {onlineTracks.length > 0 && (
              <Text style={styles.statChipOnline}>{onlineTracks.length} онлайн</Text>
            )}
          </View>
        )}
        <Text style={styles.hint}>
          Свайп влево — скачать / удалить · Удерживать — меню
        </Text>
      </View>

      {tracks.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="headphones" size={48} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>Библиотека пуста</Text>
          <Text style={styles.emptyText}>
            Нажмите значок загрузки на любом треке или импортируйте треки из Spotify / Яндекс Музыки
          </Text>
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          windowSize={7}
          maxToRenderPerBatch={20}
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  statChip: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    backgroundColor: COLORS.card,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    overflow: 'hidden',
  },
  statChipOnline: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    backgroundColor: COLORS.card,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    overflow: 'hidden',
  },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 280,
  },
});
