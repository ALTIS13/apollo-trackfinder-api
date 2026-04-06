import { MaterialIcons } from '@/components/MaterialIcons';
import { SavedTrackCard } from '@/components/SavedTrackCard';
import { COLORS } from '@/constants/colors';
import { SavedTrack, useLibrary } from '@/hooks/use-library';
import { PlayerTrack, usePlayer } from '@/hooks/use-player';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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
  const { tracks, bulkDownload, cancelBulkDownload, bulkProgress, bulkRemove, isDownloading, queueServerDownloads, serverJobs } = useLibrary();
  const { currentTrack, playQueue } = usePlayer();

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<'date_desc' | 'date_asc' | 'import_order'>('date_desc');
  const [searchQuery, setSearchQuery] = useState('');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const sortedTracks = useMemo(() => {
    const copy = [...tracks];
    if (sortMode === 'date_asc') {
      copy.sort((a, b) => a.savedAt - b.savedAt);
    } else if (sortMode === 'import_order') {
      copy.sort((a, b) => {
        const ai = a.importOrder ?? Infinity;
        const bi = b.importOrder ?? Infinity;
        if (ai !== bi) return ai - bi;
        return a.savedAt - b.savedAt;
      });
    }
    return copy;
  }, [tracks, sortMode]);

  const filteredTracks = useMemo(() => {
    if (!searchQuery.trim()) return sortedTracks;
    const q = searchQuery.toLowerCase().trim();
    return sortedTracks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q),
    );
  }, [sortedTracks, searchQuery]);

  const handlePlay = useCallback(
    async (track: SavedTrack) => {
      const queueTracks: PlayerTrack[] = filteredTracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        thumbnailUrl: t.thumbnailUrl,
        duration: t.duration,
        localUri: t.localUri || undefined,
        source: t.source,
      }));
      const idx = filteredTracks.findIndex((t) => t.id === track.id);
      await playQueue(queueTracks, idx >= 0 ? idx : 0);
    },
    [filteredTracks, playQueue],
  );

  const cycleSortMode = useCallback(() => {
    Haptics.selectionAsync();
    setSortMode((prev) => {
      if (prev === 'date_desc') return 'date_asc';
      if (prev === 'date_asc') return 'import_order';
      return 'date_desc';
    });
  }, []);

  const sortLabel = sortMode === 'date_desc' ? 'Новые' : sortMode === 'date_asc' ? 'Старые' : 'Плейлист';

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
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    exitSelectionMode();

    // Use server-queue (BullMQ) for tracks whose ID encodes a trusted source URL
    const serverTracks = toDownload.filter((t) => t.id.startsWith('yt_') || t.id.startsWith('sc_') || t.id.startsWith('bc_'));
    const localTracks = toDownload.filter((t) => !serverTracks.includes(t));

    if (serverTracks.length > 0) {
      try {
        const jobs = await queueServerDownloads(serverTracks);
        const positions = jobs.map((j) => j.position).filter(Boolean);
        const minPos = positions.length > 0 ? Math.min(...positions) : 1;
        Alert.alert(
          'Поставлено в очередь',
          `${jobs.length} ${jobs.length === 1 ? 'трек' : 'трека'} поставлено на загрузку (позиция: ${minPos}). Файлы будут сохранены автоматически.`,
        );
      } catch {
        // Fall back to local download
        await bulkDownload(serverTracks).catch(() => {});
      }
    }

    if (localTracks.length > 0) {
      const { failed } = await bulkDownload(localTracks);
      if (failed > 0) {
        Alert.alert('Ошибка', `Не удалось скачать ${failed} ${failed === 1 ? 'трек' : 'трека'}. Проверьте соединение.`);
      }
    }
  }, [tracks, selectedIds, isDownloading, bulkDownload, queueServerDownloads, exitSelectionMode]);

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
            // Route yt/sc/bc tracks through server BullMQ queue; dz via direct stream
            const serverTracks = toDownload.filter((t) => t.id.startsWith('yt_') || t.id.startsWith('sc_') || t.id.startsWith('bc_'));
            const localTracks = toDownload.filter((t) => !serverTracks.includes(t));

            if (serverTracks.length > 0) {
              try {
                const jobs = await queueServerDownloads(serverTracks);
                Alert.alert('Поставлено в очередь', `${jobs.length} ${jobs.length === 1 ? 'трек' : 'трека'} поставлено на загрузку. Файлы сохранятся автоматически.`);
              } catch {
                await bulkDownload(serverTracks).catch(() => {});
              }
            }

            if (localTracks.length > 0) {
              const { failed } = await bulkDownload(localTracks);
              if (failed > 0) {
                Alert.alert('Ошибка', `Не удалось скачать ${failed} трека.`);
              }
            }
          },
        },
      ],
    );
  }, [onlineTracks, isDownloading, bulkDownload, queueServerDownloads]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SavedTrack>) => (
      <SavedTrackCard
        track={item}
        onSearchArtist={handleSearchArtist}
        onPlay={handlePlay}
        selectionMode={selectionMode}
        isSelected={selectedIds.has(item.id)}
        onToggleSelect={() => toggleSelect(item.id)}
        onEnterSelection={enterSelectionMode}
      />
    ),
    [handleSearchArtist, handlePlay, selectionMode, selectedIds, toggleSelect, enterSelectionMode],
  );

  const keyExtractor = useCallback((item: SavedTrack) => item.id, []);

  const allSelected = tracks.length > 0 && selectedIds.size === tracks.length;

  const { active: bulkActive, done: bulkDone, total: bulkTotal, failed: bulkFailed } = bulkProgress;

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
                  disabled={bulkActive}
                >
                  <MaterialIcons name="file-download" size={18} color={COLORS.white} />
                  <Text style={styles.bulkBtnText}>
                    Скачать ({selectedOnlineCount})
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
                    Удалить ({selectedIds.size})
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
                <Pressable style={styles.sortBtn} onPress={cycleSortMode} hitSlop={6}>
                  <MaterialIcons name="sort" size={12} color={COLORS.accent} />
                  <Text style={styles.sortBtnText}>{sortLabel}</Text>
                </Pressable>
                {downloadedTracks.length > 0 && (
                  <Text style={styles.statChip}>
                    {downloadedTracks.length} скачано · {formatBytes(totalSize)}
                  </Text>
                )}
                {onlineTracks.length > 0 && !bulkActive && (
                  <Pressable
                    style={styles.statChipOnlineBtn}
                    onPress={handleDownloadAllOnline}
                  >
                    <MaterialIcons name="file-download" size={12} color={COLORS.accent} />
                    <Text style={styles.statChipOnlineText}>
                      {onlineTracks.length} онлайн · Скачать все
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
            <View style={styles.searchRow}>
              <MaterialIcons name="search" size={16} color={COLORS.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Поиск по названию или исполнителю..."
                placeholderTextColor={COLORS.textMuted}
                returnKeyType="search"
                clearButtonMode="while-editing"
              />
              {searchQuery.length > 0 && (
                <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
                  <MaterialIcons name="close" size={14} color={COLORS.textMuted} />
                </Pressable>
              )}
            </View>
            <Text style={styles.hint}>
              Свайп влево — скачать / удалить · Удерживать — меню
            </Text>
          </>
        )}
      </View>

      {bulkActive && (
        <View style={styles.bulkProgressBar}>
          <View style={styles.bulkProgressLeft}>
            <ActivityIndicator size="small" color={COLORS.accent} />
            <Text style={styles.bulkProgressText}>
              Скачивание {bulkDone + 1}/{bulkTotal}
              {bulkFailed > 0 ? ` · ${bulkFailed} ошибок` : ''}
            </Text>
          </View>
          <Pressable
            style={styles.bulkCancelBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              cancelBulkDownload();
            }}
            hitSlop={8}
          >
            <MaterialIcons name="close" size={16} color={COLORS.danger} />
            <Text style={styles.bulkCancelText}>Стоп</Text>
          </Pressable>
        </View>
      )}

      {serverJobs.length > 0 && (
        <View style={styles.bulkProgressBar}>
          <View style={styles.bulkProgressLeft}>
            <ActivityIndicator size="small" color={COLORS.accent} />
            <Text style={styles.bulkProgressText}>
              Очередь сервера: {serverJobs.length} {serverJobs.length === 1 ? 'трек' : 'трека'}
              {serverJobs[0]?.position ? ` · поз. ${serverJobs[0].position}` : ''}
            </Text>
          </View>
        </View>
      )}

      {tracks.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="headphones" size={48} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>Библиотека пуста</Text>
          <Text style={styles.emptyText}>
            Нажмите значок загрузки на любом треке или импортируйте треки из Spotify / Яндекс Музыки
          </Text>
        </View>
      ) : filteredTracks.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="search-off" size={48} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>Ничего не найдено</Text>
          <Text style={styles.emptyText}>По запросу «{searchQuery}» треков нет</Text>
        </View>
      ) : (
        <FlashList
          data={filteredTracks}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          extraData={selectionMode ? `${selectionMode}-${[...selectedIds].join(',')}` : `${selectionMode}-${bulkActive}`}
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
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: COLORS.accentDim,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.accent + '40',
  },
  sortBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.accent,
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.card,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.text,
    padding: 0,
  },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    marginTop: 2,
  },
  bulkProgressBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.card,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 8,
  },
  bulkProgressLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  bulkProgressText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: COLORS.text,
  },
  bulkCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.danger + '60',
  },
  bulkCancelText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.danger,
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
