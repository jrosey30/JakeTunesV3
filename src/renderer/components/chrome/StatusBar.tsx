import { useMemo } from 'react'
import { useLibrary } from '../../context/LibraryContext'

export default function StatusBar() {
  const { state } = useLibrary()

  const summary = useMemo(() => {
    const count = state.tracks.length
    if (count === 0) return 'No songs'

    const totalMs = state.tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
    const totalSecs = Math.floor(totalMs / 1000)
    const totalMins = Math.floor(totalSecs / 60)
    const hours = Math.floor(totalMins / 60)
    const mins = totalMins % 60
    const days = Math.floor(hours / 24)
    const remHours = hours % 24

    let timeStr: string
    if (days > 0) {
      timeStr = `${days} day${days !== 1 ? 's' : ''}, ${remHours} hour${remHours !== 1 ? 's' : ''}`
    } else if (hours > 0) {
      timeStr = `${hours} hour${hours !== 1 ? 's' : ''}, ${mins} minute${mins !== 1 ? 's' : ''}`
    } else {
      timeStr = `${mins} minute${mins !== 1 ? 's' : ''}`
    }

    const totalBytes = state.tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
    const gb = totalBytes / (1024 * 1024 * 1024)
    const sizeStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(totalBytes / (1024 * 1024)).toFixed(0)} MB`

    return `${count} song${count !== 1 ? 's' : ''}, ${timeStr}, ${sizeStr}`
  }, [state.tracks])

  return (
    <div className="statusbar">
      <span className="statusbar-info">{summary}</span>
    </div>
  )
}
