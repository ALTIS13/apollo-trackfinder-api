import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, StyleSheet, View, useColorScheme } from 'react-native';

import { MiniPlayer } from '@/components/MiniPlayer';
import { COLORS } from '@/constants/colors';
import { usePlayer } from '@/hooks/use-player';

const PLAYER_HEIGHT = 62;
const TAB_BAR_HEIGHT_NATIVE = 50;
const TAB_BAR_HEIGHT_WEB = 84;

export const BOTTOM_OFFSET_FOR_PLAYER = PLAYER_HEIGHT;

function PlayerAwareTabLayout() {
  const { currentTrack } = usePlayer();
  const isWeb = Platform.OS === 'web';
  const tabBarHeight = isWeb ? TAB_BAR_HEIGHT_WEB : TAB_BAR_HEIGHT_NATIVE;

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: COLORS.accent,
          tabBarInactiveTintColor: COLORS.textMuted,
          tabBarStyle: {
            position: 'absolute',
            backgroundColor: Platform.OS === 'ios' ? 'transparent' : COLORS.surface,
            borderTopWidth: 1,
            borderTopColor: COLORS.border,
            elevation: 0,
            height: tabBarHeight,
            paddingBottom: isWeb ? 34 : 4,
          },
          tabBarBackground: () =>
            Platform.OS === 'ios' ? (
              <BlurView
                intensity={90}
                tint="dark"
                style={StyleSheet.absoluteFill}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: COLORS.surface }]} />
            ),
          tabBarLabelStyle: {
            fontFamily: 'Inter_500Medium',
            fontSize: 11,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Search',
            tabBarIcon: ({ color, size }) => <MaterialIcons name="search" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="library"
          options={{
            title: 'Library',
            tabBarIcon: ({ color, size }) => <MaterialIcons name="download" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{
            title: 'Favorites',
            tabBarIcon: ({ color, size }) => <MaterialIcons name="heart" size={size} color={color} />,
          }}
        />
      </Tabs>
      {currentTrack && (
        <View style={[styles.playerWrap, { bottom: tabBarHeight }]}>
          <MiniPlayer />
        </View>
      )}
    </View>
  );
}

export default function TabLayout() {
  return <PlayerAwareTabLayout />;
}

const styles = StyleSheet.create({
  playerWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});
