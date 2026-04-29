import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '@/styles/theme'

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  title: {
    color: colors.text,
    fontFamily: typography.headerFamily,
    fontSize: typography.sizes.largeTitle,
    fontWeight: typography.weights.semibold,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textDim,
    fontSize: typography.sizes.body,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 22,
  },
})
