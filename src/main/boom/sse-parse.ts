/**
 * Minimal SSE parser — no third-party dependency.
 * Spec subset: id / event / data fields, blank-line dispatch.
 */

export interface ParsedSseEvent {
  id?: string
  event?: string
  data: string
}

export type SseHandler = (ev: ParsedSseEvent) => void

export function createParser(onEvent: SseHandler): { feed: (chunk: string) => void } {
  let buf = ''
  let event: { id?: string; event?: string; data: string[] } = { data: [] }

  function dispatch() {
    if (event.data.length === 0 && event.id === undefined && event.event === undefined) {
      event = { data: [] }
      return
    }
    onEvent({
      id: event.id,
      event: event.event,
      data: event.data.join('\n'),
    })
    event = { data: [] }
  }

  return {
    feed(chunk: string) {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          dispatch()
          continue
        }
        if (line.startsWith(':')) continue // comment / keepalive
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') event.data.push(value)
        else if (field === 'id') event.id = value
        else if (field === 'event') event.event = value
      }
    },
  }
}
