import React from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useConnection } from '@/context/ConnectionContext'
import { useLibrary } from '@/context/LibraryContext'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

export function SettingsView() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { state, config } = useConnection()
  const { tracks, lastRefreshedAt, refresh, loading } = useLibrary()

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.section}>NAS</Text>
        <Pressable style={styles.row} onPress={() => nav.navigate('Connection')}>
          <Text style={styles.label}>Synology</Text>
          <Text style={styles.value}>
            {config ? `${config.host} · ${state.status}` : 'Not configured'}
          </Text>
        </Pressable>

        <Text style={styles.section}>Library</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Tracks on device</Text>
          <Text style={styles.value}>{tracks.length.toLocaleString()}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Last refresh</Text>
          <Text style={styles.value}>
            {lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString() : 'Never'}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => void refresh()}
          disabled={loading}
        >
          <Text style={styles.buttonText}>{loading ? 'Refreshing…' : 'Refresh library'}</Text>
        </Pressable>

        <Text style={styles.section}>About</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Version</Text>
          <Text style={styles.value}>0.1.0 · Phase 0</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, paddingBottom: 80 },
  section: {
    color: colors.textFaint,
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.semibold,
    letterSpacing: 1.2,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  row: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: { color: colors.text, fontSize: typography.sizes.body },
  value: { color: colors.textDim, fontSize: typography.sizes.small },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: {
    color: '#fff',
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
})
