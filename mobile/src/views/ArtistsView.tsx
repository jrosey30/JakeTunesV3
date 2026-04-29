import React, { useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useLibrary } from '@/context/LibraryContext'
import { groupByArtist } from '@/utils/groupBy'
import { EmptyState } from '@/components/EmptyState'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function ArtistsView() {
  const { tracks } = useLibrary()
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const artists = useMemo(() => groupByArtist(tracks), [tracks])

  if (artists.length === 0) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <ConnectionBanner />
        <EmptyState title="No artists" subtitle="Refresh the library after connecting." />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ConnectionBanner />
      <FlatList
        data={artists}
        keyExtractor={(a) => a.artist}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => nav.navigate('Artist', { artistName: item.artist })}
          >
            <Text style={styles.name}>{item.artist}</Text>
            <Text style={styles.meta}>
              {item.albumCount} album{item.albumCount === 1 ? '' : 's'} · {item.trackCount} song{item.trackCount === 1 ? '' : 's'}
            </Text>
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        contentContainerStyle={styles.list}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { paddingBottom: 80 },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.lg },
  name: {
    color: colors.text,
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.medium,
  },
  meta: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
    marginTop: 2,
  },
})
