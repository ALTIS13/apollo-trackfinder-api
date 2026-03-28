import { BatchImportModal, ImportTrackInput } from '@/components/BatchImportModal';
import { MaterialIcons } from '@/components/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';
import {
  SpotifyPlaylist,
  useSpotifyLikedAllQuery,
  useSpotifyLogin,
  useSpotifyLogout,
  useSpotifyPlaylists,
  useSpotifyPlaylistTracks,
  useSpotifyStatus,
  useSpotifyTopTracks,
} from '@/hooks/use-spotify';
import {
  YandexPlaylist,
  useYandexConnect,
  useYandexDisconnect,
  useYandexLiked,
  useYandexPlaylists,
  useYandexPlaylistTracks,
  useYandexStatus,
} from '@/hooks/use-yandex';

const PLAYER_HEIGHT = 62;
const TAB_BAR = Platform.OS === 'web' ? 84 : 50;
const ROW_HEIGHT = 65;

type Service = 'spotify' | 'yandex';
type SpotifyTab = 'liked' | 'playlists' | 'top';
type YandexTab = 'liked' | 'playlists';
type CatalogTrack = { id: string; title: string; artist: string; thumbnailUrl: string | null };

const CatalogTrackRow = memo(function CatalogTrackRow({
  title,
  artist,
  thumbnailUrl,
  onFindVariants,
}: {
  title: string;
  artist: string;
  thumbnailUrl: string | null;
  onFindVariants: () => void;
}) {
  return (
    <View style={styles.catalogRow}>
      <View style={styles.catalogThumb}>
        {thumbnailUrl ? (
          <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <MaterialIcons name="music-note" size={16} color={COLORS.textMuted} />
        )}
      </View>
      <View style={styles.catalogInfo}>
        <Text style={styles.catalogTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.catalogArtist} numberOfLines={1}>{artist}</Text>
      </View>
      <Pressable
        style={styles.variantsBtn}
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onFindVariants(); }}
        hitSlop={8}
      >
        <MaterialIcons name="search" size={15} color={COLORS.accent} />
      </Pressable>
    </View>
  );
});

function PlaylistCard({
  name,
  trackCount,
  thumbnailUrl,
  onPress,
}: {
  name: string;
  trackCount: number;
  thumbnailUrl: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.playlistCard} onPress={onPress}>
      <View style={styles.playlistThumb}>
        {thumbnailUrl ? (
          <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <MaterialIcons name="list" size={20} color={COLORS.textMuted} />
        )}
      </View>
      <Text style={styles.playlistName} numberOfLines={2}>{name}</Text>
      <Text style={styles.playlistCount}>{trackCount} треков</Text>
    </Pressable>
  );
}

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentTrack } = usePlayer();
  const listRef = useRef<FlatList>(null);

  const [service, setService] = useState<Service>('spotify');
  const [spotifyTab, setSpotifyTab] = useState<SpotifyTab>('liked');
  const [yandexTab, setYandexTab] = useState<YandexTab>('liked');
  const [selectedSpotifyPlaylist, setSelectedSpotifyPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [selectedYandexPlaylist, setSelectedYandexPlaylist] = useState<YandexPlaylist | null>(null);
  const [batchTracks, setBatchTracks] = useState<ImportTrackInput[]>([]);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [yandexToken, setYandexToken] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const { data: spotifyStatus } = useSpotifyStatus();
  const spotifyLogin = useSpotifyLogin();
  const spotifyLogout = useSpotifyLogout();

  const isSpotifyLikedEnabled = spotifyStatus?.connected === true && service === 'spotify' && spotifyTab === 'liked';
  const likedAllQuery = useSpotifyLikedAllQuery(isSpotifyLikedEnabled);
  const spotifyPlaylistsQuery = useSpotifyPlaylists();
  const spotifyTopQuery = useSpotifyTopTracks();
  const spotifyPlaylistTracksQuery = useSpotifyPlaylistTracks(selectedSpotifyPlaylist?.id ?? null, 0);

  const { data: yandexStatus } = useYandexStatus();
  const yandexConnect = useYandexConnect();
  const yandexDisconnect = useYandexDisconnect();
  const yandexLikedQuery = useYandexLiked(0);
  const yandexPlaylistsQuery = useYandexPlaylists();
  const yandexPlaylistTracksQuery = useYandexPlaylistTracks(
    selectedYandexPlaylist?.uid ?? null,
    selectedYandexPlaylist?.kind ?? null,
  );

  const activeTab = service === 'spotify' ? spotifyTab : yandexTab;
  const isLikedTab = activeTab === 'liked';

  const spotifyLikedTracks: CatalogTrack[] = likedAllQuery.data?.tracks ?? [];
  const yandexLikedTracks: CatalogTrack[] = yandexLikedQuery.data?.tracks ?? [];
  const likedTracks = service === 'spotify' ? spotifyLikedTracks : yandexLikedTracks;

  const handleFindVariants = useCallback((artist: string, title: string) => {
    router.navigate({ pathname: '/', params: { artist, title } });
  }, [router]);

  const handleImportAll = useCallback((tracks: ImportTrackInput[]) => {
    setBatchTracks(tracks);
  }, []);

  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const renderItem = useCallback(({ item }: { item: CatalogTrack }) => (
    <CatalogTrackRow
      title={item.title}
      artist={item.artist}
      thumbnailUrl={item.thumbnailUrl}
      onFindVariants={() => handleFindVariants(item.artist, item.title)}
    />
  ), [handleFindVariants]);

  const keyExtractor = useCallback((item: CatalogTrack) => item.id, []);

  const getItemLayout = useCallback((_: any, index: number) => ({
    length: ROW_HEIGHT,
    offset: ROW_HEIGHT * index,
    index,
  }), []);

  const spotifyLikedHeader = useMemo(() => {
    if (likedAllQuery.isFetching && !likedAllQuery.data) {
      return (
        <View style={styles.fetchPrompt}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadBtnText}>Загрузка библиотеки…</Text>
        </View>
      );
    }
    if (spotifyLikedTracks.length === 0) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => likedAllQuery.refetch()}>
            <Text style={styles.loadBtnText}>Загрузить треки</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.importAllRow}>
        <Pressable
          style={styles.importAllBtn}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            handleImportAll(spotifyLikedTracks.map(t => ({ artist: t.artist, title: t.title, thumbnailUrl: t.thumbnailUrl })));
          }}
        >
          <MaterialIcons name="file-download" size={14} color={COLORS.accent} />
          <Text style={styles.importAllText}>Импортировать все {spotifyLikedTracks.length} треков</Text>
        </Pressable>
      </View>
    );
  }, [likedAllQuery.isFetching, likedAllQuery.data, spotifyLikedTracks, handleImportAll]);

  const yandexLikedHeader = useMemo(() => {
    if (!yandexLikedQuery.data && !yandexLikedQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => yandexLikedQuery.refetch()}>
            <Text style={styles.loadBtnText}>Загрузить треки</Text>
          </Pressable>
        </View>
      );
    }
    if (yandexLikedQuery.isFetching) {
      return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    }
    if (yandexLikedTracks.length === 0) return null;
    return (
      <View style={styles.importAllRow}>
        <Pressable
          style={styles.importAllBtn}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            handleImportAll(yandexLikedTracks.map(t => ({ artist: t.artist, title: t.title, thumbnailUrl: t.thumbnailUrl })));
          }}
        >
          <MaterialIcons name="file-download" size={14} color={COLORS.accent} />
          <Text style={styles.importAllText}>Импортировать все {yandexLikedTracks.length} треков</Text>
        </Pressable>
      </View>
    );
  }, [yandexLikedQuery.data, yandexLikedQuery.isFetching, yandexLikedTracks, handleImportAll]);

  const renderSpotifyPlaylists = () => {
    if (selectedSpotifyPlaylist) {
      return (
        <>
          <Pressable style={styles.backBtn} onPress={() => setSelectedSpotifyPlaylist(null)}>
            <MaterialIcons name="arrow-back" size={16} color={COLORS.text} />
            <Text style={styles.backBtnText}>{selectedSpotifyPlaylist.name}</Text>
          </Pressable>
          {spotifyPlaylistTracksQuery.isFetching ? (
            <ActivityIndicator style={styles.loader} color={COLORS.accent} />
          ) : (
            (spotifyPlaylistTracksQuery.data?.tracks ?? []).map((t) => (
              <CatalogTrackRow
                key={t.id}
                title={t.title}
                artist={t.artist}
                thumbnailUrl={t.thumbnailUrl}
                onFindVariants={() => handleFindVariants(t.artist, t.title)}
              />
            ))
          )}
        </>
      );
    }
    if (!spotifyPlaylistsQuery.data && !spotifyPlaylistsQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => spotifyPlaylistsQuery.refetch()}>
            <Text style={styles.loadBtnText}>Загрузить плейлисты</Text>
          </Pressable>
        </View>
      );
    }
    if (spotifyPlaylistsQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    return (
      <View style={styles.playlistGrid}>
        {(spotifyPlaylistsQuery.data?.playlists ?? []).map((pl) => (
          <PlaylistCard
            key={pl.id}
            name={pl.name}
            trackCount={pl.trackCount}
            thumbnailUrl={pl.thumbnailUrl}
            onPress={() => setSelectedSpotifyPlaylist(pl)}
          />
        ))}
      </View>
    );
  };

  const renderSpotifyTop = () => {
    if (!spotifyTopQuery.data && !spotifyTopQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => spotifyTopQuery.refetch()}>
            <Text style={styles.loadBtnText}>Загрузить чарты</Text>
          </Pressable>
        </View>
      );
    }
    if (spotifyTopQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    return (
      <>
        {(spotifyTopQuery.data?.tracks ?? []).map((t) => (
          <CatalogTrackRow
            key={t.id}
            title={t.title}
            artist={t.artist}
            thumbnailUrl={t.thumbnailUrl}
            onFindVariants={() => handleFindVariants(t.artist, t.title)}
          />
        ))}
      </>
    );
  };

  const renderYandexPlaylists = () => {
    if (selectedYandexPlaylist) {
      return (
        <>
          <Pressable style={styles.backBtn} onPress={() => setSelectedYandexPlaylist(null)}>
            <MaterialIcons name="arrow-back" size={16} color={COLORS.text} />
            <Text style={styles.backBtnText}>{selectedYandexPlaylist.title}</Text>
          </Pressable>
          {yandexPlaylistTracksQuery.isFetching ? (
            <ActivityIndicator style={styles.loader} color={COLORS.accent} />
          ) : (
            (yandexPlaylistTracksQuery.data?.tracks ?? []).map((t) => (
              <CatalogTrackRow
                key={t.id}
                title={t.title}
                artist={t.artist}
                thumbnailUrl={t.thumbnailUrl}
                onFindVariants={() => handleFindVariants(t.artist, t.title)}
              />
            ))
          )}
        </>
      );
    }
    if (!yandexPlaylistsQuery.data && !yandexPlaylistsQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => yandexPlaylistsQuery.refetch()}>
            <Text style={styles.loadBtnText}>Загрузить плейлисты</Text>
          </Pressable>
        </View>
      );
    }
    if (yandexPlaylistsQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    return (
      <View style={styles.playlistGrid}>
        {(yandexPlaylistsQuery.data?.playlists ?? []).map((pl) => (
          <PlaylistCard
            key={`${pl.uid}_${pl.kind}`}
            name={pl.title}
            trackCount={pl.trackCount}
            thumbnailUrl={pl.thumbnailUrl}
            onPress={() => setSelectedYandexPlaylist(pl)}
          />
        ))}
      </View>
    );
  };

  const renderSpotifySection = () => {
    if (!spotifyStatus?.connected) {
      return (
        <View style={styles.connectPrompt}>
          <View style={[styles.serviceIconBig, { backgroundColor: COLORS.spotifyBg }]}>
            <MaterialIcons name="music-note" size={32} color={COLORS.spotifyGreen} />
          </View>
          <Text style={styles.connectTitle}>Подключить Spotify</Text>
          <Text style={styles.connectText}>Слушайте понравившиеся треки, плейлисты и чарты</Text>
          <Pressable
            style={[styles.connectBtn, { backgroundColor: COLORS.spotifyGreen }]}
            onPress={() => spotifyLogin.mutate()}
            disabled={spotifyLogin.isPending}
          >
            {spotifyLogin.isPending ? (
              <ActivityIndicator size="small" color={COLORS.white} />
            ) : (
              <Text style={styles.connectBtnText}>Войти через Spotify</Text>
            )}
          </Pressable>
          <Text style={styles.connectNote}>Только чтение · мы не изменяем вашу библиотеку</Text>
        </View>
      );
    }

    const spotifyTabs: { id: SpotifyTab; label: string }[] = [
      { id: 'liked', label: 'Понравилось' },
      { id: 'playlists', label: 'Плейлисты' },
      { id: 'top', label: 'Чарты' },
    ];

    return (
      <View>
        <View style={styles.connectedHeader}>
          <View style={styles.connectedInfo}>
            <View style={[styles.serviceIcon, { backgroundColor: COLORS.spotifyBg }]}>
              <MaterialIcons name="music-note" size={16} color={COLORS.spotifyGreen} />
            </View>
            <Text style={styles.connectedName}>{spotifyStatus.displayName ?? 'Spotify'}</Text>
          </View>
          <Pressable onPress={() => spotifyLogout.mutate()} style={styles.disconnectBtn}>
            <Text style={styles.disconnectText}>Отключить</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
          {spotifyTabs.map((t) => (
            <Pressable
              key={t.id}
              style={[styles.tabChip, spotifyTab === t.id && styles.tabChipActive]}
              onPress={() => { setSpotifyTab(t.id); Haptics.selectionAsync(); }}
            >
              <Text style={[styles.tabChipText, spotifyTab === t.id && styles.tabChipTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {spotifyTab === 'liked' && spotifyLikedHeader}
        {spotifyTab === 'playlists' && renderSpotifyPlaylists()}
        {spotifyTab === 'top' && renderSpotifyTop()}
      </View>
    );
  };

  const renderYandexSection = () => {
    if (!yandexStatus?.connected) {
      return (
        <View style={styles.connectPrompt}>
          <View style={[styles.serviceIconBig, { backgroundColor: COLORS.yandexBg }]}>
            <MaterialIcons name="headphones" size={32} color={COLORS.yandexYellow} />
          </View>
          <Text style={styles.connectTitle}>Подключить Яндекс Музыку</Text>
          <Text style={styles.connectText}>
            Получите OAuth-токен на oauth.yandex.ru и вставьте его ниже
          </Text>
          {showTokenInput ? (
            <View style={styles.tokenInputWrap}>
              <TextInput
                style={styles.tokenInput}
                value={yandexToken}
                onChangeText={setYandexToken}
                placeholder="Вставьте OAuth-токен"
                placeholderTextColor={COLORS.textMuted}
                multiline
                selectionColor={COLORS.yandexYellow}
              />
              <Pressable
                style={[styles.connectBtn, { backgroundColor: COLORS.yandexYellow }, !yandexToken.trim() && styles.btnDisabled]}
                onPress={async () => {
                  if (!yandexToken.trim()) return;
                  await yandexConnect.mutateAsync(yandexToken.trim());
                }}
                disabled={!yandexToken.trim() || yandexConnect.isPending}
              >
                {yandexConnect.isPending ? (
                  <ActivityIndicator size="small" color={COLORS.black} />
                ) : (
                  <Text style={[styles.connectBtnText, { color: COLORS.black }]}>Подключить</Text>
                )}
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.connectBtn, { backgroundColor: COLORS.yandexYellow }]}
              onPress={() => setShowTokenInput(true)}
            >
              <Text style={[styles.connectBtnText, { color: COLORS.black }]}>Ввести токен</Text>
            </Pressable>
          )}
          {yandexConnect.isError && (
            <Text style={styles.errorMsg}>Неверный токен. Попробуйте ещё раз.</Text>
          )}
        </View>
      );
    }

    const yandexTabs: { id: YandexTab; label: string }[] = [
      { id: 'liked', label: 'Понравилось' },
      { id: 'playlists', label: 'Плейлисты' },
    ];

    return (
      <View>
        <View style={styles.connectedHeader}>
          <View style={styles.connectedInfo}>
            <View style={[styles.serviceIcon, { backgroundColor: COLORS.yandexBg }]}>
              <MaterialIcons name="headphones" size={16} color={COLORS.yandexYellow} />
            </View>
            <Text style={styles.connectedName}>{yandexStatus.login ?? 'Яндекс Музыка'}</Text>
          </View>
          <Pressable onPress={() => yandexDisconnect.mutate()} style={styles.disconnectBtn}>
            <Text style={styles.disconnectText}>Отключить</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
          {yandexTabs.map((t) => (
            <Pressable
              key={t.id}
              style={[styles.tabChip, yandexTab === t.id && styles.tabChipActive]}
              onPress={() => { setYandexTab(t.id); Haptics.selectionAsync(); }}
            >
              <Text style={[styles.tabChipText, yandexTab === t.id && styles.tabChipTextActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {yandexTab === 'liked' && yandexLikedHeader}
        {yandexTab === 'playlists' && renderYandexPlaylists()}
      </View>
    );
  };

  const ListHeader = useMemo(() => (
    <View>
      <View style={[styles.header, { paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="favorite" size={22} color={COLORS.accent} />
          <Text style={styles.headerTitle}>Избранное</Text>
        </View>
        <Text style={styles.headerSub}>Найдите варианты ваших сохранённых треков</Text>
      </View>

      <View style={styles.serviceSwitcher}>
        {(['spotify', 'yandex'] as Service[]).map((s) => (
          <Pressable
            key={s}
            style={[styles.serviceTab, service === s && styles.serviceTabActive]}
            onPress={() => { setService(s); Haptics.selectionAsync(); }}
          >
            <MaterialIcons
              name={s === 'spotify' ? 'music-note' : 'headphones'}
              size={15}
              color={service === s
                ? (s === 'spotify' ? COLORS.spotifyGreen : COLORS.yandexYellow)
                : COLORS.textMuted
              }
            />
            <Text
              style={[
                styles.serviceTabText,
                service === s && (s === 'spotify' ? styles.serviceTabSpotify : styles.serviceTabYandex),
              ]}
            >
              {s === 'spotify' ? 'Spotify' : 'Яндекс Музыка'}
            </Text>
          </Pressable>
        ))}
      </View>

      {service === 'spotify' ? renderSpotifySection() : renderYandexSection()}
    </View>
  ), [
    topPad, service,
    spotifyStatus, spotifyLogin.isPending, spotifyTab, spotifyLikedHeader,
    spotifyPlaylistsQuery.data, spotifyPlaylistsQuery.isFetching,
    spotifyTopQuery.data, spotifyTopQuery.isFetching,
    selectedSpotifyPlaylist, spotifyPlaylistTracksQuery.data, spotifyPlaylistTracksQuery.isFetching,
    yandexStatus, yandexConnect.isPending, yandexConnect.isError, yandexTab, yandexLikedHeader,
    yandexToken, showTokenInput,
    yandexPlaylistsQuery.data, yandexPlaylistsQuery.isFetching,
    selectedYandexPlaylist, yandexPlaylistTracksQuery.data, yandexPlaylistTracksQuery.isFetching,
  ]);

  return (
    <View style={[styles.root, { backgroundColor: COLORS.bg }]}>
      <BatchImportModal
        visible={batchTracks.length > 0}
        tracks={batchTracks}
        onClose={() => setBatchTracks([])}
      />

      <FlatList
        ref={listRef}
        data={isLikedTab ? likedTracks : []}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={<View style={{ height: bottomPad }} />}
        maxToRenderPerBatch={15}
        initialNumToRender={20}
        windowSize={5}
        removeClippedSubviews={Platform.OS !== 'web'}
        onScroll={(e) => setShowScrollTop(e.nativeEvent.contentOffset.y > 300)}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />

      {showScrollTop && (
        <Pressable style={styles.scrollTopBtn} onPress={scrollToTop}>
          <MaterialIcons name="arrow-upward" size={20} color={COLORS.white} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  serviceSwitcher: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 14,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  serviceTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 9,
  },
  serviceTabActive: {
    backgroundColor: COLORS.surface,
  },
  serviceTabText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textMuted,
  },
  serviceTabSpotify: { color: COLORS.spotifyGreen },
  serviceTabYandex: { color: COLORS.yandexYellow },

  connectPrompt: {
    alignItems: 'center',
    padding: 32,
    gap: 12,
  },
  serviceIconBig: {
    width: 72,
    height: 72,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  connectTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
    textAlign: 'center',
  },
  connectText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 280,
  },
  connectBtn: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
    minWidth: 200,
    alignItems: 'center',
  },
  connectBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: COLORS.white,
  },
  btnDisabled: { opacity: 0.4 },
  connectNote: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  tokenInputWrap: {
    width: '100%',
    gap: 10,
    marginTop: 4,
  },
  tokenInput: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.text,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  errorMsg: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.danger,
    textAlign: 'center',
  },

  connectedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  connectedInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  serviceIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectedName: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  disconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  disconnectText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSub,
  },

  tabsRow: {
    paddingHorizontal: 16,
    gap: 8,
    paddingBottom: 10,
  },
  tabChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  tabChipActive: {
    backgroundColor: COLORS.accentDim,
    borderColor: COLORS.accent + '50',
  },
  tabChipText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: COLORS.textSub,
  },
  tabChipTextActive: { color: COLORS.accent },

  importAllRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  importAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 9,
    backgroundColor: COLORS.accentDim,
    borderWidth: 1,
    borderColor: COLORS.accent + '40',
    alignSelf: 'flex-start',
  },
  importAllText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.accent,
  },
  fetchPrompt: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  loadBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  loadBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  loader: {
    paddingVertical: 32,
  },

  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    height: ROW_HEIGHT,
  },
  catalogThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  catalogInfo: {
    flex: 1,
    gap: 2,
  },
  catalogTitle: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  catalogArtist: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  variantsBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: COLORS.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playlistGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 12,
    paddingBottom: 12,
  },
  playlistCard: {
    width: '46%',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  playlistThumb: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  playlistName: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  playlistCount: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
    flex: 1,
  },
  scrollTopBtn: {
    position: 'absolute',
    right: 16,
    bottom: TAB_BAR + 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
});
