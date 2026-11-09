/**
 * play-events.jsonl, parsed. Moved out of record-store/shelf-generator.ts
 * when the Record Store room was removed (2026-11-09): the mixtapes' season
 * tapes still read the real listening record through it.
 */
export interface PlayEvent {
  id: number
  ts: number
}

/** Parse play-events.jsonl text into events. Tolerant of torn last
 *  lines (append-only file can be read mid-write). */
export function parsePlayEvents(raw: string): PlayEvent[] {
  const out: PlayEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const evt = JSON.parse(line) as { id?: number; ts?: number }
      if (typeof evt.id === 'number' && typeof evt.ts === 'number') {
        out.push({ id: evt.id, ts: evt.ts })
      }
    } catch {
      // Torn / malformed line — skip, same as get-windowed-play-counts.
    }
  }
  return out
}
