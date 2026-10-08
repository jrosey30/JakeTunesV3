/**
 * audio-index — loader for the CLAP audio vectors (6.0 Phase 3d).
 *
 * Same EMBD container as embeddings.bin / mood-index.bin but its OWN
 * dimension (512, read from the header — the text indexes' parser pins
 * 1536, so this one reads what the file declares). Written by
 * scripts/audio-embed.py on the laptop; mtime-reloaded like its
 * siblings. Absent file = empty map — every consumer must treat the
 * audio route as optional.
 */
import { join } from 'path'
import { readFile, stat } from 'fs/promises'
import { STATE_DIR } from '../state-dir'

const MAGIC = 'EMBD'

let cache: { map: Map<number, Float32Array>; mtimeMs: number; dim: number } | null = null

export function audioIndexPath(): string {
  return join(STATE_DIR, 'audio-index.bin')
}

export function parseAudioIndexBlob(buf: Buffer): { map: Map<number, Float32Array>; dim: number } {
  const map = new Map<number, Float32Array>()
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== MAGIC) return { map, dim: 0 }
  const dim = buf.readUInt16LE(6)
  const count = buf.readUInt32LE(8)
  if (dim <= 0 || dim > 4096) return { map, dim: 0 }
  const rec = 4 + dim * 4
  let off = 12
  for (let i = 0; i < count && off + rec <= buf.length; i++) {
    const id = buf.readUInt32LE(off)
    // Slice-copy so the vectors don't pin the whole file buffer.
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = buf.readFloatLE(off + 4 + d * 4)
    map.set(id, v)
    off += rec
  }
  return { map, dim }
}

export async function getAudioIndexMap(): Promise<Map<number, Float32Array>> {
  const p = audioIndexPath()
  try {
    const st = await stat(p)
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.map
    const { map, dim } = parseAudioIndexBlob(await readFile(p))
    cache = { map, mtimeMs: st.mtimeMs, dim }
    console.log(`[audio-index] reloaded: ${map.size} vectors, dim ${dim} (mtime=${new Date(st.mtimeMs).toISOString()})`)
    return map
  } catch {
    return cache?.map ?? new Map()
  }
}

/** Cosine top-k over the audio map (vectors are L2-normalized). */
export function audioTopK(qvec: Float32Array, map: Map<number, Float32Array>, k: number): Array<{ trackId: number; score: number }> {
  const hits: Array<{ trackId: number; score: number }> = []
  for (const [trackId, v] of map) {
    if (v.length !== qvec.length) continue
    let s = 0
    for (let i = 0; i < v.length; i++) s += v[i] * qvec[i]
    hits.push({ trackId, score: s })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}
