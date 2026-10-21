/**
 * A concert starts at the top. Full stop.
 *
 * Jake, repeatedly and finally on 2026-08-08: "why am i able to select a
 * track in live concert mode....it should start from track 1 thats it."
 * A show is one continuous performance. The setlist (and the desktop's
 * "start to finish" strip) is a MAP of where you are, not a menu to jump
 * around in. So every click on a concert's songs — a setlist row, a strip
 * segment, the Play button — means the same thing:
 *
 *   • this show is not the current track → start it from 0:00
 *     (and switch off a stale repeat-one, which would loop the whole set);
 *   • this show IS the current track → do nothing. Restarting the concert
 *     on a stray click would be its own kind of annoying.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/LiveConcertsView.swift
 *    `LiveConcertDetailView.startShow()` — the phone's rule this mirrors.
 *    Change one, change both.
 *
 * Pure: no imports, no IPC.
 */

export type ConcertRepeatMode = 'off' | 'all' | 'one'

export type ConcertStartPlan =
  | { action: 'none' }
  | { action: 'play-from-top'; clearRepeatOne: boolean }

export function planConcertStart(o: { showIsCurrent: boolean; repeat: ConcertRepeatMode }): ConcertStartPlan {
  if (o.showIsCurrent) return { action: 'none' }
  return { action: 'play-from-top', clearRepeatOne: o.repeat === 'one' }
}
