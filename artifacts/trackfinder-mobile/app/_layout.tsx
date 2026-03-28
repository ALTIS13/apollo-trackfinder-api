import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setBaseUrl } from '@workspace/api-client-react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  // Load MaterialIcons explicitly before any icon component renders.
  // On Android with pnpm, Metro cannot follow the virtual-store symlinks to
  // resolve @expo/vector-icons' bundled font. We point Metro at the package
  // path directly; metro.config.js has unstable_enableSymlinks:true so this
  // resolves correctly. The local assets/fonts/MaterialIcons.ttf is kept as
  // a fallback reference (same bytes, same version as @expo/vector-icons@15).
  const [iconsLoaded] = useFonts({
    MaterialIcons: require('@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.ttf'),
  });

  const [textFontsLoaded, textFontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    initSession();
  }, []);

  useEffect(() => {
    // Hide splash once text fonts and icons are both ready (or have errored).
    if ((textFontsLoaded || textFontError) && iconsLoaded !== false) {
      SplashScreen.hideAsync();
    }
  }, [textFontsLoaded, textFontError, iconsLoaded]);

  // Block render until MaterialIcons are confirmed loaded.
  // Text fonts use the same guard; if they error we still show the app.
  if (!iconsLoaded || (!textFontsLoaded && !textFontError)) return null;

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
