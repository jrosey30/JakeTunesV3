/**
 * Activity context persistence (Electron). Pure helpers in activity-context-core.
 */

import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  formatActivityContextForPrompt,
  labelActivity,
  type ActivityBrief,
  type ActivityBrainContext,
  type SavedActivityProfile,
} from './activity-context-core.ts'

export * from './activity-context-core.ts'

function statePath(): string {
  return join(app.getPath('userData'), 'activity-context.json')
}

function profilesPath(): string {
  return join(app.getPath('userData'), 'activity-profiles.json')
}

let memoryContext: ActivityBrainContext | null = null

export function getActivityPromptBlockSync(): string {
  return formatActivityContextForPrompt(memoryContext)
}

/** In-memory brain context (loaded at boot / after sync). */
export function getActivityBrainContextSync(): ActivityBrainContext | null {
  return memoryContext
}

export async function loadActivityBrainContext(): Promise<ActivityBrainContext | null> {
  if (memoryContext) return memoryContext
  try {
    const raw = await readFile(statePath(), 'utf-8')
    const parsed = JSON.parse(raw) as ActivityBrainContext
    if (!parsed?.brief?.activity) return null
    memoryContext = parsed
    return parsed
  } catch {
    return null
  }
}

export async function saveActivityBrainContext(ctx: ActivityBrainContext): Promise<void> {
  memoryContext = ctx
  try {
    await writeFile(statePath(), JSON.stringify(ctx, null, 2))
  } catch (err) {
    console.warn('[activity-context] save failed:', err)
  }
}

export async function loadActivityProfiles(): Promise<SavedActivityProfile[]> {
  try {
    const raw = await readFile(profilesPath(), 'utf-8')
    const parsed = JSON.parse(raw) as SavedActivityProfile[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveActivityProfile(brief: ActivityBrief): Promise<SavedActivityProfile> {
  const profiles = await loadActivityProfiles()
  const now = new Date().toISOString()
  const name = (brief.profileName || `${labelActivity(brief.activity)} · ${brief.place || brief.setting}`).trim()
  let saved: SavedActivityProfile
  if (brief.id) {
    const idx = profiles.findIndex((p) => p.id === brief.id)
    saved = { ...brief, id: brief.id, profileName: name, updatedAt: now }
    if (idx >= 0) profiles[idx] = saved
    else profiles.unshift(saved)
  } else {
    saved = {
      ...brief,
      id: `ap-${Date.now().toString(36)}`,
      profileName: name,
      updatedAt: now,
    }
    profiles.unshift(saved)
  }
  const trimmed = profiles.slice(0, 12)
  try {
    await writeFile(profilesPath(), JSON.stringify(trimmed, null, 2))
  } catch (err) {
    console.warn('[activity-context] profiles save failed:', err)
  }
  return saved
}
