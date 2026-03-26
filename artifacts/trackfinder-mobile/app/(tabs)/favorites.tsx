import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
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
  SpotifyTrack,
  useSpotifyLiked,
  useSpotifyLogin,
  useSpotifyLogout,
  useSpotifyPlaylists,
  useSpotifyPlaylistTracks,
  useSpotifyStatus,
  useSpotifyTopTracks,
} from '@/hooks/use-spotify';
import {
  YandexPlaylist,
  YandexTrack,
  useYandexConnect,
  useYandexDisconnect,
  useYandexLiked,
  useYandexPlaylists,
  useYandexPlaylistTracks,
  useYandexStatus,
} from '@/hooks/use-yandex';

const PLAYER_HEIGHT = 62;
const TAB_BAR = Platform.OS === 'web' ? 84 : 50;

type Service = 'spotify' | 'yandex';
type SpotifyTab = 'liked' | 'playlists' | 'top';
type YandexTab = 'liked' | 'playlists';

function CatalogTrackRow({
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
          <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <MaterialIcons name="music" size={16} color={COLORS.textMuted} />
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
}

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
          <Image source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <MaterialIcons name="list" size={20} color={COLORS.textMuted} />
        )}
      </View>
      <Text style={styles.playlistName} numberOfLines={2}>{name}</Text>
      <Text style={styles.playlistCount}>{trackCount} tracks</Text>
    </Pressable>
  );
}

function SpotifySection({ onVariants }: { onVariants: (artist: string, title: string) => void }) {
  const { data: status } = useSpotifyStatus();
  const login = useSpotifyLogin();
  const logout = useSpotifyLogout();
  const [tab, setTab] = useState<SpotifyTab>('liked');
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [likedPage, setLikedPage] = useState(0);

  const likedQuery = useSpotifyLiked(likedPage);
  const playlistsQuery = useSpotifyPlaylists();
  const topQuery = useSpotifyTopTracks();
  const playlistTracksQuery = useSpotifyPlaylistTracks(selectedPlaylist?.id ?? null, 0);

  if (!status?.connected) {
    return (
      <View style={styles.connectPrompt}>
        <View style={[styles.serviceIconBig, { backgroundColor: COLORS.spotifyBg }]}>
          <MaterialIcons name="music" size={32} color={COLORS.spotifyGreen} />
        </View>
        <Text style={styles.connectTitle}>Connect Spotify</Text>
        <Text style={styles.connectText}>Browse your liked songs, playlists and top tracks</Text>
        <Pressable
          style={[styles.connectBtn, { backgroundColor: COLORS.spotifyGreen }]}
          onPress={() => login.mutate()}
          disabled={login.isPending}
        >
          {login.isPending ? (
            <ActivityIndicator size="small" color={COLORS.white} />
          ) : (
            <Text style={styles.connectBtnText}>Connect with Spotify</Text>
          )}
        </Pressable>
        <Text style={styles.connectNote}>Read-only · we never modify your library</Text>
      </View>
    );
  }

  const tabs: { id: SpotifyTab; label: string }[] = [
    { id: 'liked', label: 'Liked' },
    { id: 'playlists', label: 'Playlists' },
    { id: 'top', label: 'Top Tracks' },
  ];

  const renderLiked = () => {
    if (!likedQuery.data && !likedQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => likedQuery.refetch()}>
            <Text style={styles.loadBtnText}>Load liked songs</Text>
          </Pressable>
        </View>
      );
    }
    if (likedQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    const tracks = likedQuery.data?.tracks ?? [];
    return (
      <>
        {tracks.map((t) => (
          <CatalogTrackRow
            key={t.id}
            title={t.title}
            artist={t.artist}
            thumbnailUrl={t.thumbnailUrl}
            onFindVariants={() => onVariants(t.artist, t.title)}
          />
        ))}
        {(likedQuery.data?.hasMore || likedPage > 0) && (
          <View style={styles.pagination}>
            {likedPage > 0 && (
              <Pressable style={styles.pageBtn} onPress={() => setLikedPage((p) => p - 1)}>
                <MaterialIcons name="chevron-left" size={16} color={COLORS.text} />
                <Text style={styles.pageBtnText}>Prev</Text>
              </Pressable>
            )}
            {likedQuery.data?.hasMore && (
              <Pressable style={styles.pageBtn} onPress={() => setLikedPage((p) => p + 1)}>
                <Text style={styles.pageBtnText}>Next</Text>
                <MaterialIcons name="chevron-right" size={16} color={COLORS.text} />
              </Pressable>
            )}
          </View>
        )}
      </>
    );
  };

  const renderPlaylists = () => {
    if (selectedPlaylist) {
      return (
        <>
          <Pressable style={styles.backBtn} onPress={() => setSelectedPlaylist(null)}>
            <MaterialIcons name="arrow-left" size={16} color={COLORS.text} />
            <Text style={styles.backBtnText}>{selectedPlaylist.name}</Text>
          </Pressable>
          {playlistTracksQuery.isFetching ? (
            <ActivityIndicator style={styles.loader} color={COLORS.accent} />
          ) : (
            (playlistTracksQuery.data?.tracks ?? []).map((t) => (
              <CatalogTrackRow
                key={t.id}
                title={t.title}
                artist={t.artist}
                thumbnailUrl={t.thumbnailUrl}
                onFindVariants={() => onVariants(t.artist, t.title)}
              />
            ))
          )}
        </>
      );
    }

    if (!playlistsQuery.data && !playlistsQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => playlistsQuery.refetch()}>
            <Text style={styles.loadBtnText}>Load playlists</Text>
          </Pressable>
        </View>
      );
    }
    if (playlistsQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    const playlists = playlistsQuery.data?.playlists ?? [];
    return (
      <View style={styles.playlistGrid}>
        {playlists.map((pl) => (
          <PlaylistCard
            key={pl.id}
            name={pl.name}
            trackCount={pl.trackCount}
            thumbnailUrl={pl.thumbnailUrl}
            onPress={() => setSelectedPlaylist(pl)}
          />
        ))}
      </View>
    );
  };

  const renderTop = () => {
    if (!topQuery.data && !topQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => topQuery.refetch()}>
            <Text style={styles.loadBtnText}>Load top tracks</Text>
          </Pressable>
        </View>
      );
    }
    if (topQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    return (
      <>
        {(topQuery.data?.tracks ?? []).map((t) => (
          <CatalogTrackRow
            key={t.id}
            title={t.title}
            artist={t.artist}
            thumbnailUrl={t.thumbnailUrl}
            onFindVariants={() => onVariants(t.artist, t.title)}
          />
        ))}
      </>
    );
  };

  return (
    <View>
      <View style={styles.connectedHeader}>
        <View style={styles.connectedInfo}>
          <View style={[styles.serviceIcon, { backgroundColor: COLORS.spotifyBg }]}>
            <MaterialIcons name="music" size={16} color={COLORS.spotifyGreen} />
          </View>
          <Text style={styles.connectedName}>{status.displayName ?? 'Spotify'}</Text>
        </View>
        <Pressable onPress={() => logout.mutate()} style={styles.disconnectBtn}>
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.tabChip, tab === t.id && styles.tabChipActive]}
            onPress={() => { setTab(t.id); Haptics.selectionAsync(); }}
          >
            <Text style={[styles.tabChipText, tab === t.id && styles.tabChipTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {tab === 'liked' && renderLiked()}
      {tab === 'playlists' && renderPlaylists()}
      {tab === 'top' && renderTop()}
    </View>
  );
}

function YandexSection({ onVariants }: { onVariants: (artist: string, title: string) => void }) {
  const { data: status } = useYandexStatus();
  const connect = useYandexConnect();
  const disconnect = useYandexDisconnect();
  const [tab, setTab] = useState<YandexTab>('liked');
  const [token, setToken] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<YandexPlaylist | null>(null);

  const likedQuery = useYandexLiked(0);
  const playlistsQuery = useYandexPlaylists();
  const playlistTracksQuery = useYandexPlaylistTracks(
    selectedPlaylist?.uid ?? null,
    selectedPlaylist?.kind ?? null,
  );

  if (!status?.connected) {
    return (
      <View style={styles.connectPrompt}>
        <View style={[styles.serviceIconBig, { backgroundColor: COLORS.yandexBg }]}>
          <MaterialIcons name="headphones" size={32} color={COLORS.yandexYellow} />
        </View>
        <Text style={styles.connectTitle}>Connect Yandex Music</Text>
        <Text style={styles.connectText}>
          Get your OAuth token from oauth.yandex.ru and paste it below
        </Text>
        {showTokenInput ? (
          <View style={styles.tokenInputWrap}>
            <TextInput
              style={styles.tokenInput}
              value={token}
              onChangeText={setToken}
              placeholder="Paste OAuth token"
              placeholderTextColor={COLORS.textMuted}
              multiline
              selectionColor={COLORS.yandexYellow}
            />
            <Pressable
              style={[styles.connectBtn, { backgroundColor: COLORS.yandexYellow }, !token.trim() && styles.btnDisabled]}
              onPress={async () => {
                if (!token.trim()) return;
                await connect.mutateAsync(token.trim());
              }}
              disabled={!token.trim() || connect.isPending}
            >
              {connect.isPending ? (
                <ActivityIndicator size="small" color={COLORS.black} />
              ) : (
                <Text style={[styles.connectBtnText, { color: COLORS.black }]}>Connect</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={[styles.connectBtn, { backgroundColor: COLORS.yandexYellow }]}
            onPress={() => setShowTokenInput(true)}
          >
            <Text style={[styles.connectBtnText, { color: COLORS.black }]}>Enter Token</Text>
          </Pressable>
        )}
        {connect.isError && (
          <Text style={styles.errorMsg}>Invalid token. Please try again.</Text>
        )}
      </View>
    );
  }

  const tabs: { id: YandexTab; label: string }[] = [
    { id: 'liked', label: 'Liked' },
    { id: 'playlists', label: 'Playlists' },
  ];

  const renderLiked = () => {
    if (!likedQuery.data && !likedQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => likedQuery.refetch()}>
            <Text style={styles.loadBtnText}>Load liked tracks</Text>
          </Pressable>
        </View>
      );
    }
    if (likedQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    return (likedQuery.data?.tracks ?? []).map((t) => (
      <CatalogTrackRow
        key={t.id}
        title={t.title}
        artist={t.artist}
        thumbnailUrl={t.thumbnailUrl}
        onFindVariants={() => onVariants(t.artist, t.title)}
      />
    ));
  };

  const renderPlaylists = () => {
    if (selectedPlaylist) {
      return (
        <>
          <Pressable style={styles.backBtn} onPress={() => setSelectedPlaylist(null)}>
            <MaterialIcons name="arrow-left" size={16} color={COLORS.text} />
            <Text style={styles.backBtnText}>{selectedPlaylist.title}</Text>
          </Pressable>
          {playlistTracksQuery.isFetching ? (
            <ActivityIndicator style={styles.loader} color={COLORS.accent} />
          ) : (
            (playlistTracksQuery.data?.tracks ?? []).map((t) => (
              <CatalogTrackRow
                key={t.id}
                title={t.title}
                artist={t.artist}
                thumbnailUrl={t.thumbnailUrl}
                onFindVariants={() => onVariants(t.artist, t.title)}
              />
            ))
          )}
        </>
      );
    }

    if (!playlistsQuery.data && !playlistsQuery.isFetching) {
      return (
        <View style={styles.fetchPrompt}>
          <Pressable style={styles.loadBtn} onPress={() => playlistsQuery.refetch()}>
            <Text style={styles.loadBtnText}>Load playlists</Text>
          </Pressable>
        </View>
      );
    }
    if (playlistsQuery.isFetching) return <ActivityIndicator style={styles.loader} color={COLORS.accent} />;
    const playlists = playlistsQuery.data?.playlists ?? [];
    return (
      <View style={styles.playlistGrid}>
        {playlists.map((pl) => (
          <PlaylistCard
            key={`${pl.uid}_${pl.kind}`}
            name={pl.title}
            trackCount={pl.trackCount}
            thumbnailUrl={pl.thumbnailUrl}
            onPress={() => setSelectedPlaylist(pl)}
          />
        ))}
      </View>
    );
  };

  return (
    <View>
      <View style={styles.connectedHeader}>
        <View style={styles.connectedInfo}>
          <View style={[styles.serviceIcon, { backgroundColor: COLORS.yandexBg }]}>
            <MaterialIcons name="headphones" size={16} color={COLORS.yandexYellow} />
          </View>
          <Text style={styles.connectedName}>{status.login ?? 'Yandex Music'}</Text>
        </View>
        <Pressable onPress={() => disconnect.mutate()} style={styles.disconnectBtn}>
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
        {tabs.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.tabChip, tab === t.id && styles.tabChipActive]}
            onPress={() => { setTab(t.id); Haptics.selectionAsync(); }}
          >
            <Text style={[styles.tabChipText, tab === t.id && styles.tabChipTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {tab === 'liked' && renderLiked()}
      {tab === 'playlists' && renderPlaylists()}
    </View>
  );
}

export default function FavoritesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { currentTrack } = usePlayer();
  const [service, setService] = useState<Service>('spotify');

  const topPad = insets.top + (Platform.OS === 'web' ? 67 : 0);
  const bottomPad = TAB_BAR + (currentTrack ? PLAYER_HEIGHT : 0) + (Platform.OS === 'web' ? 34 : 0);

  const handleFindVariants = (artist: string, title: string) => {
    router.navigate({
      pathname: '/',
      params: { artist, title },
    });
  };

  return (
    <View style={[styles.root, { backgroundColor: COLORS.bg }]}>
      <View style={[styles.header, { paddingTop: topPad }]}>
        <View style={styles.headerRow}>
          <MaterialIcons name="heart" size={22} color={COLORS.accent} />
          <Text style={styles.headerTitle}>Favorites</Text>
        </View>
        <Text style={styles.headerSub}>Find variants of your saved tracks</Text>
      </View>

      <View style={styles.serviceSwitcher}>
        {(['spotify', 'yandex'] as Service[]).map((s) => (
          <Pressable
            key={s}
            style={[styles.serviceTab, service === s && styles.serviceTabActive]}
            onPress={() => { setService(s); Haptics.selectionAsync(); }}
          >
            <Feather
              name={s === 'spotify' ? 'music' : 'headphones'}
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
              {s === 'spotify' ? 'Spotify' : 'Yandex Music'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {service === 'spotify' ? (
          <SpotifySection onVariants={handleFindVariants} />
        ) : (
          <YandexSection onVariants={handleFindVariants} />
        )}
      </ScrollView>
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
  pagination: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 16,
  },
  pageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pageBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
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
});
