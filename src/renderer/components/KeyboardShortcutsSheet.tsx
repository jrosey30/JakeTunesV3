/**
 * The Keyboard Shortcuts sheet (⌘/, Help → Keyboard Shortcuts). Generated
 * from the keymap (common/keymap.ts shortcutSheet), so it can't drift from
 * what the keys do. Escape closes it.
 */
import { useMemo } from 'react'
import { shortcutSheet } from '../../common/keymap'
import { useEscape } from '../hooks/useKeyboard'
import '../styles/go-anywhere.css'

export default function KeyboardShortcutsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  useEscape('keyboard-shortcuts', true, onClose)
  const sections = useMemo(() => shortcutSheet(), [])
  return (
    <div className="go-anywhere-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="kb-sheet" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
        <div className="kb-sheet-head">
          <h2 className="kb-sheet-title">Keyboard Shortcuts</h2>
          <button type="button" className="kb-sheet-close" onClick={onClose}>Done</button>
        </div>
        <div className="kb-sheet-cols">
          {sections.map((sec) => (
            <section key={sec.title} className="kb-sheet-section">
              <h3 className="kb-sheet-section-title">{sec.title}</h3>
              <dl>
                {sec.rows.map((r) => (
                  <div key={r.label} className="kb-sheet-row">
                    <dt>
                      {r.label}
                      {r.note && <span className="kb-sheet-note">{r.note}</span>}
                    </dt>
                    <dd>{r.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
