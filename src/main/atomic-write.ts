/**
 * One correct atomic JSON write, so nobody has to hand-roll it again.
 *
 * This exists because the same bug has now been found THREE times in this
 * codebase, each in a separately hand-written copy of "stage to a tmp file,
 * then rename":
 *
 *   • metadata-overrides.json — two writers opened the same
 *     `overridesPath + '.tmp'` simultaneously (see writeOverridesSerialized).
 *   • ui-state.json (2026-08-03) — a fixed `.partial.json` staging file left
 *     22 trailing bytes of an older, longer write on the end. JSON.parse threw
 *     on every launch, the app silently fell back to defaults, and Jake's Songs
 *     column layout was destroyed on every restart.
 *   • library.json — same fixed-sidecar shape, on the highest-stakes file in
 *     the app.
 *
 * The trap is that `rename()` genuinely IS atomic, so the pattern looks safe.
 * It protects a READER from seeing a half-written file. It does nothing when
 * two WRITERS share one staging path: they interleave inside the tmp file, and
 * rename then atomically installs the corruption. A shorter payload landing
 * over a longer one leaves the tail of the long write past the end of the
 * short one — which is exactly the shape found on disk.
 *
 * So: the staging name is unique per write (pid + time + random), never
 * derived from the destination alone.
 */
import { writeFile, rename, unlink } from 'node:fs/promises'

/** Unique staging path — never collides, even between two writes in one tick. */
function stagingPathFor(destPath: string): string {
  return `${destPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
}

/**
 * Serialize `data` to `destPath` atomically.
 *
 * `pretty` matches whatever the file already used — some of these are read by
 * humans and by scripts that diff them, so formatting is a caller's choice.
 *
 * On failure the staging file is removed rather than left behind: an orphaned
 * `<name>.<pid>.<ts>.tmp` next to a state file is the kind of litter that gets
 * mistaken for a recovery sidecar later.
 */
export async function writeJsonAtomic(destPath: string, data: unknown, pretty = true): Promise<void> {
  const tmp = stagingPathFor(destPath)
  try {
    await writeFile(tmp, JSON.stringify(data, null, pretty ? 2 : undefined), 'utf-8')
    await rename(tmp, destPath)
  } catch (err) {
    await unlink(tmp).catch(() => { /* never mask the real error */ })
    throw err
  }
}
