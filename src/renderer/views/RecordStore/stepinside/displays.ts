/**
 * Face-out sleeves — the wall racks, the window, the staff picks.
 *
 * A shop's walls are the second thing you read after the bins: rows of
 * covers facing the room, standing on a ledge, leaning on the wall. This
 * builds one such display in its own frame (x across, y up, +z toward
 * the room) from real records; world.ts decides where the frames hang.
 *
 * Covers load at 256 px — a wall is read from across the room.
 */
import * as THREE from 'three'
import { kraftTexture } from './textures'
import type { CrateRecord } from './types'

const SLEEVE = 0.62
const THICK = 0.008
const GAP = 0.08
const ROW_GAP = 0.10
const LEAN = 0.12                 // leans back on the wall
const SMALL_COVER = 256

export interface DisplaySlot { rows: number; cols: number }

export interface FaceOutDisplay {
  group: THREE.Group
  /** Put these records up, first record top-left. Extra records are ignored;
   *  empty slots stay empty — a wall with gaps is a wall, not a bug. */
  show: (records: Array<Pick<CrateRecord, 'coverUrl'>>) => void
  dispose: () => void
}

/** Width and height of a display with this many slots, for the panel behind it. */
export function displaySize(slot: DisplaySlot): { w: number; h: number } {
  return {
    w: slot.cols * SLEEVE + (slot.cols - 1) * GAP,
    h: slot.rows * SLEEVE + (slot.rows - 1) * ROW_GAP,
  }
}

export function buildFaceOutDisplay(slot: DisplaySlot, loader = new THREE.TextureLoader()): FaceOutDisplay {
  const group = new THREE.Group()
  const disposables: Array<{ dispose: () => void }> = []
  let alive = true

  const kraft = kraftTexture('#b9a07a', 11)
  const edge = new THREE.MeshLambertMaterial({ map: kraft })
  const geo = new THREE.BoxGeometry(SLEEVE, SLEEVE, THICK)
  disposables.push(kraft, edge, geo)
  const { w, h } = displaySize(slot)

  const faces: THREE.MeshLambertMaterial[] = []
  const textures: Array<THREE.Texture | null> = []
  for (let r = 0; r < slot.rows; r++) {
    for (let c = 0; c < slot.cols; c++) {
      const face = new THREE.MeshLambertMaterial({ color: 0xd8cbb0 })
      disposables.push(face)
      faces.push(face)
      textures.push(null)
      const mesh = new THREE.Mesh(geo, [edge, edge, edge, edge, face, edge])
      mesh.position.y = SLEEVE / 2
      const pivot = new THREE.Group()
      pivot.add(mesh)
      // Rows fill top-down; the pivot is the sleeve's bottom edge on its ledge.
      pivot.position.set(
        -w / 2 + SLEEVE / 2 + c * (SLEEVE + GAP),
        h - (r + 1) * SLEEVE - r * ROW_GAP,
        0,
      )
      pivot.rotation.x = -LEAN
      group.add(pivot)
      // The ledge each row stands on.
      if (c === 0) {
        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(w + 0.16, 0.025, 0.14),
          new THREE.MeshLambertMaterial({ color: 0x2f3830 }),
        )
        ledge.position.set(0, pivot.position.y - 0.0125, 0.03)
        group.add(ledge)
      }
    }
  }
  // Hide every slot until it has a record: an empty kraft board on a wall
  // is a mistake, an empty stretch of wall is a wall.
  group.children.forEach((child) => { if (child instanceof THREE.Group) child.visible = false })

  const show = (records: Array<Pick<CrateRecord, 'coverUrl'>>): void => {
    const pivots = group.children.filter((c): c is THREE.Group => c instanceof THREE.Group)
    pivots.forEach((pivot, i) => {
      const rec = records[i]
      pivot.visible = Boolean(rec)
      if (!rec?.coverUrl) return
      const url = rec.coverUrl
      loader.load(url, (tex) => {
        if (!alive) { tex.dispose(); return }
        const c = document.createElement('canvas')
        c.width = SMALL_COVER
        c.height = SMALL_COVER
        c.getContext('2d')!.drawImage(tex.image as CanvasImageSource, 0, 0, SMALL_COVER, SMALL_COVER)
        tex.dispose()
        const small = new THREE.CanvasTexture(c)
        small.colorSpace = THREE.SRGBColorSpace
        small.anisotropy = 4
        textures[i]?.dispose()
        textures[i] = small
        faces[i].map = small
        faces[i].color.set(0xffffff)
        faces[i].needsUpdate = true
      }, undefined, () => { /* blank board */ })
    })
  }

  const dispose = (): void => {
    alive = false
    for (const d of disposables) d.dispose()
    for (const t of textures) t?.dispose()
  }

  return { group, show, dispose }
}
