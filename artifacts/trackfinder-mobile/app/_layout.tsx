import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import * as Font from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LibraryProvider } from '@/hooks/use-library';
import { PlayerProvider } from '@/hooks/use-player';
import { initSession } from '@/hooks/use-session';

if (process.env.EXPO_PUBLIC_DOMAIN) {
  setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
}

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
});

// On Android, @expo/vector-icons uses fontFamily='MaterialIcons' (filename without .ttf).
// The font must be registered under exactly this key before any icon renders.
//
// Root-cause: Replit's Metro proxy truncates large binary asset downloads (>~200 KB).
// MaterialIcons.ttf is 356 KB — the download gets cut short, Typeface.createFromFile()
// silently falls back to Roboto, and every icon renders as a tofu box □.
// Inter fonts (~75 KB each) are small enough to transfer cleanly, so text works fine.
//
// Fix: in dev / Expo Go, fetch the font from jsDelivr CDN (bypasses the Replit proxy).
// In production EAS builds, the expo-font plugin embeds the TTF as a native Android
// asset (android/app/src/main/assets/fonts/MaterialIcons.ttf) — local require() is fine.
const CDN_MATERIAL_ICONS_URI =
  'https://cdn.jsdelivr.net/npm/@expo/vector-icons@15.1.1/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.ttf';

const MATERIAL_ICONS_FONT = {
  // Key MUST be 'MaterialIcons' — that's the fontFamily Android resolves against.
  MaterialIcons: __DEV__
    ? ({ uri: CDN_MATERIAL_ICONS_URI } as const)
    : require('../assets/fonts/MaterialIcons.ttf'),
};

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [iconsReady, setIconsReady] = useState(false);
  const [textFontsReady, setTextFontsReady] = useState(false);

  useEffect(() => {
    initSession();
  }, []);

  // Load MaterialIcons explicitly — @expo/vector-icons does NOT auto-load fonts.
  // Hard requirement: this must resolve before any <MaterialIcons> renders.
  useEffect(() => {
    const alreadyLoaded = Font.isLoaded('MaterialIcons');
    if (alreadyLoaded) {
      console.log('[Font] MaterialIcons already loaded (pre-bundled by Expo Go)');
      setIconsReady(true);
      return;
    }

    console.log(
      '[Font] Loading MaterialIcons via',
      __DEV__ ? 'CDN (bypasses Replit proxy)' : 'local asset',
      'on', Platform.OS, '...'
    );
    Font.loadAsync(MATERIAL_ICONS_FONT)
      .then(() => {
        console.log('[Font] MaterialIcons loaded successfully ✓');
        setIconsReady(true);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // 'already loaded' is not a real failure — font is available.
        if (msg.includes('already loaded') || Font.isLoaded('MaterialIcons')) {
          console.log('[Font] MaterialIcons was already registered:', msg);
          setIconsReady(true);
        } else {
          console.error('[Font] MaterialIcons FAILED to load:', msg);
          // Still unblock so the app renders (icons will be broken, but app works).
          setIconsReady(true);
        }
      });
  }, []);

  // Load Inter text fonts separately — failure here must never block icons.
  useEffect(() => {
    Font.loadAsync({
      Inter_400Regular,
      Inter_500Medium,
      Inter_600SemiBold,
      Inter_700Bold,
    })
      .then(() => {
        console.log('[Font] Inter loaded successfully ✓');
        setTextFontsReady(true);
      })
      .catch((err: unknown) => {
        console.warn('[Font] Inter load error (non-fatal):', err);
        setTextFontsReady(true);
      });
  }, []);

  useEffect(() => {
    if (iconsReady && textFontsReady) {
      console.log('[Font] All fonts ready — hiding splash screen');
      SplashScreen.hideAsync();
    }
  }, [iconsReady, textFontsReady]);

  // Strict render gate: no icon component ever renders before the font is confirmed.
  if (!iconsReady || !textFontsReady) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <PlayerProvider>
                <LibraryProvider>
                  <RootLayoutNav />
                </LibraryProvider>
              </PlayerProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
