import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useNavigation } from '@react-navigation/native'
import { useConnection } from '@/context/ConnectionContext'
import type { NasConnectionConfig, NasTransport } from '@/types'
import { colors, spacing, typography } from '@/styles/theme'

const TRANSPORTS: NasTransport[] = ['synology-audio-station', 'webdav', 'auto']

export function ConnectionView() {
  const nav = useNavigation()
  const { config, state, saveConfig, connect, disconnect, forget } = useConnection()

  const [host, setHost] = useState(config?.host ?? '')
  const [port, setPort] = useState(config?.port?.toString() ?? '')
  const [https, setHttps] = useState(config?.https ?? true)
  const [username, setUsername] = useState(config?.username ?? '')
  const [password, setPassword] = useState('')
  const [transport, setTransport] = useState<NasTransport>(config?.transport ?? 'synology-audio-station')
  const [libraryJsonPath, setLibraryJsonPath] = useState(
    config?.libraryJsonPath ?? '/music/.jaketunes/library.json',
  )
  const [libraryRootPath, setLibraryRootPath] = useState(
    config?.libraryRootPath ?? '/music',
  )

  const onSave = async () => {
    const next: NasConnectionConfig = {
      host: host.trim(),
      port: port.trim() ? Number(port) : undefined,
      https,
      username: username.trim(),
      hasStoredCredential: false,
      transport,
      libraryJsonPath: libraryJsonPath.trim(),
      libraryRootPath: libraryRootPath.trim(),
    }
    await saveConfig(next, password)
    setPassword('')
    await connect()
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={() => nav.goBack()} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>Synology</Text>
          <View style={{ width: 60 }} />
        </View>

        <Text style={styles.section}>Server</Text>
        <Field label="Host" value={host} onChangeText={setHost} placeholder="synology.local" autoCapitalize="none" />
        <Field label="Port" value={port} onChangeText={setPort} placeholder="auto" keyboardType="number-pad" />
        <View style={styles.row}>
          <Text style={styles.label}>HTTPS</Text>
          <Switch value={https} onValueChange={setHttps} />
        </View>

        <Text style={styles.section}>Credentials</Text>
        <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder={config?.hasStoredCredential ? '•••••••• (stored)' : ''}
        />

        <Text style={styles.section}>Library</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Transport</Text>
          <View style={styles.transportRow}>
            {TRANSPORTS.map((t) => (
              <Pressable
                key={t}
                onPress={() => setTransport(t)}
                style={[styles.chip, transport === t && styles.chipActive]}
              >
                <Text style={[styles.chipText, transport === t && styles.chipTextActive]}>{t}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Field
          label="library.json path"
          value={libraryJsonPath}
          onChangeText={setLibraryJsonPath}
          autoCapitalize="none"
        />
        <Field
          label="Music root"
          value={libraryRootPath}
          onChangeText={setLibraryRootPath}
          autoCapitalize="none"
        />

        {state.status === 'error' ? (
          <Text style={styles.error}>Error: {state.message}</Text>
        ) : null}

        <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => void onSave()}>
          <Text style={styles.buttonText}>
            {state.status === 'connecting' ? 'Connecting…' : 'Save & connect'}
          </Text>
        </Pressable>

        {config ? (
          <>
            <Pressable style={styles.button} onPress={() => void disconnect()}>
              <Text style={[styles.buttonText, { color: colors.text }]}>Disconnect</Text>
            </Pressable>
            <ForgetNasButton onConfirm={() => void forget()} />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

// Inline two-step confirmation for the destructive forget action.
// Per CLAUDE.md: don't use OS-level Alert.alert (the Electron-renderer
// rule generalizes — native dialogs hide intent and break the inline
// React UX). The user must tap once to arm, again within 4 seconds to
// fire. The armed state self-clears so an accidental tap can't sit
// hot indefinitely.
function ForgetNasButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onPress = () => {
    if (armed) {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      setArmed(false)
      onConfirm()
      return
    }
    setArmed(true)
    timer.current = setTimeout(() => {
      setArmed(false)
      timer.current = null
    }, 4000)
  }

  return (
    <Pressable
      style={[styles.button, armed && styles.buttonArmed]}
      onPress={onPress}
      accessibilityLabel={armed ? 'Tap again to confirm forget' : 'Forget this NAS'}
    >
      <Text style={[styles.buttonText, { color: armed ? '#fff' : colors.negative }]}>
        {armed ? 'Tap again to forget' : 'Forget this NAS'}
      </Text>
    </Pressable>
  )
}

interface FieldProps {
  label: string
  value: string
  onChangeText: (s: string) => void
  placeholder?: string
  secureTextEntry?: boolean
  keyboardType?: 'default' | 'number-pad'
  autoCapitalize?: 'none' | 'sentences'
}

function Field(p: FieldProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{p.label}</Text>
      <TextInput
        value={p.value}
        onChangeText={p.onChangeText}
        placeholder={p.placeholder}
        placeholderTextColor={colors.textFaint}
        secureTextEntry={p.secureTextEntry}
        keyboardType={p.keyboardType}
        autoCapitalize={p.autoCapitalize}
        style={styles.input}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, paddingBottom: 80 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: typography.sizes.title,
    fontWeight: typography.weights.semibold,
  },
  cancel: { color: colors.accent, fontSize: typography.sizes.body },
  section: {
    color: colors.textFaint,
    fontSize: typography.sizes.caption,
    fontWeight: typography.weights.semibold,
    letterSpacing: 1.2,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  row: {
    backgroundColor: colors.bgElevated,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  label: { color: colors.text, fontSize: typography.sizes.body },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: typography.sizes.body,
    textAlign: 'right',
  },
  transportRow: { flexDirection: 'row', gap: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textDim, fontSize: typography.sizes.caption },
  chipTextActive: { color: '#fff' },
  button: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.bgElevated,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonArmed: { backgroundColor: colors.negative },
  buttonText: {
    color: '#fff',
    fontSize: typography.sizes.body,
    fontWeight: typography.weights.semibold,
  },
  error: {
    color: colors.negative,
    fontSize: typography.sizes.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
})
