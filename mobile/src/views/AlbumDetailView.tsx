import React, { useMemo } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RouteProp } from '@react-navigation/native'
import { useRoute } from '@react-navigation/native'
import { useLibrary } from '@/context/LibraryContext'
import { usePlayback } from '@/context/PlaybackContext'
import { albumKey } from '@/utils/groupBy'
import { TrackRow } from '@/components/TrackRow'
import { EmptyState } from '@/components/EmptyState'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function AlbumDetailView() {
  const route = useRoute<RouteProp<RootStackParamList, 'Album'>>()
  const { tracks } = useLibrary()
  const { activeTrackId, playTracks } = usePlayback()

  const album = useMemo(() => {
    const matched = tracks.filter((t) => albumKey(t) === route.params.albumKey)
    matched.sort((a, b) => Number(a.trackNumber || 0) - Number(b.trackNumber || 0))
    return matched
  }, [tracks, route.params.albumKey])

  if (album.length === 0) {
    return <EmptyState title="Album not found" />
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.art} />
        <Text style={styles.album} numberOfLines={2}>{album[0].album}</Text>
        <Text style={styles.artist} numberOfLines={1}>{album[0].albumArtist || album[0].artist}</Text>
      </View>
      <FlatList
        data={album}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item, index }) => (
          <TrackRow
            track={item}
            isActive={item.id === activeTrackId}
            onPress={() => void playTracks(album, index)}
          />
        )}
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { alignItems: 'center', padding: spacing.xl },
  art: {
    width: 200,
    height: 200,
    backgroundColor: colors.bgSurface,
    borderRadius: 12,
    marginBottom: spacing.lg,
  },
  album: {
    color: colors.text,
    fontSize: typography.sizes.largeTitle,
    fontFamily: typography.headerFamily,
    fontWeight: typography.weights.bold,
    textAlign: 'center',
  },
  artist: {
    color: colors.textDim,
    fontSize: typography.sizes.body,
    marginTop: spacing.xs,
  },
  list: { paddingBottom: 80 },
})
