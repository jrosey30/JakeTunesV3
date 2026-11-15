/**
 * The one dialog that asks "Add it to punkPod too?" (renderer/ipodPlaylistAdd.ts).
 * Mounted once, beside the sidebar, so a drop, a right-click and the playlist page
 * all ask the same way.
 */
import { useSyncExternalStore } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { getIpodQuestion, subscribeIpodQuestion } from '../ipodPlaylistAdd'

export default function IpodPlaylistQuestion() {
  const q = useSyncExternalStore(subscribeIpodQuestion, getIpodQuestion)
  if (!q) return null
  return (
    <ConfirmDialog
      message={q.message}
      detail={q.detail}
      confirmLabel={q.confirmLabel}
      cancelLabel={q.cancelLabel}
      destructive={false}
      hideCancel={q.inform}
      onConfirm={() => q.answer(true)}
      onCancel={() => q.answer(q.inform)}
    />
  )
}
