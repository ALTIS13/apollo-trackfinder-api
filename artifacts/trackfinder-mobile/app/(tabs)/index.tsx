import { MaterialIcons } from '@/components/MaterialIcons';
import { TrackCard, Track } from '@/components/TrackCard';
import { ServerSettings } from '@/components/ServerSettings';
import { COLORS, TrackType } from '@/constants/colors';
import { usePlayer, PlayerTrack } from '@/hooks/use-player';
import { apiFetch, getSessionId } from '@/hooks/use-session';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  ListRenderItemInfo,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const FILTERS: { label: string; value: TrackType | 'all' }[] = [
  { label: 'Все', value: 'all' },
  { label: 'Оригинал', value: 'original' },
  { label: 'Ремикс', value: 'remix' },
  { label: 'Живое', value: 'live' },
  { label: 'Кавер', value: 'cover' },
];

const PLAYER_HEIGHT = 62;
const TAB_BAR = Platform.OS === 'web' ? 84 : 50;
const PAGE_SIZE = 20;
const LOAD_MORE_SIZE = 40;

interface MiniTrack {
  id: string;
  artist: string;
  title: string;
  thumbnailUrl: string | null;
}

function MiniTrackCard({ track, onPress }: { track: MiniTrack; onPress: () => void }) {
  return (
    <Pressable style={miniStyles.card} onPress={onPress}>
      <View style={miniStyles.thumb}>
        {track.thumbnailUrl ? (
          <Image source={{ uri: track.thumbnailUrl }} style={miniStyles.img} />
        ) : (
          <MaterialIcons name="music-note" size={22} color={COLORS.textMuted} />
        )}
      </View>
      <Text style={miniStyles.title} numberOfLines={1}>{track.title || 'Без названия'}</Text>
      <Text style={miniStyles.artist} numberOfLines={1}>{track.artist || '—'}</Text>
    </Pressable>
  );
}

const miniStyles = StyleSheet.create({
  card: {
    width: 120,
    marginRight: 12,
  },
  thumb: {
    width: 120,
    height: 120,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 8,
  },
  img: {
    width: '100%',
    height: '100%',
  },
  title: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
    marginBottom: 2,
  },
  artist: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
});

function SectionSkeleton() {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={sectionStyles.row}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={[miniStyles.card, { opacity: 0.4 }]}>
          <View style={[miniStyles.thumb, { backgroundColor: COLORS.card }]} />
          <View style={{ height: 12, width: 80, backgroundColor: COLORS.card, borderRadius: 4, marginBottom: 4 }} />
          <View style={{ height: 10, width: 60, backgroundColor: COLORS.card, borderRadius: 4 }} />
        </View>
      ))}
    </ScrollView>
  );
}

const sectionStyles = StyleSheet.create({
  container: {
    marginBottom: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  title: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  row: {
    paddingHorizontal: 16,
  },
  empty: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
});

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ artist?: string; title?: string; q?: string }>();
  const { currentTrack, play } = usePlayer();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [filter, setFilter] = useState<TrackType | 'all'>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const lastSearchRef = useRef<{ artist: string; title: string } | null>(null);

  const [recentTracks, setRecentTracks] = useState<MiniTrack[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recommendations, setRecommendations] = useState<MiniTrack[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);

  const loadRecentAndRecs = useCallback(async () => {
    const sessionId = getSessionId();

    setRecentLoading(true);
    apiFetch<{ results: MiniTrack[] }>(`/tracks/recent?sessionId=${sessionId}`)
      .then((data) => setRecentTracks(data.results ?? []))
      .catch(() => {})
      .finally(() => setRecentLoading(false));

    setRecsLoading(true);
    apiFetch<{ results: MiniTrack[] }>(`/tracks/recommendations?sessionId=${sessionId}`)
      .then((data) => setRecommendations(data.results ?? []))
      .catch(() => {})
      .finally(() => setRecsLoading(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadRecentAndRecs();
    }, [loadRecentAndRecs]),
  );

  useEffect(() => {
    if (params.artist && params.title) {
      const q = `${params.artist} — ${params.title}`;
      setQuery(q);
      doSearch(params.artist, params.title, PAGE_SIZE);
    } else if (params.artist && !params.title) {
      setQuery(params.artist);
      doSearch(params.artist, '', PAGE_SIZE);
    }
  }, [params.artist, params.title]);

  async function doSearch(artist?: string, title?: string, maxResults = PAGE_SIZE) {
    const a = artist ?? query.split('—')[0]?.trim() ?? query.trim();
    const t = title ?? query.split('—')[1]?.trim() ?? '';

    if (!a) return;
    lastSearchRef.current = { artist: a, title: t };

    setIsSearching(true);
    setHasSearched(false);
    setError('');
    setCanLoadMore(false);

    try {
      const data = await apiFetch<{ results: Track[] }>('/tracks/search', {
        method: 'POST',
        body: JSON.stringify({ artist: a, title: t, maxResults }),
      });
      const fetched = data.results ?? [];
      setResults(fetched);
      setFilter('all');
      setCanLoadMore(fetched.length >= maxResults);
    } catch (e: any) {
      setError(e.message ?? 'Ошибка поиска');
    } finally {
      setIsSearching(false);
      setHasSearched(true);
    }
  }

  async function loadMore() {
    if (!lastSearchRef.current || isLoadingMore) return;
    setIsLoadingMore(true);
    setCanLoadMore(false);
    const { artist, title } = lastSearchRef.current;
    try {
      const data = await apiFetch<{ results: Track[] }>('/tracks/search', {
        method: 'POST',
        body: JSON.stringify({ artist, title, maxResults: LOAD_MORE_SIZE }),
      });
      const fetched = data.results ?? [];
      setResults(fetched);
      setCanLoadMore(false);
    } catch {
    } finally {
      setIsLoadingMore(false);
    }
  }

  const handleFindVariants = useCallback((track: Track) => {
    const q = `${track.artist} — ${track.title}`;
    setQuery(q);
    setFilter('all');
    doSearch(track.artist, track.title, PAGE_SIZE);
  }, []);

  const handleMiniTrackPress = useCallback((track: MiniTrack) => {
    const playerTrack: PlayerTrack = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      thumbnailUrl: track.thumbnailUrl,
      duration: 0,
    };
    play(playerTrack);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [play]);

  const filtered = filter === 'all'
    ? results
    : results.filter((t) => t.type === filter);

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const showDiscovery = !query.trim() && !hasSearched && !isSearching;

  const keyExtractor = useCallback((item: Track) => item.id, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Track>) => (
      <TrackCard track={item} onFindVariants={handleFindVariants} />
    ),
    [handleFindVariants],
  );

  const DiscoverySections = useCallback(() => {
    if (!showDiscovery) return null;
    const hasRecent = recentLoading || recentTracks.length > 0;
    const hasRecs = recsLoading || recommendations.length > 0;
    if (!hasRecent && !hasRecs) return null;
    return (
      <View style={{ paddingBottom: 4 }}>
        {hasRecent && (
          <View style={sectionStyles.container}>
            <View style={sectionStyles.header}>
              <Text style={sectionStyles.title}>Недавно слушал</Text>
              <Pressable onPress={loadRecentAndRecs} hitSlop={8}>
                <MaterialIcons name="refresh" size={16} color={COLORS.textMuted} />
              </Pressable>
            </View>
            {recentLoading ? (
              <SectionSkeleton />
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={sectionStyles.row}
              >
                {recentTracks.map((track) => (
                  <MiniTrackCard
                    key={track.id}
                    track={track}
                    onPress={() => handleMiniTrackPress(track)}
                  />
                ))}
              </ScrollView>
            )}
          </View>
        )}

        {hasRecs && (
          <View style={sectionStyles.container}>
            <View style={sectionStyles.header}>
              <Text style={sectionStyles.title}>Рекомендации</Text>
            </View>
            {recsLoading ? (
              <SectionSkeleton />
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={sectionStyles.row}
              >
                {recommendations.map((track) => (
                  <MiniTrackCard
                    key={track.id}
                    track={track}
                    onPress={() => handleMiniTrackPress(track)}
                  />
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </View>
    );
  }, [showDiscovery, recentLoading, recentTracks, recsLoading, recommendations, handleMiniTrackPress, loadRecentAndRecs]);

  const ListFooter = useCallback(() => {
    if (!canLoadMore && !isLoadingMore) return null;
    return (
      <View style={styles.loadMoreRow}>
        {isLoadingMore ? (
          <ActivityIndicator color={COLORS.accent} />
        ) : canLoadMore ? (
          <Pressable style={styles.loadMoreBtn} onPress={loadMore}>
            <MaterialIcons name="keyboard-arrow-down" size={18} color={COLORS.text} />
            <Text style={styles.loadMoreText}>Загрузить ещё</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [canLoadMore, isLoadingMore]);

  const ListHeader = useCallback(() => (
    <View>
      <View style={[styles.header, { paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="music-note" size={22} color={COLORS.accent} />
          <Text style={styles.headerTitle}>Apollo TrackFinder</Text>
          <Pressable
            style={styles.settingsBtn}
            onPress={() => setSettingsOpen(true)}
            hitSlop={12}
          >
            <MaterialIcons name="settings" size={18} color={COLORS.textSub} />
          </Pressable>
        </View>
        <Text style={styles.headerSub}>Найди все версии любого трека</Text>
      </View>

      <DiscoverySections />

      <View style={styles.searchRow}>
        <View style={styles.searchInput}>
          <MaterialIcons name="search" size={16} color={COLORS.textMuted} style={styles.searchIcon} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Артист — Название трека"
            placeholderTextColor={COLORS.textMuted}
            returnKeyType="search"
            onSubmitEditing={() => doSearch(undefined, undefined, PAGE_SIZE)}
            selectionColor={COLORS.accent}
          />
          {query.length > 0 && (
            <Pressable onPress={() => { setQuery(''); setResults([]); setHasSearched(false); setCanLoadMore(false); }}>
              <MaterialIcons name="close" size={16} color={COLORS.textMuted} />
            </Pressable>
          )}
        </View>
        <Pressable
          style={[styles.searchBtn, (isSearching || !query.trim()) && styles.searchBtnDisabled]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); doSearch(undefined, undefined, PAGE_SIZE); }}
          disabled={isSearching || !query.trim()}
        >
          {isSearching ? (
            <ActivityIndicator size="small" color={COLORS.white} />
          ) : (
            <MaterialIcons name="search" size={18} color={COLORS.white} />
          )}
        </Pressable>
      </View>

      {hasSearched && results.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filtersScroll}
          contentContainerStyle={styles.filtersContent}
        >
          {FILTERS.map((f) => {
            const count = f.value === 'all' ? results.length : results.filter((t) => t.type === f.value).length;
            if (f.value !== 'all' && count === 0) return null;
            return (
              <Pressable
                key={f.value}
                style={[styles.filterChip, filter === f.value && styles.filterChipActive]}
                onPress={() => { setFilter(f.value); Haptics.selectionAsync(); }}
              >
                <Text style={[styles.filterText, filter === f.value && styles.filterTextActive]}>
                  {f.label}
                </Text>
                <Text style={[styles.filterCount, filter === f.value && styles.filterCountActive]}>
                  {count}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {error ? (
        <View style={styles.statusMsg}>
          <MaterialIcons name="error" size={32} color={COLORS.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => doSearch(undefined, undefined, PAGE_SIZE)}>
            <Text style={styles.retryText}>Попробовать снова</Text>
          </Pressable>
        </View>
      ) : isSearching ? (
        <View style={styles.statusMsg}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>Ищем на YouTube + SoundCloud...</Text>
          <Text style={styles.loadingSubText}>Первый поиск может занять до 30 секунд</Text>
        </View>
      ) : hasSearched && filtered.length === 0 ? (
        <View style={styles.statusMsg}>
          <MaterialIcons name="inbox" size={40} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>Ничего не найдено</Text>
          <Text style={styles.emptyText}>Попробуй другой запрос или фильтр</Text>
        </View>
      ) : !hasSearched && !showDiscovery ? (
        <View style={styles.heroWrapper}>
          <View style={styles.hero}>
            <MaterialIcons name="search" size={48} color={COLORS.textMuted} />
            <Text style={styles.heroTitle}>Найти трек</Text>
            <Text style={styles.heroText}>
              Введи исполнителя и название — найдём все версии: оригинал, ремиксы, живые выступления и каверы
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  ), [topPad, query, isSearching, hasSearched, error, results, filter, filtered, showDiscovery, recentLoading, recentTracks, recsLoading, recommendations]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: COLORS.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ServerSettings visible={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <FlatList
        data={hasSearched ? filtered : []}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListHeaderComponent={ListHeader}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={ListFooter}
        removeClippedSubviews={Platform.OS !== 'web'}
        stickyHeaderIndices={[]}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
    flex: 1,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 12,
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  searchIcon: {
    flexShrink: 0,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: COLORS.text,
  },
  searchBtn: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBtnDisabled: {
    opacity: 0.5,
  },
  filtersScroll: {
    flexShrink: 0,
  },
  filtersContent: {
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 10,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterChipActive: {
    backgroundColor: COLORS.accentDim,
    borderColor: COLORS.accent + '60',
  },
  filterText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSub,
  },
  filterTextActive: {
    color: COLORS.accent,
  },
  filterCount: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textMuted,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  filterCountActive: {
    color: COLORS.accent,
    backgroundColor: COLORS.bg,
  },
  statusMsg: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    paddingTop: 40,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    marginTop: 8,
  },
  loadingSubText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    marginTop: 2,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.danger,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: COLORS.card,
    marginTop: 4,
  },
  retryText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  heroWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  hero: {
    alignItems: 'center',
    gap: 12,
    maxWidth: 280,
  },
  heroTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: COLORS.textSub,
  },
  heroText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  loadMoreRow: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  loadMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  loadMoreText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
});
