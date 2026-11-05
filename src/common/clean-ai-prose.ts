import { stripStageDirections } from './stage-directions.ts'

/**
 * What a model wrote, ready to be read: no markdown a model emits despite instructions,
 * and no stage directions (the persona teaches them for the voice; the take on Ants From
 * Up There printed "[softer]").
 */
const plain = (s: string): string => s.replace(/[*_`"'“”‘’]/g, '').trim()

export function cleanAiProse(raw: string, title?: string): string {
  let t = (raw || '').trim()
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')
  const lines = t.split('\n')
  while (lines.length > 0) {
    const m = /^#{1,6}\s*(.*)$/.exec((lines[0] ?? '').trim())
    if (!m) break
    const heading = plain(m[1] ?? '')
    // Both sides stripped: only the heading was, so "Can't Buy A Thrill" kept its heading.
    if (!heading || (title && heading.toLowerCase() === plain(title).toLowerCase())) lines.shift()
    else { lines[0] = m[1] ?? ''; break }
  }
  t = lines.join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '')
  return stripStageDirections(t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
}
