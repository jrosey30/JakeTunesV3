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

export function PlaylistDetailView() {
  const route = useRoute<RouteProp<RootStackParamList, 'Playlist'>>()
  const { tracks, playlists } = useLibrary()
  const { activeTrackId, playTracks } = usePlayback()

  const playlist = playlists.find((p) => p.id === route.params.playlistId)

  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    const byId = new Map(tracks.map((t) => [t.id, t]))
    // Preserve playlist ordering — do NOT re-sort.
    return playlist.trackIds.map((id) => byId.get(id)).filter((t): t is typeof tracks[number] => Boolean(t))
  }, [playlist, tracks])

  if (!playlist) return <EmptyState title="Playlist not found" />
  if (playlistTracks.length === 0) {
    return <EmptyState title="Empty playlist" subtitle="Add tracks on the desktop." />
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.name}>{playlist.name}</Text>
        {playlist.commentary ? (
          <Text style={styles.commentary}>{playlist.commentary}</Text>
        ) : null}
      </View>
      <FlatList
        data={playlistTracks}
        keyExtractor={(t, i) => `${t.id}-${i}`}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            isActive={item.id === activeTrackId}
            onPress={() => void playTracks(playlistTracks, index)}
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
  commentary: {
    color: colors.textDim,
    fontSize: typography.sizes.body,
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  list: { paddingBottom: 80 },
})
