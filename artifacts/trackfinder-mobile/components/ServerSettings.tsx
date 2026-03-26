import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '@/constants/colors';
import {
  getConfiguredApiUrl,
  resetApiUrl,
  setApiUrl,
  testServerConnection,
} from '@/hooks/use-session';

interface Props {
  visible: boolean;
  onClose: () => void;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

export function ServerSettings({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState('');
  const [testState, setTestState] = useState<TestState>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setUrl(getConfiguredApiUrl().replace(/\/api$/, ''));
      setTestState('idle');
      setTestMsg('');
    }
  }, [visible]);

  const handleTest = async () => {
    if (!url.trim()) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTestState('testing');
    setTestMsg('');
    const result = await testServerConnection(url);
    setTestState(result.ok ? 'ok' : 'fail');
    setTestMsg(result.message);
  };

  const handleSave = async () => {
    if (!url.trim()) return;
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setApiUrl(url);
    setSaving(false);
    onClose();
  };

  const handleReset = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await resetApiUrl();
    setUrl(getConfiguredApiUrl().replace(/\/api$/, ''));
    setTestState('idle');
    setTestMsg('');
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
        <View style={styles.overlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.kav}
          >
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
              <View style={styles.handle} />

              <View style={styles.header}>
                <View style={styles.headerLeft}>
                  <MaterialIcons name="dns" size={20} color={COLORS.accent} />
                  <Text style={styles.title}>API Server</Text>
                </View>
                <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={12}>
                  <MaterialIcons name="close" size={20} color={COLORS.textSub} />
                </Pressable>
              </View>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.body}
              >
                <Text style={styles.sectionTitle}>Server URL</Text>
                <Text style={styles.sectionDesc}>
                  Enter the URL of your Apollo TrackFinder API server. This lets you run the backend on your own machine or cloud, completely independent of Replit.
                </Text>

                <View style={styles.inputRow}>
                  <TextInput
                    style={[styles.input, testState === 'ok' && styles.inputOk, testState === 'fail' && styles.inputFail]}
                    value={url}
                    onChangeText={(v) => { setUrl(v); setTestState('idle'); }}
                    placeholder="http://your-server.com"
                    placeholderTextColor={COLORS.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    selectionColor={COLORS.accent}
                    returnKeyType="done"
                  />
                </View>

                {testMsg !== '' && (
                  <View style={[styles.testResult, testState === 'ok' ? styles.testOk : styles.testFail]}>
                    <MaterialIcons
                      name={testState === 'ok' ? 'check-circle' : 'error'}
                      size={14}
                      color={testState === 'ok' ? COLORS.accent : COLORS.danger}
                    />
                    <Text style={[styles.testMsg, { color: testState === 'ok' ? COLORS.accent : COLORS.danger }]}>
                      {testMsg}
                    </Text>
                  </View>
                )}

                <View style={styles.btnRow}>
                  <Pressable
                    style={[styles.btn, styles.btnOutline]}
                    onPress={handleTest}
                    disabled={testState === 'testing' || !url.trim()}
                  >
                    {testState === 'testing' ? (
                      <ActivityIndicator size="small" color={COLORS.text} />
                    ) : (
                      <>
                        <MaterialIcons name="wifi" size={15} color={COLORS.text} />
                        <Text style={styles.btnOutlineText}>Test connection</Text>
                      </>
                    )}
                  </Pressable>

                  <Pressable
                    style={[styles.btn, styles.btnPrimary, !url.trim() && styles.btnDisabled]}
                    onPress={handleSave}
                    disabled={!url.trim() || saving}
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color={COLORS.white} />
                    ) : (
                      <Text style={styles.btnPrimaryText}>Save & use</Text>
                    )}
                  </Pressable>
                </View>

                <Pressable style={styles.resetRow} onPress={handleReset}>
                  <MaterialIcons name="refresh" size={13} color={COLORS.textMuted} />
                  <Text style={styles.resetText}>Reset to Replit default</Text>
                </Pressable>

                <View style={styles.divider} />

                <Text style={styles.sectionTitle}>Self-host the backend</Text>
                <Text style={styles.sectionDesc}>
                  Run the backend on your own server with Docker — no Replit required:
                </Text>

                <View style={styles.codeBlock}>
                  <Text style={styles.code}>
                    {'# 1. Clone & start\ngit clone <your-repo>\ncd <repo-dir>\n\ndocker-compose up -d\n\n# 2. The API is now at\nhttp://localhost:8080/api'}
                  </Text>
                </View>

                <Text style={styles.sectionDesc}>
                  Free cloud options: Railway, Render, Fly.io — each takes ~2 minutes to deploy. The backend needs one environment variable: DATABASE_URL (PostgreSQL).
                </Text>

                <View style={styles.cloudLinks}>
                  {[
                    { label: 'Railway', url: 'https://railway.app', icon: 'bolt' as const },
                    { label: 'Render', url: 'https://render.com', icon: 'cloud' as const },
                    { label: 'Fly.io', url: 'https://fly.io', icon: 'public' as const },
                  ].map((item) => (
                    <Pressable
                      key={item.label}
                      style={styles.cloudLink}
                      onPress={() => Linking.openURL(item.url)}
                    >
                      <MaterialIcons name={item.icon} size={13} color={COLORS.accent} />
                      <Text style={styles.cloudLinkText}>{item.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  kav: {
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    maxHeight: '90%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.borderLight,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: COLORS.card,
  },
  body: {
    padding: 20,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.text,
    marginBottom: 2,
  },
  sectionDesc: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textSub,
    lineHeight: 19,
  },
  inputRow: {
    marginTop: 4,
  },
  input: {
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: COLORS.text,
  },
  inputOk: {
    borderColor: COLORS.accent + '70',
    backgroundColor: COLORS.accentDim,
  },
  inputFail: {
    borderColor: COLORS.danger + '70',
    backgroundColor: COLORS.dangerBg,
  },
  testResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: -4,
  },
  testOk: { backgroundColor: COLORS.accentDim },
  testFail: { backgroundColor: COLORS.dangerBg },
  testMsg: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 10,
  },
  btnOutline: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  btnOutlineText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
  btnPrimary: {
    backgroundColor: COLORS.accent,
  },
  btnPrimaryText: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    color: COLORS.white,
  },
  btnDisabled: { opacity: 0.4 },
  resetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  resetText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: COLORS.textMuted,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 6,
  },
  codeBlock: {
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  code: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    color: COLORS.accent,
    lineHeight: 18,
  },
  cloudLinks: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  cloudLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cloudLinkText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    color: COLORS.text,
  },
});
