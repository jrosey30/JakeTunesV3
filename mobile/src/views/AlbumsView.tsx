import React, { useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useLibrary } from '@/context/LibraryContext'
import { groupByAlbum } from '@/utils/groupBy'
import { EmptyState } from '@/components/EmptyState'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import type { RootStackParamList } from '@/types'
import { colors, radii, spacing, typography } from '@/styles/theme'

const COLUMNS = 2

export function AlbumsView() {
  const { tracks } = useLibrary()
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const albums = useMemo(() => groupByAlbum(tracks), [tracks])

  if (albums.length === 0) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <ConnectionBanner />
        <EmptyState title="No albums" subtitle="Refresh the library after connecting to your NAS." />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ConnectionBanner />
      <FlatList
        data={albums}
        keyExtractor={(a) => a.key}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={styles.tile}
            onPress={() => nav.navigate('Album', { albumKey: item.key })}
          >
            <View style={styles.art} />
            <Text style={styles.album} numberOfLines={1}>{item.album}</Text>
            <Text style={styles.artist} numberOfLines={1}>{item.albumArtist}</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.md, paddingBottom: 80 },
  row: { gap: spacing.md, marginBottom: spacing.md },
  tile: { flex: 1 },
  art: {
    aspectRatio: 1,
    borderRadius: radii.md,
    backgroundColor: colors.bgSurface,
    marginBottom: spacing.sm,
  },
  album: {
    color: colors.text,
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  artist: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
  },
})
