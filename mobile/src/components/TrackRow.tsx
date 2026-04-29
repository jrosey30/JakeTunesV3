import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Track } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'
import { formatDuration } from '@/utils/format'

interface Props {
  track: Track
  isActive?: boolean
  onPress: () => void
}

export function TrackRow({ track, isActive, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        isActive && styles.rowActive,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.text}>
        <Text style={[styles.title, isActive && styles.titleActive]} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {track.artist} — {track.album}
        </Text>
      </View>
      <Text style={styles.duration}>{formatDuration(track.duration)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowActive: { backgroundColor: colors.bgElevated },
  rowPressed: { backgroundColor: colors.bgSurface },
  text: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.medium,
  },
  titleActive: { color: colors.accent },
  subtitle: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
    marginTop: 2,
  },
  duration: {
    color: colors.textFaint,
    fontSize: typography.sizes.small,
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.md,
  },
})
