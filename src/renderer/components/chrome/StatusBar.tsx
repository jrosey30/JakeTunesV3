import { useMemo, useState } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useRegularLibraryTracks } from '../../hooks/useRegularLibraryTracks'
import { useUpdateReady } from '../../hooks/useUpdateReady'
import ConfirmDialog from '../ConfirmDialog'

export default function StatusBar() {
  const { state } = useLibrary()
  // Declared full concerts don't count as songs — footer reflects the regular library.
  const tracks = useRegularLibraryTracks(state.tracks)
  // 2026-10-30: a new build staged at the install gate shows here, on every
  // page (this bar is global), and Jake pushes it through himself.
  const update = useUpdateReady()
  const [confirmInstall, setConfirmInstall] = useState(false)

  const summary = useMemo(() => {
    const count = tracks.length
    if (count === 0) return 'No songs'

    const totalMs = tracks.reduce((sum, t) => sum + (t.duration || 0), 0)
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

    const totalBytes = tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
    const gb = totalBytes / (1024 * 1024 * 1024)
    const sizeStr = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(totalBytes / (1024 * 1024)).toFixed(0)} MB`

    // Thousands separator so the footer speaks the same number language as the
    // rest of the app (Home, the iPod modal, etc. all use toLocaleString()).
    return `${count.toLocaleString()} song${count !== 1 ? 's' : ''}, ${timeStr}, ${sizeStr}`
  }, [tracks])

  const ready = update.ready
  const updateTitle = ready ? (ready.note || (ready.version ? `Version ${ready.version}` : 'A new build is staged')) : ''

  return (
    <div className="statusbar">
      <span className="statusbar-info">{summary}</span>
      {ready && update.installing && (
        <span className="statusbar-update statusbar-update--busy" aria-live="polite" title={updateTitle}>
          Installing — back in a moment
        </span>
      )}
      {ready && !update.installing && (
        <button
          type="button"
          className="statusbar-update"
          title={updateTitle}
          onClick={() => setConfirmInstall(true)}
        >
          {update.failed ? 'Install didn’t start — try again' : 'Update ready · Install'}
        </button>
      )}
      {confirmInstall && ready && (
        <ConfirmDialog
          message="Install the update?"
          detail={`JakeTunes will pause, close and come back in about 20 seconds.${ready.note ? `\n${ready.note}` : ''}`}
          confirmLabel="Install"
          cancelLabel="Not now"
          destructive={false}
          onConfirm={() => { setConfirmInstall(false); void update.install() }}
          onCancel={() => setConfirmInstall(false)}
        />
      )}
    </div>
  )
}
