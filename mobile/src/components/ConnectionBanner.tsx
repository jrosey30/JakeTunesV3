import React from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useConnection } from '@/context/ConnectionContext'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function ConnectionBanner() {
  const { state, config } = useConnection()
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()

  if (state.status === 'connected') return null

  const message = (() => {
    if (!config) return 'Tap to connect to your Synology'
    if (state.status === 'connecting') return `Connecting to ${config.host}…`
    if (state.status === 'error') return `Connection failed: ${state.message}`
    return `Disconnected from ${config.host}`
  })()

  return (
    <Pressable style={styles.banner} onPress={() => nav.navigate('Connection')}>
      <Text style={styles.text}>{message}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.bgSurface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  text: {
    color: colors.textDim,
    fontSize: typography.sizes.small,
    textAlign: 'center',
  },
})
