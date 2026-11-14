import { useMemo, useState } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useRegularLibraryTracks } from '../../hooks/useRegularLibraryTracks'
import { useUpdateReady } from '../../hooks/useUpdateReady'
import ConfirmDialog from '../ConfirmDialog'
import UpdateChoices from './UpdateChoices'

export default function StatusBar() {
  const { state } = useLibrary()
  // Declared full concerts don't count as songs — footer reflects the regular library.
  const tracks = useRegularLibraryTracks(state.tracks)
  // 2026-10-30: a new build staged at the install gate shows here, on every
  // page (this bar is global), and Jake pushes it through himself.
  const update = useUpdateReady()
  // 2026-11-14: three answers — Install now, Install at…, Skip to next week (UpdateChoices.tsx).
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [confirmSkip, setConfirmSkip] = useState(false)

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

  return (
    <div className={ready ? 'statusbar statusbar--update' : 'statusbar'}>
      <span className="statusbar-info">{summary}</span>
      {ready && (
        <UpdateChoices
          ready={ready}
          installing={update.installing}
          failed={update.failed}
          afterSync={update.afterSync}
          now={Date.now()}
          onInstallNow={() => setConfirmInstall(true)}
          onInstallAt={update.installAt}
          onSkip={() => setConfirmSkip(true)}
          onCancel={() => { void update.cancel() }}
        />
      )}
      {confirmInstall && ready && (
        <ConfirmDialog
          message="Install the update?"
          detail={`JakeTunes will pause, close and come back in about 20 seconds.${ready.notes.length ? `\n${ready.notes.join('\n')}` : ready.note ? `\n${ready.note}` : ''}`}
          confirmLabel="Install"
          cancelLabel="Not now"
          destructive={false}
          onConfirm={() => { setConfirmInstall(false); void update.install() }}
          onCancel={() => setConfirmInstall(false)}
        />
      )}
      {confirmSkip && ready && (
        <ConfirmDialog
          message="Skip this update?"
          detail="It won’t be offered on this Mac again. Next week’s update replaces it."
          confirmLabel="Skip"
          cancelLabel="Keep it"
          destructive={false}
          onConfirm={() => { setConfirmSkip(false); void update.skip() }}
          onCancel={() => setConfirmSkip(false)}
        />
      )}
    </div>
  )
}
