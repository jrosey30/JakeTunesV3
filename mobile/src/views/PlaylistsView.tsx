import React from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useLibrary } from '@/context/LibraryContext'
import { EmptyState } from '@/components/EmptyState'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function PlaylistsView() {
  const { playlists } = useLibrary()
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()

  if (playlists.length === 0) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <ConnectionBanner />
        <EmptyState
          title="No playlists"
          subtitle="Playlists you build on the desktop will appear here after the next library refresh."
        />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ConnectionBanner />
      <FlatList
        data={playlists}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => nav.navigate('Playlist', { playlistId: item.id })}
          >
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.meta}>{item.trackIds.length} tracks</Text>
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
