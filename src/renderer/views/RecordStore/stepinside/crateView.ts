/**
 * The sleeves in one bin.
 *
 * What a crate actually looks like, and what this does:
 *
 *   • It is FULL. Every record is drawn, every frame, packed at ~9 mm.
 *     The run of sleeve tops behind the one you're on is the single
 *     strongest cue that you are in a crate and not looking at a card on
 *     a table.
 *   • A sleeve is an object: a thin box with the cover on its face, kraft
 *     card on its back, spine and edges. Tipped over, it shows its back.
 *   • The bin is sized to the records (world.ts BIN), so the stack fills
 *     it wall to wall and the base is never visible.
 *   • Flipping: the ones you've passed tip FORWARD onto the front rail
 *     and rest there, the way a dug crate looks; the one you're on lifts
 *     a hand's width and leans back to face you at the rail.
 *   • Pulling is two moves, not a pop-up: the record rises straight out
 *     of its slot until its bottom edge clears the rail and the pile, THEN
 *     comes forward and tilts back into your hands. Sliding it back runs
 *     the same path in reverse — forward-then-down would drag it through
 *     the front wall.
 *   • Dividers are plain index cards with a printed tab, wherever the
 *     shop plan puts a section (letter ranges in a genre bin, genre names
 *     in the mixed bin). Every card and every sleeve has a slot of its
 *     own at the pack pitch: a card wedged half a slot between two
 *     sleeves z-fights and the covers bleed through it.
 *   • Covers load small (256 px) — nine bins of full-size art would be
 *     gigabytes of texture — and the record you're on swaps to the full
 *     file while you look at it.
 *
 * All motion is critically damped and frame-rate independent.
 */
import * as THREE from 'three'
import { BIN } from './world'
import { kraftTexture, labelTexture } from './textures'
import type { Section } from './shopPlan'
import type { CrateRecord } from './types'

const SLEEVE = 0.62
const THICK = 0.006
const SPACING = 0.0092
const LEAN = 0.10                 // the packed stack leans back a touch
// Flipped-past records lean forward INSIDE the bin against the front wall,
// tops over the rail. A leaning record TOUCHES the wall: with the wall
// 0.30 m above the base, a pivot 0.11 m inside and a 0.34 rad lean put the
// sleeve's face on the rail's inner edge.
const PASSED = 0.34
const PASSED_INSET = 0.11
// Pitch of the flipped pile. Sleeves are 6 mm thick: anything tighter has
// coplanar faces fighting and the cover behind a card shows through it.
const PILE_PITCH = 0.011
// The one you're on is lifted a hand's width — the way a digger tips a
// record up out of the pack to see it — and leans back toward eyes at the
// rail. From there the flipped pile hides its bottom quarter, which is
// what a crate looks like; pulling it out is how you see the rest.
const SEL_LIFT = 0.10
const SEL_TILT = -0.26
// While digging, the pack BEHIND the selection leans back with it, a touch
// further, so the selection never leans into the sleeve behind it.
const STACK_TILT = -0.30
// Held pose: pivot just past the front wall, leaned back ~30° so it squares
// up to a face at the rail. The lift clears the TALLEST thing in the pile
// from the eye's line of sight — a divider's tab, 10 cm over the sleeve
// tops — not just the sleeves. 0.52 cleared the sleeves and put the record's
// foot behind the tabs, and the cover showed through the gap above them.
const HOLD_LIFT = 0.66
const HOLD_FWD = 0.02
const HOLD_TILT = -0.55
const PULL_SECONDS = 0.55
const SMALL_COVER = 256

export interface CrateView {
  group: THREE.Group
  /** `digging` false = nobody is at the bin: every record packed and upright,
   *  no selection, nothing tipped. The lifted pose exists only mid-dig. */
  update: (index: number, pulled: boolean, dt: number, digging: boolean) => void
  /** Where the eye should rest, in the crate's local frame: the face of the
   *  record you're on, or the centre of the one in your hands. */
  focus: (index: number, pulled: boolean) => { y: number; z: number }
  /** Load the full-size cover for the record you're on; null when nobody
   *  is at the bin. Everything else stays at the small size. */
  setFocus: (index: number | null) => void
  dispose: () => void
}

const ease = (t: number): number => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

function prepare(tex: THREE.Texture): THREE.Texture {
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  return tex
}

export function buildCrateView(records: CrateRecord[], sections: Section[]): CrateView {
  const group = new THREE.Group()
  const loader = new THREE.TextureLoader()
  const disposables: Array<{ dispose: () => void }> = []
  let alive = true

  const kraft = kraftTexture('#b9a07a', 11)
  const kraftDark = kraftTexture('#8f7a5c', 12)
  disposables.push(kraft, kraftDark)
  const edgeMat = new THREE.MeshLambertMaterial({ map: kraftDark })
  const backMat = new THREE.MeshLambertMaterial({ map: kraft })
  disposables.push(edgeMat, backMat)

  // One geometry for every sleeve. Box faces: +x, -x, +y, -y, +z (front), -z (back).
  const sleeveGeo = new THREE.BoxGeometry(SLEEVE, SLEEVE, THICK)
  disposables.push(sleeveGeo)

  // The pack is anchored at the BACK of the bin. Digging moves records to a
  // pile at the front wall, so the gap opens exactly where you are and the
  // record you're on can stand in it — in the crate, not lifted out of it.
  // 20 cm behind the pack so it can lean back with the selection without
  // the last record's top going through the back wall.
  const backZ = -BIN.innerHalfZ + 0.20
  const frontZ = BIN.innerHalfZ
  const n = records.length
  // Slot 0 is the front. A record's slot counts the cards in front of it.
  const cardsBefore = (i: number): number => sections.filter((sec) => sec.at <= i).length
  const slotOfRecord = (i: number): number => i + cardsBefore(i)
  const slotOfCard = (k: number): number => slotOfRecord(sections[k].at) - 1
  const slots = n + sections.length
  const zForSlot = (sl: number): number => backZ + (slots - 1 - sl) * SPACING
  const zFor = (i: number): number => zForSlot(slotOfRecord(i))

  // Covers: small for the pack, the full file for the one in focus.
  const faceMats: THREE.MeshLambertMaterial[] = []
  const small: Array<THREE.Texture | null> = records.map(() => null)
  let focusIndex: number | null = null
  let focusTex: THREE.Texture | null = null
  const applyFace = (i: number, tex: THREE.Texture | null): void => {
    const m = faceMats[i]
    if (!m) return
    m.map = tex
    m.color.set(tex ? 0xffffff : 0xd8cbb0)
    m.needsUpdate = true
  }

  const pivots: THREE.Group[] = []
  records.forEach((rec, i) => {
    const faceMat = new THREE.MeshLambertMaterial({ color: 0xd8cbb0 })
    faceMats.push(faceMat)
    disposables.push(faceMat)
    if (rec.coverUrl) {
      loader.load(rec.coverUrl, (tex) => {
        if (!alive) { tex.dispose(); return }
        // Downscale on a canvas: 48 sleeves × 9 bins at full size is
        // gigabytes of GPU memory; at 256 px it is a hundred megabytes.
        const c = document.createElement('canvas')
        c.width = SMALL_COVER
        c.height = SMALL_COVER
        c.getContext('2d')!.drawImage(tex.image as CanvasImageSource, 0, 0, SMALL_COVER, SMALL_COVER)
        tex.dispose()
        const s = prepare(new THREE.CanvasTexture(c))
        small[i] = s
        if (focusIndex !== i || !focusTex) applyFace(i, s)
      }, undefined, () => { /* blank board: what an unsleeved record looks like */ })
    }
    const mesh = new THREE.Mesh(sleeveGeo, [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, backMat])
    mesh.position.y = SLEEVE / 2
    const pivot = new THREE.Group()          // pivot on the bottom edge: it tips on its spine
    pivot.add(mesh)
    pivot.position.set(0, BIN.baseTop, zFor(i))
    pivot.rotation.x = -LEAN
    group.add(pivot)
    pivots.push(pivot)
  })

  const setFocus = (index: number | null): void => {
    const i = index === null ? null : Math.max(0, Math.min(n - 1, index))
    if (i === focusIndex) return
    if (focusIndex !== null) applyFace(focusIndex, small[focusIndex])
    focusTex?.dispose()
    focusTex = null
    focusIndex = i
    if (i === null) return
    const rec = records[i]
    if (!rec.coverUrl) return
    loader.load(rec.coverUrl, (tex) => {
      if (!alive || focusIndex !== i) { tex.dispose(); return }
      focusTex = prepare(tex)
      applyFace(i, focusTex)
    }, undefined, () => { /* keep the small one */ })
  }

  // Dividers: index cards, a little taller than the sleeves, with a printed
  // tab, staggered left/centre/right like a cut-tab set.
  const cardMat = new THREE.MeshLambertMaterial({ color: 0xece6d6 })
  const cardEdgeMat = new THREE.MeshLambertMaterial({ color: 0xd6cfbd })
  const dividerGeo = new THREE.BoxGeometry(SLEEVE + 0.04, SLEEVE + 0.03, 0.004)
  const tabGeo = new THREE.BoxGeometry(0.20, 0.07, 0.004)
  disposables.push(cardMat, cardEdgeMat, dividerGeo, tabGeo)
  const dividers: Array<{ pivot: THREE.Group; index: number; slot: number }> = []
  sections.forEach((sec, k) => {
    if (sec.at < 0 || sec.at >= n) return
    const label = labelTexture(sec.label)
    const labelMat = new THREE.MeshLambertMaterial({ map: label })
    disposables.push(label, labelMat)
    const pivot = new THREE.Group()
    const card = new THREE.Mesh(dividerGeo, [cardEdgeMat, cardEdgeMat, cardEdgeMat, cardEdgeMat, cardMat, cardMat])
    card.position.y = (SLEEVE + 0.03) / 2
    pivot.add(card)
    const tab = new THREE.Mesh(tabGeo, [cardEdgeMat, cardEdgeMat, cardEdgeMat, cardEdgeMat, labelMat, cardMat])
    tab.position.set(-0.19 + (k % 3) * 0.19, SLEEVE + 0.03 + 0.03, 0)
    pivot.add(tab)
    const slot = slotOfCard(k)
    pivot.position.set(0, BIN.baseTop, zForSlot(slot))
    pivot.rotation.x = -LEAN
    group.add(pivot)
    dividers.push({ pivot, index: sec.at, slot })
  })

  const settle = (obj: THREE.Object3D, rot: number, y: number, z: number, k: number): void => {
    obj.rotation.x += (rot - obj.rotation.x) * k
    obj.position.y += (y - obj.position.y) * k
    obj.position.z += (z - obj.position.z) * k
  }

  // Where a flipped item rests: tipped onto the front rail, in the order
  // it was flipped — the first one is at the front. Past 14 deep the pile
  // stops growing; the ones behind are hidden by the ones in front anyway.
  const pileZ = (slot: number): number => frontZ - PASSED_INSET - Math.min(slot, 14) * PILE_PITCH

  // Progress along the pull path, 0 = in its slot, 1 = in your hands.
  // Lift runs over the first 55 % of the path, the forward move over the
  // last 60 %; they overlap only once the bottom edge is over the pile.
  let pullT = 0
  let pullIndex = -1
  const heldPose = (i: number, t: number): { rot: number; y: number; z: number } => {
    const up = ease(t / 0.55)
    const fwd = ease((t - 0.4) / 0.6)
    return {
      rot: lerp(SEL_TILT, HOLD_TILT, fwd),
      y: BIN.baseTop + lerp(SEL_LIFT, HOLD_LIFT, up),
      z: lerp(zFor(i), frontZ + HOLD_FWD, fwd),
    }
  }

  const update = (index: number, pulled: boolean, dt: number, digging: boolean): void => {
    const k = 1 - Math.exp(-12 * dt)
    if (!digging) {
      pullT = 0
      pullIndex = -1
      // Walk away and the crate settles back to a packed bin — the record
      // you were on slides home, the tipped ones stand back up.
      for (let i = 0; i < pivots.length; i++) settle(pivots[i], -LEAN, BIN.baseTop, zFor(i), k)
      for (const d of dividers) settle(d.pivot, -LEAN, BIN.baseTop, zForSlot(d.slot), k)
      return
    }
    // Flipping to another record drops whatever was in hand straight back.
    if (pullIndex !== index) { pullT = 0; pullIndex = index }
    const step = dt / PULL_SECONDS
    pullT = pulled ? Math.min(1, pullT + step) : Math.max(0, pullT - step)

    for (let i = 0; i < pivots.length; i++) {
      const p = pivots[i]
      const rel = i - index
      if (rel < 0) settle(p, PASSED, BIN.baseTop, pileZ(slotOfRecord(i)), k)
      else if (rel === 0) {
        const h = heldPose(i, pullT)
        settle(p, h.rot, h.y, h.z, Math.min(1, 2.2 * k))
      }
      else settle(p, STACK_TILT, BIN.baseTop, zFor(i), k)
    }
    for (const d of dividers) {
      // The card that files the section you're in sits in front of the
      // record you're on: it has been flipped past too.
      if (d.index <= index) settle(d.pivot, PASSED, BIN.baseTop, pileZ(d.slot), k)
      else settle(d.pivot, STACK_TILT, BIN.baseTop, zForSlot(d.slot), k)
    }
  }

  const focus = (index: number, pulled: boolean): { y: number; z: number } => {
    const i = Math.max(0, Math.min(n - 1, index))
    if (pulled) {
      // Centre of the held sleeve. rotation.x < 0 leans the top toward -z.
      const half = SLEEVE / 2
      return {
        y: BIN.baseTop + HOLD_LIFT + half * Math.cos(HOLD_TILT),
        z: frontZ + HOLD_FWD + half * Math.sin(HOLD_TILT),
      }
    }
    // A little above the visible centre of the face: the pile hides its foot.
    return { y: BIN.baseTop + SEL_LIFT + 0.36, z: zFor(i) }
  }

  const dispose = (): void => {
    alive = false
    for (const d of disposables) d.dispose()
    for (const s of small) s?.dispose()
    focusTex?.dispose()
  }

  return { group, update, focus, setFocus, dispose }
}
