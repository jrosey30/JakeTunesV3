import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import { useLibrary } from '@/context/LibraryContext'
import { usePlayback } from '@/context/PlaybackContext'
import { EmptyState } from '@/components/EmptyState'
import { formatDuration } from '@/utils/format'
import { colors, radii, spacing, typography } from '@/styles/theme'

export function NowPlayingView() {
  const nav = useNavigation()
  const { tracks } = useLibrary()
  const {
    activeTrackId,
    isPlaying,
    position,
    duration,
    togglePlay,
    next,
    previous,
  } = usePlayback()

  const track = activeTrackId != null ? tracks.find((t) => t.id === activeTrackId) : undefined
  if (!track) return <EmptyState title="Nothing playing" subtitle="Pick a song to get started." />

  const progress = duration > 0 ? Math.min(1, position / duration) : 0

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} hitSlop={16}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.body}>
        <View style={styles.art} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>{track.title}</Text>
          <Text style={styles.artist} numberOfLines={1}>{track.artist}</Text>
          <Text style={styles.album} numberOfLines={1}>{track.album}</Text>
        </View>
        <View style={styles.scrubber}>
          <View style={styles.scrubTrack}>
            <View style={[styles.scrubFill, { width: `${progress * 100}%` }]} />
          </View>
          <View style={styles.scrubLabels}>
            {/* useProgress returns SECONDS; formatDuration takes MS.
                See queueAdapter.ts for the unit-contract note. */}
            <Text style={styles.scrubText}>{formatDuration(position * 1000)}</Text>
            <Text style={styles.scrubText}>-{formatDuration(Math.max(0, duration - position) * 1000)}</Text>
          </View>
        </View>
        <View style={styles.transport}>
          <Pressable onPress={previous} hitSlop={16}>
            <Text style={styles.glyph}>⏮</Text>
          </Pressable>
          <Pressable onPress={() => void togglePlay()} hitSlop={16} style={styles.playBtn}>
            <Text style={styles.playGlyph}>{isPlaying ? '❚❚' : '▶'}</Text>
          </Pressable>
          <Pressable onPress={next} hitSlop={16}>
            <Text style={styles.glyph}>⏭</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  close: { color: colors.textDim, fontSize: 22 },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xl },
  art: {
    width: 280,
    height: 280,
    borderRadius: radii.lg,
    backgroundColor: colors.bgSurface,
    marginBottom: spacing.xl,
  },
  text: { alignItems: 'center', marginBottom: spacing.xl },
  title: {
    color: colors.text,
    fontSize: typography.sizes.largeTitle,
    fontFamily: typography.headerFamily,
    fontWeight: typography.weights.bold,
    textAlign: 'center',
  },
  artist: {
    color: colors.text,
    fontSize: typography.sizes.body,
    marginTop: spacing.sm,
  },
  album: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
    marginTop: 2,
  },
  scrubber: { width: '100%', marginBottom: spacing.xl },
  scrubTrack: {
    height: 3,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  scrubFill: {
    height: '100%',
    backgroundColor: colors.accent,
  },
  scrubLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  scrubText: {
    color: colors.textFaint,
    fontSize: typography.sizes.caption,
    fontVariant: ['tabular-nums'],
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  glyph: {
    color: colors.text,
    fontSize: 28,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accentGlow,
    shadowOpacity: 1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
  },
  playGlyph: {
    color: '#fff',
    fontSize: 24,
    fontWeight: typography.weights.bold,
  },
})
