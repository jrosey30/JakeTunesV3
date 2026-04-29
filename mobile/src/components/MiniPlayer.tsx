import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { usePlayback } from '@/context/PlaybackContext'
import { useLibrary } from '@/context/LibraryContext'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function MiniPlayer() {
  const { activeTrackId, isPlaying, togglePlay, position, duration } = usePlayback()
  const { tracks } = useLibrary()
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const track = activeTrackId != null ? tracks.find((t) => t.id === activeTrackId) : undefined

  if (!track) return null

  const progress = duration > 0 ? Math.min(1, position / duration) : 0

  return (
    <Pressable
      style={styles.bar}
      onPress={() => nav.navigate('NowPlaying')}
      accessibilityLabel="Open Now Playing"
    >
      <View style={[styles.progress, { width: `${progress * 100}%` }]} />
      <View style={styles.body}>
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>{track.title}</Text>
          <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
        </View>
        <Pressable
          onPress={(e) => {
            e.stopPropagation()
            void togglePlay()
          }}
          hitSlop={12}
          style={styles.playBtn}
          accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
        >
          <Text style={styles.playGlyph}>{isPlaying ? '❚❚' : '▶'}</Text>
        </Pressable>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bgElevated,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  progress: {
    height: 2,
    backgroundColor: colors.accent,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  artist: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
    marginTop: 1,
  },
  playBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.md,
  },
  playGlyph: {
    color: '#fff',
    fontSize: 14,
    fontWeight: typography.weights.bold,
  },
})
