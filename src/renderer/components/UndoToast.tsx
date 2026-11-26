import { useEffect, useRef, useState } from 'react'
import { useUndoShortcut } from '../hooks/useKeyboard'
import '../styles/toast.css'

interface UndoToastProps {
  message: string
  duration?: number
  onUndo: () => void
  onDismiss: () => void
}

export default function UndoToast({ message, duration = 5000, onUndo, onDismiss }: UndoToastProps) {
  const [exiting, setExiting] = useState(false)
  // Callers pass a new onDismiss on every render (SongTable redraws ~10x a second
  // while music plays). It is read through a ref, never an effect dep, or the
  // 5 s timer restarts on each render and the toast, and its ⌘Z, never leave (Brief 266).
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      setExiting(true)
      exitTimer = setTimeout(() => dismissRef.current(), 300)
    }, duration)
    return () => {
      clearTimeout(timer)
      if (exitTimer !== undefined) clearTimeout(exitTimer)
    }
  }, [duration])

  const handleUndo = () => {
    onUndo()
    onDismiss()
  }
  // ⌘Z outside a text field presses the newest Undo on screen (keyboard.ts).
  // Off once the toast starts leaving, and gone when it unmounts.
  useUndoShortcut('undo-toast', !exiting, handleUndo)

  return (
    <div className={`undo-toast ${exiting ? 'undo-toast--exiting' : ''}`}>
      <span className="undo-toast-message">{message}</span>
      <button className="undo-toast-btn" onClick={handleUndo}>Undo</button>
    </div>
  )
}
