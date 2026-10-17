/**
 * Hardware-arrival navigation (2026-10-17): plugging in the iPod (when
 * "Open JakeTunes when this iPod is connected" is on) opens the Device page;
 * a NEW audio CD opens the CD Import page — the way iTunes did.
 *
 * Moving the page out from under someone is only OK when nothing is in
 * flight: never during an iPod sync, never during a rip/import, never with
 * a modal open (a view-owned modal like Get Info unmounts with its view and
 * would take unsaved edits with it).
 *
 * Pure — node --test loads it.
 */

export interface AutoNavBusy {
  syncing: boolean
  ripping: boolean
  modalOpen: boolean
}

export function autoNavHeld(b: AutoNavBusy): boolean {
  return b.syncing || b.ripping || b.modalOpen
}

/**
 * CD presence as the sidebar's 2.5 s poll sees it. The first poll is the
 * BASELINE (a disc already in the drive at launch is not "new"), and a disc
 * only counts as gone after two misses in a row — a drive busy mid-rip can
 * drop one poll, and that flicker must not read as eject + re-insert.
 */
export interface CdPresence {
  seeded: boolean
  present: boolean
  missStreak: number
}

export const CD_PRESENCE_START: CdPresence = { seeded: false, present: false, missStreak: 0 }

export function stepCdPresence(prev: CdPresence, hasCd: boolean): { next: CdPresence; newDisc: boolean } {
  if (!prev.seeded) {
    return { next: { seeded: true, present: hasCd, missStreak: 0 }, newDisc: false }
  }
  if (hasCd) {
    return { next: { seeded: true, present: true, missStreak: 0 }, newDisc: !prev.present }
  }
  const missStreak = prev.missStreak + 1
  return {
    next: { seeded: true, present: missStreak >= 2 ? false : prev.present, missStreak },
    newDisc: false,
  }
}
