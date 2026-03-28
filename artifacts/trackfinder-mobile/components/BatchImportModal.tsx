import { MaterialIcons } from '@/components/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS, SOURCE_COLORS, TYPE_COLORS } from '@/constants/colors';
import { useLibrary } from '@/hooks/use-library';
import { apiFetch } from '@/hooks/use-session';
import { Track } from '@/components/TrackCard';

export interface ImportTrackInput {
  artist: string;
  title: string;
  thumbnailUrl?: string | null;
}

interface BatchMatch {
  index: number;
  query: { artist: string; title: string };
  matches: Track[];
  bestScore: number;
  autoSelected: boolean;
}

interface BatchSearchResponse {
  results: BatchMatch[];
}

type PhaseType = 'idle' | 'searching' | 'review' | 'importing' | 'done';

const CHUNK_SIZE = 20;

interface Props {
  visible: boolean;
  tracks: ImportTrackInput[];
  onClose: () => void;
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#f59e0b';
  if (score >= 40) return '#f97316';
  return '#ef4444';
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ScoreBar({ score }: { score: number }) {
  const color = getScoreColor(score);
  return (
    <View style={styles.scoreBarWrap}>
      <View style={[styles.scoreBarFill, { width: `${score}%` as any, backgroundColor: color }]} />
      <Text style={[styles.scoreLabel, { color }]}>{Math.round(score)}%</Text>
    </View>
  );
}

function MatchRow({
  match,
  isSelected,
  onToggle,
}: {
  match: BatchMatch;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const best = match.matches[0];
  const hasResult = !!best;

  return (
    <Pressable
      style={[styles.matchRow, isSelected && hasResult && styles.matchRowSelected]}
      onPress={() => { if (hasResult) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onToggle(); } }}
    >
      <View style={styles.matchCheckbox}>
        {hasResult ? (
          <MaterialIcons
            name={isSelected ? 'check-circle' : 'close'}
            size={20}
            color={isSelected ? '#22c55e' : COLORS.textMuted}
          />
        ) : (
          <MaterialIcons name="error" size={20} color={COLORS.danger} />
        )}
      </View>

      <View style={styles.matchContent}>
        <Text style={styles.matchSource} numberOfLines={1}>
          {match.query.artist} — {match.query.title}
        </Text>

        {hasResult ? (
          <View style={styles.matchResult}>
            <View style={styles.matchThumb}>
              {best.thumbnailUrl ? (
                <Image source={{ uri: best.thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : (
                <MaterialIcons name="music-note" size={12} color={COLORS.textMuted} />
              )}
            </View>
            <View style={styles.matchInfo}>
              <Text style={styles.matchTitle} numberOfLines={1}>{best.title}</Text>
              <Text style={styles.matchArtist} numberOfLines={1}>{best.artist}</Text>
              <View style={styles.matchMeta}>
                {best.type && (
                  <View style={[styles.miniChip, { backgroundColor: TYPE_COLORS[best.type].bg }]}>
                    <Text style={[styles.miniChipText, { color: TYPE_COLORS[best.type].text }]}>{TYPE_COLORS[best.type].label}</Text>
                  </View>
                )}
                {best.source && (
                  <View style={[styles.miniChip, { backgroundColor: SOURCE_COLORS[best.source].bg }]}>
                    <Text style={[styles.miniChipText, { color: SOURCE_COLORS[best.source].text }]}>{SOURCE_COLORS[best.source].label}</Text>
                  </View>
                )}
                <Text style={styles.matchDur}>{formatDuration(best.duration)}</Text>
              </View>
            </View>
            <ScoreBar score={match.bestScore} />
          </View>
        ) : (
          <Text style={styles.noMatchText}>Совпадений не найдено</Text>
        )}
      </View>
    </Pressable>
  );
}

export function BatchImportModal({ visible, tracks, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { download, isSaved } = useLibrary();
  const [phase, setPhase] = useState<PhaseType>('idle');
  const [results, setResults] = useState<BatchMatch[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [searchProgress, setSearchProgress] = useState(0);
  const [importProgress, setImportProgress] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const [importErrors, setImportErrors] = useState(0);
  const abortRef = useRef(false);

  const startSearch = useCallback(async () => {
    if (!tracks.length) return;
    abortRef.current = false;
    setPhase('searching');
    setResults([]);
    setSelected(new Set());
    setSearchProgress(0);
    setImportErrors(0);

    const accumulated: BatchMatch[] = [];
    const autoSel = new Set<number>();

    for (let i = 0; i < tracks.length; i += CHUNK_SIZE) {
      if (abortRef.current) break;

      const chunk = tracks.slice(i, i + CHUNK_SIZE);
      const offsetIndex = i;

      try {
        const data = await apiFetch<BatchSearchResponse>('/tracks/batch-search', {
          method: 'POST',
          body: JSON.stringify({
            tracks: chunk.map(t => ({ artist: t.artist, title: t.title })),
          }),
        });

        if (abortRef.current) break;

        const shifted = data.results.map(r => ({
          ...r,
          index: r.index + offsetIndex,
        }));

        shifted.forEach(r => {
          if (r.autoSelected) autoSel.add(r.index);
        });
        accumulated.push(...shifted);
        setResults([...accumulated]);
        setSelected(new Set(autoSel));
      } catch {
        const fallback = chunk.map((t, ci) => ({
          index: offsetIndex + ci,
          query: { artist: t.artist, title: t.title },
          matches: [] as Track[],
          bestScore: 0,
          autoSelected: false,
        }));
        accumulated.push(...fallback);
        setResults([...accumulated]);
      }

      setSearchProgress(Math.min(i + CHUNK_SIZE, tracks.length));
    }

    if (!abortRef.current) {
      setPhase('review');
    }
  }, [tracks]);

  useEffect(() => {
    if (visible && phase === 'idle') {
      startSearch();
    }
    if (!visible) {
      abortRef.current = true;
      setPhase('idle');
      setResults([]);
      setSelected(new Set());
      setSearchProgress(0);
    }
  }, [visible]);

  const toggleSelect = (index: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => {
    const eligible = results.filter(r => r.matches.length > 0).map(r => r.index);
    setSelected(new Set(eligible));
  };

  const deselectAll = () => setSelected(new Set());

  const stopAndReview = () => {
    abortRef.current = true;
    setPhase('review');
  };

  const startImport = async () => {
    const toImport = results.filter(r => selected.has(r.index) && r.matches[0]);
    if (!toImport.length) return;

    setPhase('importing');
    setImportTotal(toImport.length);
    setImportProgress(0);
    setImportErrors(0);
    let errors = 0;

    for (const item of toImport) {
      if (abortRef.current) break;
      const best = item.matches[0];
      if (isSaved(best.id)) {
        setImportProgress(p => p + 1);
        continue;
      }
      try {
        await download(best);
      } catch {
        errors++;
      }
      setImportErrors(errors);
      setImportProgress(p => p + 1);
      await new Promise(r => setTimeout(r, 80));
    }

    setPhase('done');
  };

  const autoCount = results.filter(r => r.autoSelected && r.matches.length > 0).length;
  const noMatchCount = results.filter(r => r.matches.length === 0).length;
  const selectedCount = selected.size;
  const isSearching = phase === 'searching';
  const searchDone = searchProgress >= tracks.length;
  const progressPct = tracks.length > 0 ? (searchProgress / tracks.length) * 100 : 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <MaterialIcons name="library-add-check" size={22} color={COLORS.accent} />
            <Text style={styles.headerTitle}>Пакетный импорт</Text>
          </View>
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={12}>
            <MaterialIcons name="close" size={22} color={COLORS.textSub} />
          </Pressable>
        </View>

        {isSearching && results.length === 0 && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={styles.searchingText}>Поиск совпадений…</Text>
            <Text style={styles.searchingSub}>
              {searchProgress} из {tracks.length} треков
            </Text>
            <View style={styles.progressBarWrap}>
              <View style={[styles.progressBarFill, { width: `${progressPct}%` as any }]} />
            </View>
            <Pressable style={styles.cancelBtn} onPress={stopAndReview}>
              <Text style={styles.cancelBtnText}>Остановить и показать найденное</Text>
            </Pressable>
          </View>
        )}

        {(phase === 'review' || (isSearching && results.length > 0)) && (
          <>
            <View style={styles.statsRow}>
              <View style={styles.statChip}>
                <Text style={[styles.statNum, { color: '#22c55e' }]}>{autoCount}</Text>
                <Text style={styles.statLabel}>Авто</Text>
              </View>
              <View style={styles.statChip}>
                <Text style={[styles.statNum, { color: COLORS.accent }]}>{selectedCount}</Text>
                <Text style={styles.statLabel}>Выбрано</Text>
              </View>
              {noMatchCount > 0 && (
                <View style={styles.statChip}>
                  <Text style={[styles.statNum, { color: COLORS.danger }]}>{noMatchCount}</Text>
                  <Text style={styles.statLabel}>Не найдено</Text>
                </View>
              )}
              {isSearching && (
                <View style={[styles.statChip, { flex: 1 }]}>
                  <ActivityIndicator size="small" color={COLORS.accent} />
                  <Text style={styles.statLabel}>{searchProgress}/{tracks.length}</Text>
                </View>
              )}
            </View>

            {isSearching && (
              <View style={styles.searchingBanner}>
                <View style={styles.progressBarWrap}>
                  <View style={[styles.progressBarFill, { width: `${progressPct}%` as any }]} />
                </View>
                <View style={styles.searchingBannerRow}>
                  <Text style={styles.searchingBannerText}>
                    Обрабатывается {searchProgress} из {tracks.length}…
                  </Text>
                  <Pressable onPress={stopAndReview}>
                    <Text style={styles.stopText}>Стоп</Text>
                  </Pressable>
                </View>
              </View>
            )}

            <View style={styles.selectActions}>
              <Text style={styles.hintText}>≥80% — автовыбор. Нажмите для переключения.</Text>
              <View style={styles.selectBtns}>
                <Pressable style={styles.smallBtn} onPress={selectAll}>
                  <Text style={styles.smallBtnText}>Все</Text>
                </Pressable>
                <Pressable style={styles.smallBtn} onPress={deselectAll}>
                  <Text style={styles.smallBtnText}>Сброс</Text>
                </Pressable>
              </View>
            </View>

            <FlatList
              data={results}
              keyExtractor={item => String(item.index)}
              renderItem={({ item }) => (
                <MatchRow
                  match={item}
                  isSelected={selected.has(item.index)}
                  onToggle={() => toggleSelect(item.index)}
                />
              )}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
            />

            <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
              <Pressable
                style={[styles.importBtn, !selectedCount && styles.importBtnDisabled]}
                onPress={startImport}
                disabled={!selectedCount}
              >
                <MaterialIcons name="file-download" size={18} color={COLORS.white} />
                <Text style={styles.importBtnText}>
                  Скачать {selectedCount} {plural(selectedCount, 'трек', 'трека', 'треков')}
                </Text>
              </Pressable>
            </View>
          </>
        )}

        {phase === 'importing' && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={styles.searchingText}>
              Скачивание {importProgress} / {importTotal}
            </Text>
            <View style={styles.progressBarWrap}>
              <View style={[styles.progressBarFill, { width: `${importTotal ? (importProgress / importTotal) * 100 : 0}%` as any }]} />
            </View>
            {importErrors > 0 && (
              <Text style={styles.errorNote}>{importErrors} ошибок</Text>
            )}
          </View>
        )}

        {phase === 'done' && (
          <View style={styles.center}>
            <MaterialIcons name="check-circle" size={56} color="#22c55e" />
            <Text style={styles.doneTitle}>Импорт завершён</Text>
            <Text style={styles.doneSub}>
              {importProgress - importErrors} сохранено · {importErrors} ошибок
            </Text>
            <Pressable style={styles.doneBtn} onPress={onClose}>
              <Text style={styles.doneBtnText}>Готово</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  closeBtn: {
    padding: 4,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
  },
  searchingText: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
    textAlign: 'center',
  },
  searchingSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  cancelBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
  },
  cancelBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
  searchingBanner: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 6,
  },
  searchingBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  searchingBannerText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  stopText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.accent,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  statChip: {
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statNum: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  statLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  selectActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  hintText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
    flex: 1,
  },
  selectBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
  },
  smallBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textSub,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  matchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  matchRowSelected: {
    borderColor: '#22c55e55',
    backgroundColor: '#22c55e0a',
  },
  matchCheckbox: {
    paddingTop: 2,
  },
  matchContent: {
    flex: 1,
    gap: 6,
  },
  matchSource: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.textMuted,
  },
  matchResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  matchThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchInfo: {
    flex: 1,
    gap: 2,
  },
  matchTitle: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  matchArtist: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  matchMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  miniChip: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  miniChipText: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.3,
  },
  matchDur: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  noMatchText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.danger,
  },
  scoreBarWrap: {
    width: 52,
    height: 36,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 2,
  },
  scoreBarFill: {
    height: 3,
    borderRadius: 2,
    width: '100%',
  },
  scoreLabel: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
  },
  importBtnDisabled: {
    opacity: 0.4,
  },
  importBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: COLORS.white,
  },
  progressBarWrap: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
  errorNote: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.danger,
  },
  doneTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  doneSub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
  },
  doneBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 8,
  },
  doneBtnText: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
});
