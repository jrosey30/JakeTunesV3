import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useConnection } from '@/context/ConnectionContext'
import { useLibrary } from '@/context/LibraryContext'
import type { RootStackParamList } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'
import {
  buildExportFile,
  clearOverrides,
  listOverrides,
} from '@/services/overrides/queue'

export function SettingsView() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { state, config } = useConnection()
  const { tracks, lastRefreshedAt, refresh, loading } = useLibrary()
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [clearArmed, setClearArmed] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refresh queue size on mount and whenever the screen regains
  // focus. Phase 0 polls cheaply — count is bounded by track plays.
  useEffect(() => {
    let alive = true
    const reload = async () => {
      const list = await listOverrides()
      if (alive) setPendingCount(list.length)
    }
    void reload()
    const unsub = nav.addListener?.('focus', reload)
    return () => {
      alive = false
      unsub?.()
      if (armTimer.current) clearTimeout(armTimer.current)
    }
  }, [nav])

  const onExport = async () => {
    const file = await buildExportFile()
    const json = JSON.stringify(file, null, 2)
    // iOS Share sheet accepts a `message` for text payloads. The
    // user routes the JSON to AirDrop / Mail / Files / Notes etc.
    // No filesystem dependency this way (no react-native-fs needed
    // for Phase 0). When the desktop drain accepts paste-from-clipboard
    // OR a file, both paths work.
    try {
      await Share.share({
        title: 'JakeTunes mobile play queue',
        message: json,
      })
    } catch (err) {
      console.warn('[overrides] share cancelled or failed:', err)
    }
  }

  const onClear = () => {
    if (!clearArmed) {
      setClearArmed(true)
      armTimer.current = setTimeout(() => setClearArmed(false), 4000)
      return
    }
    if (armTimer.current) clearTimeout(armTimer.current)
    setClearArmed(false)
    void clearOverrides().then(() => setPendingCount(0))
  }

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

        <Text style={styles.section}>Pending mobile plays</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Plays awaiting desktop merge</Text>
          <Text style={styles.value}>{pendingCount ?? '—'}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => void onExport()}
          disabled={!pendingCount}
        >
          <Text style={styles.buttonText}>
            {pendingCount ? 'Export overrides…' : 'Nothing to export'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonGhost, clearArmed && styles.buttonArmed]}
          onPress={onClear}
          disabled={!pendingCount}
        >
          <Text
            style={[
              styles.buttonText,
              { color: clearArmed ? '#fff' : colors.negative },
              !pendingCount && { color: colors.textFaint },
            ]}
          >
            {clearArmed ? 'Tap again to clear' : 'Clear queue (after desktop merge)'}
          </Text>
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
  buttonGhost: { backgroundColor: colors.bgElevated },
  buttonArmed: { backgroundColor: colors.negative },
  buttonPressed: { opacity: 0.7 },
  buttonText: {
    color: '#fff',
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
})
