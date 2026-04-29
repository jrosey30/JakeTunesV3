import React, { useMemo } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLibrary } from '@/context/LibraryContext'
import { usePlayback } from '@/context/PlaybackContext'
import { TrackRow } from '@/components/TrackRow'
import { EmptyState } from '@/components/EmptyState'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { colors } from '@/styles/theme'

export function SongsView() {
  const { tracks } = useLibrary()
  const { activeTrackId, playTracks } = usePlayback()

  const sorted = useMemo(
    () => [...tracks].sort((a, b) => a.title.localeCompare(b.title)),
    [tracks],
  )

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ConnectionBanner />
      {sorted.length === 0 ? (
        <EmptyState
          title="No songs yet"
          subtitle="Connect to your Synology in Settings → NAS, then refresh the library."
        />
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(t) => String(t.id)}
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              isActive={item.id === activeTrackId}
              onPress={() => void playTracks(sorted, index)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { paddingBottom: 80 },
  sep: { height: 0 },
})
