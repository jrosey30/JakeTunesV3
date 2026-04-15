import { useEffect, useState } from 'react'
import '../styles/toast.css'

interface UndoToastProps {
  message: string
  duration?: number
  onUndo: () => void
  onDismiss: () => void
}

export default function UndoToast({ message, duration = 5000, onUndo, onDismiss }: UndoToastProps) {
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true)
      setTimeout(onDismiss, 300)
    }, duration)
    return () => clearTimeout(timer)
  }, [duration, onDismiss])

  const handleUndo = () => {
    onUndo()
    onDismiss()
  }

  return (
    <div className={`undo-toast ${exiting ? 'undo-toast--exiting' : ''}`}>
      <span className="undo-toast-message">{message}</span>
      <button className="undo-toast-btn" onClick={handleUndo}>Undo</button>
    </div>
  )
}
