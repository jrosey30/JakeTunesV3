// DialogueBox — Music Man's chat, styled like a Pokémon Game Boy Color
// dialogue box: speaker name, text that types out character-by-character,
// a blinking ▼ when finished. Click anywhere on the box to fast-forward
// the typewriter to the full line (the GBC "press A" feel).
//
// `loading` shows an animated "thinking" state while the blurb LLM call
// is in flight; `text` is his take (null = he had nothing).

import { useTypewriter } from '../hooks/useTypewriter'

export function DialogueBox({
  speaker,
  text,
  loading,
  onAdvance,
}: {
  speaker: string
  text: string | null
  loading: boolean
  onAdvance?: () => void
}) {
  const body = loading ? '' : text ?? "[he just shrugs]"
  const { shown, done, skip } = useTypewriter(body)

  return (
    <div
      className="gbc-dialogue"
      onClick={() => {
        if (loading) return
        if (!done) skip()
        else onAdvance?.()
      }}
    >
      <span className="gbc-dialogue__speaker">{speaker}</span>
      {loading ? (
        <p className="gbc-dialogue__text">
          <span className="gbc-dialogue__thinking">thinking</span>
        </p>
      ) : (
        <p className="gbc-dialogue__text">
          {shown}
          {done && <span className="gbc-dialogue__arrow">▼</span>}
        </p>
      )}
    </div>
  )
}
