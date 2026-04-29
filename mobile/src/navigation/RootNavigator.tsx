import React from 'react'
import { View, StyleSheet } from 'react-native'
import { NavigationContainer, DefaultTheme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import type { RootStackParamList, RootTabParamList } from '@/types'
import { SongsView } from '@/views/SongsView'
import { AlbumsView } from '@/views/AlbumsView'
import { ArtistsView } from '@/views/ArtistsView'
import { PlaylistsView } from '@/views/PlaylistsView'
import { SettingsView } from '@/views/SettingsView'
import { AlbumDetailView } from '@/views/AlbumDetailView'
import { ArtistDetailView } from '@/views/ArtistDetailView'
import { PlaylistDetailView } from '@/views/PlaylistDetailView'
import { NowPlayingView } from '@/views/NowPlayingView'
import { ConnectionView } from '@/views/ConnectionView'
import { MiniPlayer } from '@/components/MiniPlayer'
import { colors } from '@/styles/theme'

const Tab = createBottomTabNavigator<RootTabParamList>()
const Stack = createNativeStackNavigator<RootStackParamList>()

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bgElevated,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
}

function Tabs() {
  return (
    <View style={styles.tabsRoot}>
      <View style={styles.tabsContent}>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarStyle: {
              backgroundColor: colors.bgElevated,
              borderTopColor: colors.border,
            },
            tabBarActiveTintColor: colors.accent,
            tabBarInactiveTintColor: colors.textDim,
          }}
        >
          <Tab.Screen name="Songs" component={SongsView} />
          <Tab.Screen name="Albums" component={AlbumsView} />
          <Tab.Screen name="Artists" component={ArtistsView} />
          <Tab.Screen name="Playlists" component={PlaylistsView} />
          <Tab.Screen name="Settings" component={SettingsView} />
        </Tab.Navigator>
      </View>
      <MiniPlayer />
    </View>
  )
}

export function RootNavigator() {
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.bgElevated },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="Album" component={AlbumDetailView} options={{ headerShown: false }} />
        <Stack.Screen name="Artist" component={ArtistDetailView} options={{ headerShown: false }} />
        <Stack.Screen name="Playlist" component={PlaylistDetailView} options={{ headerShown: false }} />
        <Stack.Screen
          name="NowPlaying"
          component={NowPlayingView}
          options={{ presentation: 'modal', headerShown: false }}
        />
        <Stack.Screen
          name="Connection"
          component={ConnectionView}
          options={{ presentation: 'modal', headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  )
}

const styles = StyleSheet.create({
  tabsRoot: { flex: 1 },
  tabsContent: { flex: 1 },
})
