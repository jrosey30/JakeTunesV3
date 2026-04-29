import React from 'react'
import { StatusBar } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ConnectionProvider } from '@/context/ConnectionContext'
import { LibraryProvider } from '@/context/LibraryContext'
import { PlaybackProvider } from '@/context/PlaybackContext'
import { RootNavigator } from '@/navigation/RootNavigator'
import { colors } from '@/styles/theme'

// Provider order matters:
//   ConnectionProvider must wrap LibraryProvider (library reads
//   client + state from connection).
//   LibraryProvider must wrap PlaybackProvider (queueAdapter needs
//   the connection's client + config; playback also reads track
//   metadata for media-session art / display).
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ConnectionProvider>
          <LibraryProvider>
            <PlaybackProvider>
              <RootNavigator />
            </PlaybackProvider>
          </LibraryProvider>
        </ConnectionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
