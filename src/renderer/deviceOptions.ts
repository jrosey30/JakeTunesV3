/**
 * The Device page's options, kept in ui-state.json.
 *
 * V7 steady (2026-11-24): the page used to offer five options behind an
 * Apply button, and ticking any of them greyed out Sync until Apply was
 * clicked. Three of them ("Sync only checked songs", "Manually manage
 * music", "Enable disk use") were saved and never read by anything. They
 * are gone, and so is Apply. What is left is read and saves the moment it
 * changes, and never blocks a sync:
 *   - "Open JakeTunes when this iPod is connected" (`optOpenOnConnect`,
 *     read by App.tsx on plug-in);
 *   - "Convert higher bit rate songs to … AAC" (`optConvertBitrate`,
 *     `optConvertBitrateTarget`, handed to sync-to-ipod).
 */

export type ConvertTarget = '128' | '192' | '256'

export interface DeviceOptions {
  optOpenOnConnect: boolean
  optConvertBitrate: boolean
  optConvertBitrateTarget: ConvertTarget
}

export const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  optOpenOnConnect: false,
  optConvertBitrate: false,
  optConvertBitrateTarget: '128',
}

export interface UiStateApi {
  loadUiState: () => Promise<{ ok: boolean; state?: Record<string, unknown> | null }>
  saveUiState: (state: Record<string, unknown>) => Promise<unknown>
}

export function readDeviceOptions(state: Record<string, unknown> | null | undefined): DeviceOptions {
  const s = state ?? {}
  const t = s.optConvertBitrateTarget
  return {
    optOpenOnConnect: typeof s.optOpenOnConnect === 'boolean' ? s.optOpenOnConnect : DEFAULT_DEVICE_OPTIONS.optOpenOnConnect,
    optConvertBitrate: typeof s.optConvertBitrate === 'boolean' ? s.optConvertBitrate : DEFAULT_DEVICE_OPTIONS.optConvertBitrate,
    optConvertBitrateTarget: t === '128' || t === '192' || t === '256' ? t : DEFAULT_DEVICE_OPTIONS.optConvertBitrateTarget,
  }
}

/** Saves one change at once, keeping every other ui-state key as it was. */
export async function saveDeviceOption(api: UiStateApi, patch: Partial<DeviceOptions>): Promise<void> {
  const r = await api.loadUiState()
  const existing = (r.ok && r.state) ? r.state : {}
  await api.saveUiState({ ...existing, ...patch })
}

export function convertKbps(target: ConvertTarget): 128 | 192 | 256 {
  return target === '256' ? 256 : target === '192' ? 192 : 128
}
