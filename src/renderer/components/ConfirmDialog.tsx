import { useEffect, useRef } from 'react'
import '../styles/confirm.css'

interface ConfirmDialogProps {
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  // Brief 033d: informational result modals (no choice to make) pass
  // hideCancel so only the single confirm button renders. Defaults
  // false, so the 12 genuine confirm/cancel callers are unaffected and
  // still render both buttons. Escape / overlay-click still call
  // onCancel — informational callers point onCancel and onConfirm at
  // the same dismiss handler, so every dismissal path keeps working.
  hideCancel?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  message,
  detail,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  hideCancel = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus cancel button by default (safer). When cancel is hidden
    // (informational modal) focus the lone confirm button instead so
    // keyboard users land on something actionable.
    if (hideCancel) confirmRef.current?.focus()
    else cancelRef.current?.focus()

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onCancel()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onConfirm()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [onConfirm, onCancel, hideCancel])

  return (
    <div className="confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="confirm-dialog">
        <div className="confirm-message">{message}</div>
        {detail && <div className="confirm-detail">{detail}</div>}
        <div className="confirm-buttons">
          {!hideCancel && (
            <button
              ref={cancelRef}
              className="confirm-btn confirm-btn--cancel"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`confirm-btn ${destructive ? 'confirm-btn--destructive' : 'confirm-btn--confirm'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
