import { MaterialIcons } from '@/components/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ServerSettings } from '@/components/ServerSettings';
import { TrackCard, Track } from '@/components/TrackCard';
import { COLORS, TrackType } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';
import { apiFetch } from '@/hooks/use-session';

const FILTERS: { label: string; value: TrackType | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Original', value: 'original' },
  { label: 'Remix', value: 'remix' },
  { label: 'Live', value: 'live' },
  { label: 'Cover', value: 'cover' },
];

const PLAYER_HEIGHT = 62;
const TAB_BAR = Platform.OS === 'web' ? 84 : 50;

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ artist?: string; title?: string }>();
  const { currentTrack } = usePlayer();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [filter, setFilter] = useState<TrackType | 'all'>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (params.artist && params.title) {
      const q = `${params.artist} — ${params.title}`;
      setQuery(q);
      doSearch(params.artist, params.title);
    }
  }, [params.artist, params.title]);

  async function doSearch(artist?: string, title?: string) {
    const q = (artist && title)
      ? undefined
      : query.trim();

    const a = artist ?? query.split('—')[0]?.trim() ?? query.trim();
    const t = title ?? query.split('—')[1]?.trim() ?? '';

    if (!a) return;
    setIsSearching(true);
    setHasSearched(false);
    setError('');

    try {
      const data = await apiFetch<{ results: Track[] }>('/tracks/search', {
        method: 'POST',
        body: JSON.stringify({ artist: a, title: t }),
      });
      setResults(data.results ?? []);
      setFilter('all');
    } catch (e: any) {
      setError(e.message ?? 'Search failed');
    } finally {
      setIsSearching(false);
      setHasSearched(true);
    }
  }

  const filtered = filter === 'all'
    ? results
    : results.filter((t) => t.type === filter);

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: COLORS.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ServerSettings visible={settingsOpen} onClose={() => setSettingsOpen(false)} />

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
        <Text style={styles.headerSub}>Find every version of any track</Text>
      </View>

      <View style={styles.searchRow}>
        <View style={styles.searchInput}>
          <MaterialIcons name="search" size={16} color={COLORS.textMuted} style={styles.searchIcon} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Artist — Song title"
            placeholderTextColor={COLORS.textMuted}
            returnKeyType="search"
            onSubmitEditing={() => doSearch()}
            selectionColor={COLORS.accent}
          />
          {query.length > 0 && (
            <Pressable onPress={() => { setQuery(''); setResults([]); setHasSearched(false); }}>
              <MaterialIcons name="close" size={16} color={COLORS.textMuted} />
            </Pressable>
          )}
        </View>
        <Pressable
          style={[styles.searchBtn, isSearching && styles.searchBtnDisabled]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); doSearch(); }}
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
        <View style={styles.centerMsg}>
          <MaterialIcons name="error" size={32} color={COLORS.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => doSearch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : isSearching ? (
        <View style={styles.centerMsg}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>Searching YouTube + SoundCloud...</Text>
          <Text style={styles.loadingSubText}>First search may take up to 30 sec</Text>
        </View>
      ) : hasSearched && filtered.length === 0 ? (
        <View style={styles.centerMsg}>
          <MaterialIcons name="inbox" size={40} color={COLORS.textMuted} />
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptyText}>Try a different search or filter</Text>
        </View>
      ) : !hasSearched ? (
        <View style={styles.centerMsg}>
          <View style={styles.hero}>
            <MaterialIcons name="search" size={48} color={COLORS.textMuted} />
            <Text style={styles.heroTitle}>Search any track</Text>
            <Text style={styles.heroText}>
              Enter an artist and song name to find all versions — originals, remixes, live performances, and covers
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TrackCard track={item} />}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          scrollEnabled
        />
      )}
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
  centerMsg: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
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
});
