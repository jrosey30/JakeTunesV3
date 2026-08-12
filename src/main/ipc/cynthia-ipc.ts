/**
 * Cynthia IPC: investigate / chat / report-to-musicman.
 *
 * Investigation pipeline (gather evidence → Sonnet tool loop → sourced
 * fixes) lives here so chat's deep_investigate tool and the background
 * sweep escalate hook share one implementation. MB / Discogs / Wikidata /
 * embedded-tag reads stay behind CynthiaIpcHost so we don't drag library
 * mount + spawn closures out of index.ts.
 *
 * Ledger / findings / sweep-status stay in ai-ipc (already extracted).
 */
import Anthropic from '@anthropic-ai/sdk'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { buildCynthiaPrompt } from '../personas.ts'
import { noteCynthiaUtterance, noteMusicManUtterance } from '../persona-memory.ts'
import { scanAlbum as cynthiaScanAlbum, type CynthiaScanTrack } from '../cynthia-scan.ts'
import { diffAgainstMusicBrainz, type MbLookupResult } from '../cynthia-mb-diff.ts'
import { albumKeyOfMain } from '../cynthia-sweep.ts'
import { getCachedMbRelease } from '../mb-release-cache.ts'
import { getDiscogsReleaseInfo, getWikidataArtist } from '../external.ts'

export type CynthiaTrackInScope = {
  id: number
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  year: number | string
  genre: string
  duration: number  // ms
}

export interface CynthiaInvestigateInput {
  userPrompt: string
  scope: {
    type: 'tracks' | 'album' | 'artist' | 'playlist'
    label: string
    tracks: CynthiaTrackInScope[]
  }
}

interface CynthiaChatInput {
  scope: CynthiaInvestigateInput['scope']
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export type CynthiaClaudeCall = (
  callKey: string,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Messages.Message>

export interface CynthiaIpcHost {
  claudeCall: CynthiaClaudeCall
  /** Rate-limited MusicBrainz album lookup (JSON string). */
  fetchMbRelease: (artist: string, album: string) => Promise<string>
  /** Batch-read embedded tags for track ids (JSON string). */
  readEmbeddedTags: (trackIds: number[]) => Promise<string>
}

/**
 * Salvage Cynthia's occasionally-broken JSON (unescaped quotes inside
 * string values, curly quotes). Heuristic — caller still try/catches parse.
 */
export function repairCynthiaJson(raw: string): string {
  let s = raw
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')

  const out: string[] = []
  let inString = false
  let prev = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' && prev !== '\\') {
      if (!inString) {
        inString = true
        out.push(ch)
      } else {
        let j = i + 1
        while (j < s.length && /\s/.test(s[j])) j++
        const next = s[j] || ''
        if (next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false
          out.push(ch)
        } else {
          out.push('\\"')
        }
      }
    } else {
      out.push(ch)
    }
    prev = ch
  }
  return out.join('')
}

// Pre-gather deterministic evidence so the model starts informed: scanner
// findings/flags + cached MusicBrainz diff for each distinct album in scope.
async function gatherCynthiaEvidence(
  host: CynthiaIpcHost,
  scope: CynthiaInvestigateInput['scope'],
): Promise<string> {
  try {
    const byAlbum = new Map<string, CynthiaScanTrack[]>()
    for (const t of scope.tracks) {
      const key = albumKeyOfMain(t)
      const arr = byAlbum.get(key)
      if (arr) arr.push(t as CynthiaScanTrack)
      else byAlbum.set(key, [t as CynthiaScanTrack])
    }
    const sections: string[] = []
    for (const [, tracks] of byAlbum) {
      const artist = String(tracks[0].albumArtist || tracks[0].artist || '')
      const album = String(tracks[0].album || '')
      const scan = cynthiaScanAlbum(tracks)
      const lines: string[] = [`Album: ${artist} — ${album}`]
      if (scan.findings.length > 0) {
        lines.push(`Deterministic scan findings (already verified, cite source 'internal-consistency'):`)
        for (const f of scan.findings.slice(0, 30)) {
          lines.push(`  - track ${f.trackId} ${f.field}: '${f.oldValue}' -> '${f.newValue}' (${f.reason})`)
        }
      }
      if (scan.flags.length > 0) {
        lines.push(`Scan observations: ${scan.flags.map(fl => fl.detail).join('; ')}`)
      }
      if (tracks.length >= 3 && byAlbum.size <= 3) {
        try {
          const { raw, fromCache } = await getCachedMbRelease(artist, album, host.fetchMbRelease)
          const mb = JSON.parse(raw) as MbLookupResult
          const diff = diffAgainstMusicBrainz(tracks, mb, { artist, album })
          if (mb.chosenRelease) {
            lines.push(`MusicBrainz canonical (${fromCache ? 'cached' : 'fresh'}): '${mb.chosenRelease.title}' by ${mb.chosenRelease.artist}, date ${mb.chosenRelease.date || '?'} — ${mb.canonicalTrackCount || 0} tracks; exactMatch=${diff.exactMatch}, ambiguousEditions=${diff.ambiguous}`)
          }
          if (diff.findings.length > 0) {
            lines.push(`Canonical diff findings (cite source 'musicbrainz'):`)
            for (const f of diff.findings.slice(0, 30)) {
              lines.push(`  - track ${f.trackId} ${f.field}: '${f.oldValue}' -> '${f.newValue}' (${f.reason})`)
            }
          }
          if (diff.missingTracks.length > 0) {
            lines.push(`Missing vs canonical: ${diff.missingTracks.map(m => `d${m.discNumber}t${m.trackNumber} '${m.title}'`).join(', ')}`)
          }
        } catch { /* evidence is best-effort */ }
      }
      sections.push(lines.join('\n'))
    }
    return sections.join('\n\n')
  } catch {
    return ''
  }
}

export type CynthiaInvestigationResult = {
  ok: boolean
  summary?: string
  fixes?: unknown[]
  missingTracks?: unknown[]
  rationale?: string
  error?: string
  text?: string
}

/**
 * Two-model architecture:
 *   - Haiku fronts chat; deep_investigate spins Sonnet + MusicBrainz.
 * Exported so the background sweep escalate hook can reuse the same body.
 */
export async function runCynthiaInvestigation(
  host: CynthiaIpcHost,
  userPrompt: string,
  scope: CynthiaInvestigateInput['scope'],
): Promise<CynthiaInvestigationResult> {
  const trackTable = scope.tracks.map(t =>
    `${t.id}|${t.title}|${t.artist}|${t.album}|${t.albumArtist || ''}|disc ${t.discNumber || 1} track ${t.trackNumber || '?'}|${t.year || ''}|${t.genre || ''}|${Math.round((t.duration || 0) / 1000)}s`
  ).join('\n')

  const evidence = await gatherCynthiaEvidence(host, scope)

  const userMessage = `The user (your boss's boss, basically) just right-clicked on ${scope.type === 'album' ? `the album "${scope.label}"` : scope.type === 'artist' ? `the artist "${scope.label}"` : scope.type === 'playlist' ? `the playlist "${scope.label}"` : `${scope.tracks.length} track${scope.tracks.length !== 1 ? 's' : ''}`} and said:

"${userPrompt}"

Tracks in scope (id|title|artist|album|albumArtist|disc/track|year|genre|duration):
${trackTable}
${evidence ? `\nEVIDENCE (pre-gathered deterministically — read this before reaching for tools):\n${evidence}\n` : ''}
Investigate. Use your tools only for what the evidence doesn't already answer. Then return your JSON report.`

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: 'musicbrainz_album_lookup',
      description: 'Look up canonical track listings for a music release on MusicBrainz. Returns the authoritative track order, durations, and disc layout for an album. Check the EVIDENCE section first — the canonical diff may already be there. Returns a JSON object with chosenRelease, canonicalTracks, otherCandidates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          artist: { type: 'string', description: 'The album artist exactly as you want to search for it (e.g. "Pink Floyd")' },
          album:  { type: 'string', description: 'The album title (e.g. "Is There Anybody Out There? The Wall Live")' },
        },
        required: ['artist', 'album'],
      },
    },
    {
      name: 'discogs_release_lookup',
      description: 'Pressing-level release facts from Discogs: year, country, label, format. Use as a second opinion on edition/year questions when MusicBrainz is thin or contradicted.',
      input_schema: {
        type: 'object' as const,
        properties: {
          artist: { type: 'string' },
          album:  { type: 'string' },
        },
        required: ['artist', 'album'],
      },
    },
    {
      name: 'wikidata_artist_lookup',
      description: 'Structured artist facts from Wikidata: formed/dissolved years, members, labels, genres, hometown. Use to settle artist-identity questions (same-name artists) and era sanity checks.',
      input_schema: {
        type: 'object' as const,
        properties: {
          artist: { type: 'string' },
        },
        required: ['artist'],
      },
    },
    {
      name: 'read_file_tags',
      description: "Read the EMBEDDED tags inside the user's actual audio files for the in-scope track ids (title/artist/album/duration as written in the files). Strong evidence when you suspect the library entry and the file disagree.",
      input_schema: {
        type: 'object' as const,
        properties: {
          trackIds: { type: 'array', items: { type: 'number' }, description: 'Track ids from the in-scope list (max 30)' },
        },
        required: ['trackIds'],
      },
    },
  ]

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  const systemPrompt = buildCynthiaPrompt()
  let response: Anthropic.Messages.Message
  let safety = 0
  const MAX_TOOL_ROUNDS = 8

  try {
    response = await host.claudeCall('cynthia-investigate-init', {
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools,
      messages,
    })

    while (response.stop_reason === 'tool_use' && safety++ < MAX_TOOL_ROUNDS) {
      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        if (block.name === 'musicbrainz_album_lookup') {
          const input = block.input as { artist?: string; album?: string }
          const { raw } = await getCachedMbRelease(input.artist || '', input.album || '', host.fetchMbRelease)
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: raw })
        } else if (block.name === 'discogs_release_lookup') {
          const input = block.input as { artist?: string; album?: string }
          const hit = await getDiscogsReleaseInfo(input.artist || '', input.album || '').catch(() => null)
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(hit ?? { note: 'no Discogs match' }) })
        } else if (block.name === 'wikidata_artist_lookup') {
          const input = block.input as { artist?: string }
          const hit = await getWikidataArtist(input.artist || '').catch(() => null)
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(hit ?? { note: 'no Wikidata match' }) })
        } else if (block.name === 'read_file_tags') {
          const input = block.input as { trackIds?: number[] }
          const result = await host.readEmbeddedTags((input.trackIds || []).slice(0, 30))
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }
      }
      if (toolResults.length === 0) break
      messages.push({ role: 'user', content: toolResults })
      response = await host.claudeCall('cynthia-investigate-tool', {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        tools,
        messages,
      })
    }

    const text = response.content
      .filter((b: Anthropic.Messages.ContentBlock) => b.type === 'text')
      .map((b: Anthropic.Messages.ContentBlock) => (b as Anthropic.Messages.TextBlock).text)
      .join('\n')
      .trim()

    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    const bare = !fenced ? text.match(/\{[\s\S]*\}/) : null
    const rawJson = (fenced?.[1] || bare?.[0] || '').trim()
    if (!rawJson) {
      return { ok: false, error: 'Cynthia gave a non-JSON answer.', text }
    }
    let parsed: { summary?: string; fixes?: unknown[]; missingTracks?: unknown[]; rationale?: string }
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      try {
        parsed = JSON.parse(repairCynthiaJson(rawJson))
      } catch (secondErr: unknown) {
        const msg = secondErr instanceof Error ? secondErr.message : String(secondErr)
        return { ok: false, error: `Could not parse Cynthia's JSON: ${msg}`, text }
      }
    }

    const VALID_SOURCES = new Set(['musicbrainz', 'discogs', 'wikidata', 'file-tags', 'internal-consistency'])
    const rawFixes = Array.isArray(parsed.fixes) ? parsed.fixes : []
    const sourcedFixes = rawFixes.filter((f) => {
      const src = (f as { source?: string })?.source
      return typeof src === 'string' && VALID_SOURCES.has(src)
    })
    if (rawFixes.length > sourcedFixes.length) {
      console.warn(`[cynthia] dropped ${rawFixes.length - sourcedFixes.length} unsourced fix(es)`)
    }

    return {
      ok: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      fixes: sourcedFixes,
      missingTracks: Array.isArray(parsed.missingTracks) ? parsed.missingTracks : [],
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    }
  } catch (err: unknown) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}

const CYNTHIA_CHAT_CORE = `You are Cynthia, the digital file archivist for JakeTunes. You're chatting with the user in a small popover. You came up on Grateful Dead bootlegs and never quite left, and it shows in your pace — easy-going, a little understated, never in a hurry. You're not performing the hippie thing. It's just how you are.

VOICE:
- One or two short sentences. Three max, and only if you have a reason.
- Plain English, low-stakes phrasing. "Track checks out" beats "I have verified the metadata." "A bit messy" beats "this is incorrect." "Couldn't find much on that" beats "I was unable to locate sufficient information."
- Slight understatement. "Pretty solid." "Not bad." "Holds up."
- Don't say "groovy," "far out," "right on," "vibes," "dude." The mellowness is in your rhythm, not your vocabulary. Saying those would be trying too hard.
- Don't restate the user's question. Don't apologize. Never use emojis.
- When you don't know, just say so plainly. "Not sure, honestly."

YOUR TASTE — fixed, do not look it up:
You have an actual taste profile. It does not change. You do not research what's currently hot or trending — that's not your scene and trends aren't real anyway. You only ever express opinions about music if (a) the user asks, AND (b) it's in your zone.

Your zone: Grateful Dead, The Band, Allman Brothers, Phish, Pink Floyd, Led Zeppelin, Hendrix, Janis Joplin, Dylan, Neil Young, CSN(Y), Joni Mitchell, Van Morrison, Marley, Curtis Mayfield, Sly & The Family Stone, Stevie Wonder, Velvet Underground, Modern Lovers, Talking Heads, Wilco, My Morning Jacket, Wolf Parade, Iron & Wine, Bon Iver, Big Thief, Sufjan Stevens, Built to Spill, Pavement, Yo La Tengo. Folk-rock, psych, jam, soul, reggae, americana, indie rock with feeling, slowcore, sad-bastard stuff.

Outside your zone: mainstream pop, top-40 country, EDM, hyperpop, most modern rap. You'll fix the metadata politely. You don't have anything to say about it.

OPINION RULES:
- User did not ask for an opinion → don't give one. Just do the metadata work.
- User asked AND it's in your zone → one or two sentences of low-key opinion. "Mm, this one's nice. The '77 run hits harder but this holds up." Reference specifics if you know them, but don't show off.
- User asked AND it's outside your zone → "Not really my scene, can't help you there. Metadata looks fine though." Or similar. No fake enthusiasm.
- Never claim something is "trending" or "popular right now." You don't know and don't care.

DECIDING WHAT TO DO:
- User asked you to investigate, check, fix, find missing tracks, normalize anything → call deep_investigate. That's the heavy tool.
- User is just chatting, clarifying, or expressing a preference → answer in text. No deep_investigate.
- User already saw a fix list and says "do it" / "apply" → tell them to hit Apply on the card; you don't apply yourself.`

export function registerCynthiaIpc(ipc: IpcRegistrar, host: CynthiaIpcHost): void {
  ipc.handle('cynthia-investigate', async (_event, input: CynthiaInvestigateInput) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'ANTHROPIC_API_KEY missing — Cynthia is on break.' }
    }
    const { userPrompt, scope } = input
    if (!userPrompt?.trim() || !scope?.tracks?.length) {
      return { ok: false, error: 'Cynthia needs a prompt and at least one track in scope.' }
    }
    return runCynthiaInvestigation(host, userPrompt, scope)
  }, { refuse: REFUSED_SENDER })

  ipc.handle('cynthia-chat', async (_event, input: CynthiaChatInput) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'ANTHROPIC_API_KEY missing — Cynthia is on break.' }
    }
    const { scope, messages } = input
    if (!scope?.tracks?.length || !messages?.length) {
      return { ok: false, error: 'Cynthia needs a scope and at least one message.' }
    }

    const scopeLabel = scope.type === 'album' ? `the album "${scope.label}"`
      : scope.type === 'artist' ? `the artist "${scope.label}"`
      : scope.type === 'playlist' ? `the playlist "${scope.label}"`
      : `${scope.tracks.length} track${scope.tracks.length !== 1 ? 's' : ''}`

    const trackBrief = scope.tracks.slice(0, 30).map(t =>
      `${t.id}: ${t.title} — ${t.artist} — ${t.album} (disc ${t.discNumber || 1} #${t.trackNumber || '?'})`
    ).join('\n')

    const systemPrompt = `${CYNTHIA_CHAT_CORE}

The user right-clicked on ${scopeLabel}. The in-scope tracks are:
${trackBrief}${scope.tracks.length > 30 ? `\n(+${scope.tracks.length - 30} more)` : ''}`

    const tools: Anthropic.Messages.ToolUnion[] = [
      {
        name: 'deep_investigate',
        description: 'Run a thorough metadata investigation on the in-scope tracks. Calls MusicBrainz via the Sonnet model, identifies missing tracks, and proposes concrete fixes. Use this whenever the user wants you to check, verify, or fix something concrete about the data. Do NOT use for casual chat.',
        input_schema: {
          type: 'object' as const,
          properties: {
            prompt: { type: 'string', description: 'A clear instruction describing what should be investigated or fixed (e.g. "check the track numbers and disc count against MusicBrainz canonical").' },
          },
          required: ['prompt'],
        },
      },
    ]

    const apiMessages: Anthropic.Messages.MessageParam[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    let investigation: CynthiaInvestigationResult | null = null

    try {
      let response = await host.claudeCall('cynthia-chat-init', {
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: systemPrompt,
        tools,
        messages: apiMessages,
      })

      let safety = 0
      while (response.stop_reason === 'tool_use' && safety++ < 3) {
        apiMessages.push({ role: 'assistant', content: response.content })
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type === 'tool_use' && block.name === 'deep_investigate') {
            const args = block.input as { prompt?: string }
            const result = await runCynthiaInvestigation(host, args.prompt || '', scope)
            investigation = result
            const briefForHaiku = result.ok
              ? `deep_investigate result:\nsummary: ${result.summary || '(none)'}\nfixes: ${(result.fixes || []).length}\nmissingTracks: ${(result.missingTracks || []).length}`
              : `deep_investigate failed: ${result.error || 'unknown error'}`
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: briefForHaiku })
          }
        }
        if (toolResults.length === 0) break
        apiMessages.push({ role: 'user', content: toolResults })
        response = await host.claudeCall('cynthia-chat-tool', {
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: systemPrompt,
          tools,
          messages: apiMessages,
        })
      }

      const text = response.content
        .filter((b: Anthropic.Messages.ContentBlock) => b.type === 'text')
        .map((b: Anthropic.Messages.ContentBlock) => (b as Anthropic.Messages.TextBlock).text)
        .join('\n')
        .trim()

      return {
        ok: true,
        text: text || (investigation?.ok ? (investigation.summary || '') : ''),
        investigation: investigation?.ok ? {
          summary: investigation.summary || '',
          fixes: investigation.fixes || [],
          missingTracks: investigation.missingTracks || [],
          rationale: investigation.rationale || '',
        } : null,
      }
    } catch (err: unknown) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  // After the user approves Cynthia's fixes, land her summary in Music Man's
  // rolling memory and her own log.
  ipc.handle('cynthia-report-to-musicman', async (_event, payload: { rationale: string; summary?: string }) => {
    const text = (payload?.rationale || payload?.summary || '').trim()
    if (!text) return { ok: false, error: 'Empty report' }
    noteCynthiaUtterance(text)
    noteMusicManUtterance('cynthia-report', `[Cynthia, archivist] ${text}`)
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}
