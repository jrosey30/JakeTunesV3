/**
 * The one import format (V7 steady, 2026-11-24).
 *
 * There used to be three: Settings › Library's default, a picker in
 * Import and Convert that started at ALAC, and a picker on the CD page
 * that remembered its own choice in ui-state.json and started at AAC
 * 256. Now Settings › Library holds the only one (default Apple
 * Lossless), and drag and drop, File › Import, Import and Convert and CD
 * import all read it here. Neither of those two pages has a picker.
 *
 * Pure, no imports: main and the renderer both use it.
 */

export type ImportFormat = 'aac-128' | 'aac-256' | 'aac-320' | 'alac' | 'aiff' | 'wav'

export const IMPORT_FORMATS: readonly ImportFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']

/** Missing or unknown setting: the master stays lossless. */
export const DEFAULT_IMPORT_FORMAT: ImportFormat = 'alac'

export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  'aac-128': 'AAC 128 kbps (small)',
  'aac-256': 'AAC 256 kbps',
  'aac-320': 'AAC 320 kbps (high)',
  'alac': 'Apple Lossless',
  'aiff': 'AIFF (uncompressed)',
  'wav': 'WAV (uncompressed)',
}

export function isImportFormat(v: unknown): v is ImportFormat {
  return typeof v === 'string' && (IMPORT_FORMATS as readonly string[]).includes(v)
}

/**
 * The format every import uses, from app-settings.json's parsed object
 * (`library.defaultImportFormat`). Anything missing or unknown is ALAC.
 */
export function importFormatFromSettings(settings: unknown): ImportFormat {
  const lib = (settings && typeof settings === 'object')
    ? (settings as { library?: unknown }).library
    : undefined
  const f = (lib && typeof lib === 'object')
    ? (lib as { defaultImportFormat?: unknown }).defaultImportFormat
    : undefined
  return isImportFormat(f) ? f : DEFAULT_IMPORT_FORMAT
}
