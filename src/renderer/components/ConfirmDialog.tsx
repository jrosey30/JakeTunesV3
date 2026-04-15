import { useEffect, useRef } from 'react'
import '../styles/confirm.css'

interface ConfirmDialogProps {
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  message,
  detail,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus cancel button by default (safer)
    cancelRef.current?.focus()

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
  }, [onConfirm, onCancel])

  return (
    <div className="confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="confirm-dialog">
        <div className="confirm-message">{message}</div>
        {detail && <div className="confirm-detail">{detail}</div>}
        <div className="confirm-buttons">
          <button
            ref={cancelRef}
            className="confirm-btn confirm-btn--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
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
