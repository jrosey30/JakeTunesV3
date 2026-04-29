import React, { useMemo } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RouteProp } from '@react-navigation/native'
import { useRoute } from '@react-navigation/native'
import { useLibrary } from '@/context/LibraryContext'
import { usePlayback } from '@/context/PlaybackContext'
import { TrackRow } from '@/components/TrackRow'
import { EmptyState } from '@/components/EmptyState'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function ArtistDetailView() {
  const route = useRoute<RouteProp<RootStackParamList, 'Artist'>>()
  const { tracks } = useLibrary()
  const { activeTrackId, playTracks } = usePlayback()

  const artistTracks = useMemo(() => {
    return tracks
      .filter((t) => (t.albumArtist || t.artist) === route.params.artistName)
      .sort(
        (a, b) =>
          a.album.localeCompare(b.album) ||
          Number(a.trackNumber || 0) - Number(b.trackNumber || 0),
      )
  }, [tracks, route.params.artistName])

  if (artistTracks.length === 0) {
    return <EmptyState title="No tracks for this artist" />
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.name}>{route.params.artistName}</Text>
      </View>
      <FlatList
        data={artistTracks}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            isActive={item.id === activeTrackId}
            onPress={() => void playTracks(artistTracks, index)}
          />
        )}
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg },
  name: {
    color: colors.text,
    fontSize: typography.sizes.display,
    fontFamily: typography.headerFamily,
    fontWeight: typography.weights.bold,
  },
  list: { paddingBottom: 80 },
})
