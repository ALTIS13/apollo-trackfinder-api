import { MaterialIcons } from '@/components/MaterialIcons';
import { SavedTrackCard } from '@/components/SavedTrackCard';
import { COLORS } from '@/constants/colors';
import { SavedTrack, useLibrary } from '@/hooks/use-library';
import { usePlayer } from '@/hooks/use-player';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  ListRenderItemInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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

function pluralSelected(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return `${n} выбрано`;
  if (mod10 === 1) return `${n} выбран`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} выбрано`;
  return `${n} выбрано`;
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const { tracks, download, bulkRemove, isDownloading } = useLibrary();
  const { currentTrack } = usePlayer();

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const downloadedTracks = useMemo(() => tracks.filter((t) => !!t.localUri), [tracks]);
  const onlineTracks = useMemo(() => tracks.filter((t) => !t.localUri), [tracks]);
  const totalSize = useMemo(
    () => downloadedTracks.reduce((sum, t) => sum + (t.fileSize ?? 0), 0),
    [downloadedTracks],
  );

  const enterSelectionMode = useCallback(() => {
    setSelectionMode(true);
    setSelectedIds(new Set());
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(tracks.map((t) => t.id)));
    Haptics.selectionAsync();
  }, [tracks]);

  const handleSearchArtist = useCallback((artist: string) => {
    router.navigate({ pathname: '/', params: { artist } });
  }, []);

  const selectedOnlineCount = useMemo(() => {
    return [...selectedIds].filter((id) => {
      const t = tracks.find((t) => t.id === id);
      return t && !t.localUri;
    }).length;
  }, [selectedIds, tracks]);

  const handleBulkDownload = useCallback(async () => {
    const toDownload = tracks.filter((t) => selectedIds.has(t.id) && !t.localUri && !isDownloading[t.id]);
    if (toDownload.length === 0) return;
    setBulkDownloading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    exitSelectionMode();
    let failed = 0;
    for (const track of toDownload) {
      try { await download(track); } catch { failed++; }
    }
    setBulkDownloading(false);
    if (failed > 0) {
      Alert.alert('Ошибка', `Не удалось скачать ${failed} ${failed === 1 ? 'трек' : 'трека'}. Проверьте соединение.`);
    }
  }, [tracks, selectedIds, isDownloading, download, exitSelectionMode]);

  const handleBulkDelete = useCallback(() => {
    const count = selectedIds.size;
    if (count === 0) return;
    Alert.alert(
      'Удалить треки',
      `Удалить ${pluralSelected(count)} из библиотеки?`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            await bulkRemove([...selectedIds]);
            exitSelectionMode();
          },
        },
      ],
    );
  }, [selectedIds, bulkRemove, exitSelectionMode]);

  const handleDownloadAllOnline = useCallback(async () => {
    const toDownload = onlineTracks.filter((t) => !isDownloading[t.id]);
    if (toDownload.length === 0) return;
    Alert.alert(
      'Скачать всё',
      `Скачать ${pluralTracks(toDownload.length)} на устройство?`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Скачать',
          onPress: async () => {
            setBulkDownloading(true);
            let failed = 0;
            for (const track of toDownload) {
              try { await download(track); } catch { failed++; }
            }
            setBulkDownloading(false);
            if (failed > 0) {
              Alert.alert('Ошибка', `Не удалось скачать ${failed} трека.`);
            }
          },
        },
      ],
    );
  }, [onlineTracks, isDownloading, download]);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SavedTrack>) => (
      <SavedTrackCard
        track={item}
        onSearchArtist={handleSearchArtist}
        selectionMode={selectionMode}
        isSelected={selectedIds.has(item.id)}
        onToggleSelect={() => toggleSelect(item.id)}
        onEnterSelection={enterSelectionMode}
      />
    ),
    [handleSearchArtist, selectionMode, selectedIds, toggleSelect, enterSelectionMode],
  );

  const keyExtractor = useCallback((item: SavedTrack) => item.id, []);

  const allSelected = tracks.length > 0 && selectedIds.size === tracks.length;

  return (
    <View style={[styles.root, { backgroundColor: COLORS.bg }]}>
      <View style={[styles.header, { paddingTop: topPad }]}>
        {selectionMode ? (
          <>
            <View style={styles.headerRow}>
              <Pressable style={styles.cancelBtn} onPress={exitSelectionMode} hitSlop={10}>
                <MaterialIcons name="close" size={20} color={COLORS.textSub} />
                <Text style={styles.cancelText}>Отмена</Text>
              </Pressable>
              <Text style={styles.selectionCount}>{pluralSelected(selectedIds.size)}</Text>
              <Pressable style={styles.selectAllBtn} onPress={allSelected ? exitSelectionMode : selectAll} hitSlop={10}>
                <Text style={styles.selectAllText}>{allSelected ? 'Снять всё' : 'Выбрать всё'}</Text>
              </Pressable>
            </View>
            <View style={styles.bulkActions}>
              {selectedOnlineCount > 0 && (
                <Pressable
                  style={[styles.bulkBtn, styles.bulkBtnDownload]}
                  onPress={handleBulkDownload}
                  disabled={bulkDownloading}
                >
                  <MaterialIcons name="file-download" size={18} color={COLORS.white} />
                  <Text style={styles.bulkBtnText}>
                    Скачать{selectedOnlineCount > 0 ? ` (${selectedOnlineCount})` : ''}
                  </Text>
                </Pressable>
              )}
              {selectedIds.size > 0 && (
                <Pressable
                  style={[styles.bulkBtn, styles.bulkBtnDelete]}
                  onPress={handleBulkDelete}
                >
                  <MaterialIcons name="delete" size={18} color={COLORS.white} />
                  <Text style={styles.bulkBtnText}>
                    Удалить{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                  </Text>
                </Pressable>
              )}
              {selectedIds.size === 0 && (
                <Text style={styles.selectHint}>Нажмите на треки чтобы выбрать</Text>
              )}
            </View>
          </>
        ) : (
          <>
            <View style={styles.headerRow}>
              <MaterialIcons name="headphones" size={22} color={COLORS.accent} />
              <Text style={styles.headerTitle}>Библиотека</Text>
              {tracks.length > 0 && (
                <Pressable
                  style={styles.selectModeBtn}
                  onPress={() => { enterSelectionMode(); Haptics.selectionAsync(); }}
                  hitSlop={10}
                >
                  <MaterialIcons name="check-circle" size={18} color={COLORS.textSub} />
                </Pressable>
              )}
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
                  <Pressable
                    style={styles.statChipOnlineBtn}
                    onPress={handleDownloadAllOnline}
                    disabled={bulkDownloading}
                  >
                    <MaterialIcons name="file-download" size={12} color={COLORS.accent} />
                    <Text style={styles.statChipOnlineText}>
                      {onlineTracks.length} онлайн · Скачать все
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
            <Text style={styles.hint}>
              Свайп влево — скачать / удалить · Удерживать — выделение
            </Text>
          </>
        )}
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
          extraData={selectionMode ? `${selectionMode}-${[...selectedIds].join(',')}` : selectionMode}
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
    paddingHorizontal: 16,
    paddingBottom: 10,
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
    flex: 1,
  },
  selectModeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
  },
  cancelText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSub,
  },
  selectionCount: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
    textAlign: 'center',
  },
  selectAllBtn: {
    paddingVertical: 6,
  },
  selectAllText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.accent,
  },
  bulkActions: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    minHeight: 36,
  },
  bulkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  bulkBtnDownload: {
    backgroundColor: '#2563eb',
  },
  bulkBtnDelete: {
    backgroundColor: COLORS.danger,
  },
  bulkBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.white,
  },
  selectHint: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
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
  statChipOnlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.accentDim,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.accent + '40',
  },
  statChipOnlineText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.accent,
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
