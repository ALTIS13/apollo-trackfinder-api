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

// MaterialIcons.ttf is checked into assets/fonts/ — same file as the one
// bundled by @expo/vector-icons@15, verified byte-for-byte.
// Using a LOCAL require() path means:
//   • No pnpm symlink traversal at Metro bundle time or EAS build time
//   • expo-font plugin (app.json) embeds the TTF as a native Android asset
//   • Font.loadAsync registers it under "MaterialIcons" before any icon renders
const MATERIAL_ICONS_FONT = {
  MaterialIcons: require('../assets/fonts/MaterialIcons.ttf'),
} as const;

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

  // Load MaterialIcons via Font.loadAsync — explicit, no hook magic.
  // Must complete before any <MaterialIcons> component can render.
  useEffect(() => {
    Font.loadAsync(MATERIAL_ICONS_FONT)
      .then(() => setIconsReady(true))
      .catch(() => {
        // If already loaded (e.g. Expo Go pre-bundles it), that's fine too.
        setIconsReady(true);
      });
  }, []);

  // Load Inter text fonts separately so an Inter failure never blocks icons.
  useEffect(() => {
    Font.loadAsync({
      Inter_400Regular,
      Inter_500Medium,
      Inter_600SemiBold,
      Inter_700Bold,
    })
      .then(() => setTextFontsReady(true))
      .catch(() => setTextFontsReady(true)); // fall through — app still usable
  }, []);

  useEffect(() => {
    if (iconsReady && textFontsReady) {
      SplashScreen.hideAsync();
    }
  }, [iconsReady, textFontsReady]);

  // Hard-block until MaterialIcons are loaded — icons must never render without the font.
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
