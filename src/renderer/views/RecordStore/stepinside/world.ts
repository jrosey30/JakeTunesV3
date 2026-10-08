/**
 * The block and the shop — one continuous space, deliberately.
 *
 * There is no scene swap at the door. You walk off the sidewalk, through
 * the doorway, and you are inside; the shop interior sits behind the
 * facade in the same world. A loading screen at the threshold would kill
 * the exact moment the brief asked to get right.
 *
 * PS2 look, honestly earned rather than filtered: low-poly boxes, flat
 * Lambert shading, one bounce of hemisphere light, and heavy fog standing
 * in for draw distance. The renderer draws at a low internal resolution
 * and the canvas upscales it, which is where the chunky pixels come from.
 */
import * as THREE from 'three'
import type { Blocker } from './playerModel'
import { woodTexture, plasterTexture, floorboardTexture, contactShadowTexture, labelTexture } from './textures'
import { BINS, type BinDef } from './shopPlan'
import { displaySize, type DisplaySlot } from './displays'

export const SHOP_DOOR_Z = -6
export const SHOP_INTERIOR = { minX: -7, maxX: 7, minZ: -19, maxZ: SHOP_DOOR_Z }
// Bins are laid out by shopPlan.ts (three rows, rails facing the door).
// The listening station stands against the right wall between the first
// two rows.
export const STATION_POS = new THREE.Vector3(6.0, 0, -10.9)
export const SPAWN = { x: 0, z: 4.5 }

const PALETTE = {
  road: 0x4a4c55,
  sidewalk: 0x8d8b84,
  brickA: 0x8a5a48,
  brickB: 0x5e6474,
  // The room is NOT brown. Walls are a cool, desaturated green so warm
  // sleeves and warm wood read against them; the floor is a cold grey
  // board. Jake: "records, furniture and the room merge into one brown
  // shape" — this palette exists to stop that.
  shopWall: 0x6f8270,
  shopWallTrim: 0x2f3830,
  shopFloor: 0x4b4f58,
  ceiling: 0x1d2024,
  // Furniture is dark and matte so bright cover art sits on top of it.
  binBody: 0x4a3122,
  binRim: 0x2c1d14,
  binBase: 0x1a1a1e,
  divider: 0xd9c48a,        // manila card — the one light thing in the bin
  counter: 0x33241a,
  awning: 0xa83f2c,
  sky: 0x5a6a8c,
}

/** The bin is sized to the RECORDS, not the other way round. A real crate
 *  is barely wider than a 12" sleeve and holds ~50 LPs in half a metre of
 *  depth; the old one was three sleeves wide and read as a bathtub with one
 *  record in it. Everything in crateView.ts is laid out from these. */
export const BIN = {
  innerHalfX: 0.345,    // 0.69 m — a sleeve is 0.62, plus finger room
  innerHalfZ: 0.42,     // 0.84 m deep: 48 records at ~9 mm fill half, the other
                        // half is the room a dig needs — flipped ones pile at the
                        // front, the one you're on stands in the gap, IN the crate
  wallTop: 0.96,        // waist height; the rim you look over
  baseTop: 0.66,        // what the sleeves stand on
  wallThick: 0.035,
}

export interface WorldHandles {
  scene: THREE.Scene
  blockers: Blocker[]
  /** One anchor per bin, keyed by shopPlan id; crateView groups go here. */
  bins: Map<string, THREE.Object3D>
  /** Face-out displays — wall racks, the window, the staff-picks wall.
   *  Each anchor's +z faces the room; the view hangs sleeves in them. */
  displays: Array<{ id: string; anchor: THREE.Object3D; slot: DisplaySlot }>
  /** Where concert posters go up: anchors whose +z faces the room, in
   *  the order the wall fills. Empty slots stay empty wall. */
  posterSlots: THREE.Object3D[]
  stationAnchor: THREE.Object3D
  /** The sleeve of whatever is on the deck, propped on the shelf behind
   *  it. Hidden until the view gives it a cover. */
  deckSleeve: THREE.MeshLambertMaterial
  deckSleeveMesh: THREE.Object3D
  /** Spinning platter on the listening station — turned by the loop. */
  platter: THREE.Mesh
  dispose: () => void
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }),
  )
  m.castShadow = false
  m.receiveShadow = false
  return m
}

/** A soft shadow decal on the floor under a piece of furniture, so it
 *  stands ON the boards instead of floating over them. */
const shadowTex = contactShadowTexture()
function contactShadow(w: number, d: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 0.7, d + 0.7),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.55, depthWrite: false }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.045
  m.renderOrder = 1
  return m
}

/** A wall that also blocks the player. Keeps geometry and collision in
 *  step — a wall you can walk through is worse than no wall. */
function wall(
  scene: THREE.Scene, blockers: Blocker[],
  x: number, z: number, w: number, h: number, d: number, color: number,
): THREE.Mesh {
  const m = box(w, h, d, color)
  m.position.set(x, h / 2, z)
  scene.add(m)
  blockers.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 })
  return m
}

export function buildWorld(): WorldHandles {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PALETTE.sky)
  // Fog is the draw distance. It also hides the fact that the block ends.
  scene.fog = new THREE.Fog(PALETTE.sky, 18, 46)

  const disposables: Array<{ dispose: () => void }> = []
  const blockers: Blocker[] = []

  scene.add(new THREE.HemisphereLight(0xbfd0ec, 0x4a3a2e, 1.9))
  scene.add(new THREE.AmbientLight(0xffffff, 0.32))
  const key = new THREE.DirectionalLight(0xffd9a8, 2.4)
  key.position.set(-6, 12, 8)
  scene.add(key)
  // A warm pool inside so the shop reads as lit from within, not by the sky.
  const interior = new THREE.PointLight(0xffc98a, 50, 24, 2)
  interior.position.set(0, 3.4, -12.5)
  scene.add(interior)

  // ── The street ──
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 14),
    new THREE.MeshLambertMaterial({ color: PALETTE.road }),
  )
  road.rotation.x = -Math.PI / 2
  road.position.set(0, 0, 7)
  scene.add(road)

  const sidewalk = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 6),
    new THREE.MeshLambertMaterial({ color: PALETTE.sidewalk }),
  )
  sidewalk.rotation.x = -Math.PI / 2
  sidewalk.position.set(0, 0.02, -3)
  scene.add(sidewalk)
  // Kerb: the sidewalk has an edge.
  const kerb = box(80, 0.14, 0.18, 0x7a7872)
  kerb.position.set(0, 0.07, 0)
  scene.add(kerb)

  // Neighbouring storefronts — solid, so the block has edges you feel —
  // with windows and doors so they are buildings and not slabs.
  for (const [x, w, c] of [[-16, 12, PALETTE.brickA], [16, 12, PALETTE.brickB]] as const) {
    wall(scene, blockers, x, -9, w, 9, 7, c)
    const face = -9 + 3.5 + 0.02
    for (let i = 0; i < 4; i++) {
      const wx = x - w / 2 + 1.5 + i * 3
      for (const wy of [2.3, 4.7, 7.1]) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.5), new THREE.MeshLambertMaterial({ color: 0x1b2330 }))
        win.position.set(wx, wy, face)
        scene.add(win)
        const sill = box(1.3, 0.08, 0.12, 0xbdb6a6)
        sill.position.set(wx, wy - 0.79, face + 0.05)
        scene.add(sill)
      }
    }
    const door = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 2.4), new THREE.MeshLambertMaterial({ color: 0x2a2320 }))
    door.position.set(x + (x < 0 ? 4 : -4), 1.2, face)
    scene.add(door)
  }
  // Kerb line and the far side of the street, so you can't wander to sea.
  wall(scene, blockers, 0, 15, 80, 8, 3, PALETTE.brickB)
  wall(scene, blockers, -26, 0, 3, 9, 40, PALETTE.brickA)
  wall(scene, blockers, 26, 0, 3, 9, 40, PALETTE.brickB)

  // Street furniture: two lampposts and a tree pit.
  for (const lx of [-9.5, 9.5]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.8, 8), new THREE.MeshLambertMaterial({ color: 0x23262b }))
    post.position.set(lx, 1.9, -0.6)
    scene.add(post)
    const head = box(0.5, 0.22, 0.3, 0x23262b)
    head.position.set(lx, 3.85, -0.6)
    scene.add(head)
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe9c4 }))
    glow.position.set(lx, 3.72, -0.6)
    scene.add(glow)
    const lamp = new THREE.PointLight(0xffe0b0, 14, 12, 2)
    lamp.position.set(lx, 3.7, -0.6)
    scene.add(lamp)
    blockers.push({ minX: lx - 0.12, maxX: lx + 0.12, minZ: -0.72, maxZ: -0.48 })
  }
  {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 2.2, 7), new THREE.MeshLambertMaterial({ color: 0x4a3524 }))
    trunk.position.set(-13, 1.1, -1.4)
    scene.add(trunk)
    for (const [ty, r] of [[2.6, 1.1], [3.4, 0.8]] as const) {
      const crown = new THREE.Mesh(new THREE.ConeGeometry(r, 1.3, 7), new THREE.MeshLambertMaterial({ color: 0x3f5a35 }))
      crown.position.set(-13, ty, -1.4)
      scene.add(crown)
    }
    blockers.push({ minX: -13.2, maxX: -12.8, minZ: -1.6, maxZ: -1.2 })
  }

  // ── The shop shell: front wall with a doorway in the middle and a
  // display window either side. The windows are real holes: sill, header
  // and piers, glass on the street face, a ledge of face-out sleeves in
  // the opening (the street sees covers; the room sees their backs).
  const FRONT_H = 5.2
  const displays: WorldHandles['displays'] = []
  for (const side of [-1, 1] as const) {
    const cx = side * 4.5
    wall(scene, blockers, cx, SHOP_DOOR_Z, 5, 0.9, 0.6, PALETTE.shopWall)                 // sill
    const header = box(5, FRONT_H - 2.9, 0.6, PALETTE.shopWall)
    header.position.set(cx, 2.9 + (FRONT_H - 2.9) / 2, SHOP_DOOR_Z)
    scene.add(header)
    wall(scene, blockers, side * 6.7, SHOP_DOOR_Z, 0.6, FRONT_H, 0.6, PALETTE.shopWall)   // outer pier
    wall(scene, blockers, side * 2.3, SHOP_DOOR_Z, 0.6, FRONT_H, 0.6, PALETTE.shopWall)   // inner pier
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(3.8, 2.0),
      new THREE.MeshLambertMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
    )
    glass.position.set(cx, 1.9, SHOP_DOOR_Z + 0.31)
    scene.add(glass)
    const winAnchor = new THREE.Object3D()
    winAnchor.position.set(cx, 0.92, SHOP_DOOR_Z - 0.02)
    scene.add(winAnchor)
    displays.push({ id: side < 0 ? 'window-left' : 'window-right', anchor: winAnchor, slot: { rows: 1, cols: 5 } })
  }
  // Lintel over the door — geometry only, you walk under it — and the
  // shop's name on it.
  const lintel = box(4, 1.2, 0.6, PALETTE.shopWall)
  lintel.position.set(0, FRONT_H - 0.6, SHOP_DOOR_Z)
  scene.add(lintel)
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 0.7),
    new THREE.MeshLambertMaterial({ map: labelTexture('WJLR RECORDS', 3.6 / 0.7, '#2f3830', '#f3eee2') }),
  )
  sign.position.set(0, FRONT_H - 0.55, SHOP_DOOR_Z + 0.31)
  scene.add(sign)

  const awning = box(14, 0.35, 2.2, PALETTE.awning)
  awning.position.set(0, FRONT_H + 0.1, SHOP_DOOR_Z + 1.1)
  scene.add(awning)

  // Interior shell
  const plaster = plasterTexture('#6f8270', 3)
  for (const m of [
    wall(scene, blockers, SHOP_INTERIOR.minX - 0.3, -12.5, 0.6, FRONT_H, 13, PALETTE.shopWall),
    wall(scene, blockers, SHOP_INTERIOR.maxX + 0.3, -12.5, 0.6, FRONT_H, 13, PALETTE.shopWall),
    wall(scene, blockers, 0, SHOP_INTERIOR.minZ, 15, FRONT_H, 0.6, PALETTE.shopWall),
  ]) { const mm = m.material as THREE.MeshLambertMaterial; mm.map = plaster; mm.color.set(0xffffff) }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 13),
    new THREE.MeshLambertMaterial({ map: floorboardTexture(5, 14) }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0.03, -12.5)
  scene.add(floor)

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 13),
    new THREE.MeshLambertMaterial({ color: PALETTE.ceiling }),
  )
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.set(0, FRONT_H, -12.5)
  scene.add(ceiling)

  // ── Props ──
  // The counter at the back — where the clerk stands.
  { const c = wall(scene, blockers, 0, -17.4, 7, 1.1, 1.2, PALETTE.counter); const cm = c.material as THREE.MeshLambertMaterial; cm.map = woodTexture('#4a3626', '#2e2016', 31, 2); cm.color.set(0xffffff) }

  // Wall displays: a dark panel on the wall with rows of face-out sleeves
  // on ledges, above the wall bins. The right wall's front bay is the
  // listening deck's. Behind the counter: the staff picks.
  const hangDisplay = (id: string, x: number, y: number, z: number, yaw: number, slot: DisplaySlot): void => {
    const { w, h } = displaySize(slot)
    const anchor = new THREE.Object3D()
    anchor.position.set(x, y, z)
    anchor.rotation.y = yaw
    scene.add(anchor)
    // The sleeves lean back 0.12 rad from their ledge; a 0.62 sleeve's top
    // sits 7.4 cm behind its foot. The panel goes BEHIND that — at −0.05 it
    // cut every cover off at the knees and the wall showed a strip of each.
    const panel = box(w + 0.3, h + 0.18, 0.06, PALETTE.shopWallTrim)
    panel.position.set(0, h / 2 + 0.02, -0.13)
    anchor.add(panel)
    displays.push({ id, anchor, slot })
  }
  // 22 cm off the wall face: the panel sits 13 cm behind the anchor and
  // must stay in front of the plaster.
  const LWALL = SHOP_INTERIOR.minX + 0.22
  const RWALL = SHOP_INTERIOR.maxX - 0.22
  hangDisplay('left-front', LWALL, 1.38, -10.15, Math.PI / 2, { rows: 2, cols: 4 })
  hangDisplay('left-back',  LWALL, 1.38, -14.6,  Math.PI / 2, { rows: 2, cols: 4 })
  hangDisplay('right',      RWALL, 1.38, -13.95, -Math.PI / 2, { rows: 2, cols: 4 })
  hangDisplay('picks', 0, 1.55, SHOP_INTERIOR.minZ + 0.52, 0, { rows: 1, cols: 6 })

  // Poster slots: either side of the staff picks on the back wall, the
  // front of the right wall ahead of the deck, and the left wall between
  // the window and the first display.
  const posterSlots: THREE.Object3D[] = []
  const posterSlot = (x: number, y: number, z: number, yaw: number): void => {
    const a = new THREE.Object3D()
    a.position.set(x, y, z)
    a.rotation.y = yaw
    scene.add(a)
    posterSlots.push(a)
  }
  const BACK = SHOP_INTERIOR.minZ + 0.32
  posterSlot(-3.3, 2.45, BACK, 0)
  posterSlot(3.3, 2.45, BACK, 0)
  posterSlot(-4.5, 2.45, BACK, 0)
  posterSlot(4.5, 2.45, BACK, 0)
  posterSlot(RWALL - 0.02, 2.55, -7.5, -Math.PI / 2)
  posterSlot(RWALL - 0.02, 2.55, -8.7, -Math.PI / 2)
  posterSlot(LWALL + 0.02, 2.55, -7.6, Math.PI / 2)
  const picksSign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 0.32),
    new THREE.MeshLambertMaterial({ map: labelTexture('STAFF PICKS', 1.8 / 0.32, '#f3eee2') }),
  )
  picksSign.position.set(0, 2.6, SHOP_INTERIOR.minZ + 0.32)
  scene.add(picksSign)

  // ── The bins you dig in ──
  // Open plywood bins on stands: base the records stand on, four low walls
  // you look over, wood grain on every face, a card with the section name
  // taped to the front rail, a pendant over each. Sized from BIN so the
  // stack fills each one edge to edge. One per entry in the shop plan.
  const binWood = woodTexture('#5a3a26', '#3a2417', 21, 1)
  const binMat = new THREE.MeshLambertMaterial({ map: binWood })
  const standMat = new THREE.MeshLambertMaterial({ map: woodTexture('#2e2119', '#1a120c', 22, 1) })
  const cordMat = new THREE.MeshLambertMaterial({ color: 0x14120f })
  const shadeMat = new THREE.MeshLambertMaterial({ color: PALETTE.shopWallTrim, side: THREE.DoubleSide })
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe6bd })
  const oX = BIN.innerHalfX + BIN.wallThick
  const oZ = BIN.innerHalfZ + BIN.wallThick
  const wallH = BIN.wallTop - BIN.baseTop + 0.06
  const wallY = BIN.baseTop - 0.06 + wallH / 2
  const bins = new Map<string, THREE.Object3D>()

  const buildBin = (def: BinDef): void => {
    const anchor = new THREE.Object3D()
    anchor.position.set(def.x, 0, def.z)
    anchor.rotation.y = def.facing
    scene.add(anchor)
    const addPiece = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
      m.position.set(x, y, z)
      anchor.add(m)
    }
    // Stand: four legs and a shelf, so it is furniture and not a block.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      addPiece(0.05, BIN.baseTop - 0.06, 0.05, sx * (oX - 0.05), (BIN.baseTop - 0.06) / 2, sz * (oZ - 0.05), standMat)
    }
    addPiece(oX * 2, 0.04, oZ * 2, 0, 0.30, 0, standMat)
    // Base + walls
    addPiece(oX * 2, 0.06, oZ * 2, 0, BIN.baseTop - 0.03, 0, binMat)
    addPiece(oX * 2, wallH, BIN.wallThick, 0, wallY, -oZ + BIN.wallThick / 2, binMat)
    addPiece(oX * 2, wallH, BIN.wallThick, 0, wallY,  oZ - BIN.wallThick / 2, binMat)
    addPiece(BIN.wallThick, wallH, oZ * 2, -oX + BIN.wallThick / 2, wallY, 0, binMat)
    addPiece(BIN.wallThick, wallH, oZ * 2,  oX - BIN.wallThick / 2, wallY, 0, binMat)
    anchor.add(contactShadow(oX * 2, oZ * 2))

    // The section card on the front rail.
    const plateW = 0.56
    const plateH = 0.10
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(plateW, plateH),
      new THREE.MeshLambertMaterial({ map: labelTexture(def.label, plateW / plateH, '#f3eee2') }),
    )
    plate.position.set(0, wallY + 0.02, oZ + 0.003)
    anchor.add(plate)

    // A pendant over the front of the bin — the light has a fixture, so the
    // pool on the records comes from somewhere you can see when you walk up.
    // Warm, not orange: the bulb sets the mood of the room, the cover art
    // keeps its own colours. 0xffd9a0 turned a white sleeve 250/235/211.
    const LAMP = new THREE.Vector3(0.1, 2.28, 0.45)
    const lamp = new THREE.PointLight(0xfff0dc, 9, 6, 2)
    lamp.position.copy(LAMP)
    anchor.add(lamp)
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.2, 18, 1, true), shadeMat)
    shade.position.set(LAMP.x, LAMP.y + 0.12, LAMP.z)
    anchor.add(shade)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bulbMat)
    bulb.position.copy(LAMP)
    anchor.add(bulb)
    const cordLen = FRONT_H - (LAMP.y + 0.22)
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, cordLen, 6), cordMat)
    cord.position.set(LAMP.x, LAMP.y + 0.22 + cordLen / 2, LAMP.z)
    anchor.add(cord)

    // Footprint in world axes: a bin turned to face a wall swaps its extents.
    const sideways = Math.abs(Math.sin(def.facing)) > 0.5
    const hx = sideways ? oZ : oX
    const hz = sideways ? oX : oZ
    blockers.push({ minX: def.x - hx, maxX: def.x + hx, minZ: def.z - hz, maxZ: def.z + hz })
    bins.set(def.id, anchor)
  }
  for (const def of BINS) buildBin(def)

  // ── The listening station ──
  // A deck against the right wall, facing the aisle: turntable, tonearm,
  // headphones on a hook, a shelf behind for the sleeve of whatever is
  // on, and a sign so you know what it is for.
  const stationAnchor = new THREE.Object3D()
  stationAnchor.position.copy(STATION_POS)
  stationAnchor.rotation.y = -Math.PI / 2     // local +z faces the aisle (−x)
  scene.add(stationAnchor)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.0), new THREE.MeshLambertMaterial({ map: woodTexture('#4a3626', '#2e2016', 31, 2) }))
  deck.position.set(0, 0.5, 0)
  stationAnchor.add(deck)
  const plinth = box(0.92, 0.10, 0.72, 0x2a2622)
  plinth.position.set(-0.15, 1.05, 0.02)
  stationAnchor.add(plinth)
  const platter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.30, 0.30, 0.03, 24),
    new THREE.MeshLambertMaterial({ color: 0x14141a }),
  )
  platter.position.set(-0.25, 1.115, 0.02)
  stationAnchor.add(platter)
  const spindle = box(0.02, 0.06, 0.02, 0xd8d8d8)
  spindle.position.set(-0.25, 1.15, 0.02)
  stationAnchor.add(spindle)
  const armBase = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 12), new THREE.MeshLambertMaterial({ color: 0xb9bcc4 }))
  armBase.position.set(0.18, 1.125, -0.24)
  stationAnchor.add(armBase)
  const arm = box(0.012, 0.012, 0.36, 0xd0d3da)
  arm.position.set(0.05, 1.15, -0.12)
  arm.rotation.y = -0.55
  stationAnchor.add(arm)
  // Headphones on a hook at the deck's end.
  const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 6), new THREE.MeshLambertMaterial({ color: 0x23262b }))
  hook.position.set(0.7, 1.25, 0.32)
  stationAnchor.add(hook)
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 8, 18, Math.PI), new THREE.MeshLambertMaterial({ color: 0x1c1c20 }))
  band.position.set(0.7, 1.38, 0.32)
  band.rotation.y = Math.PI / 2
  stationAnchor.add(band)
  for (const dz of [-0.11, 0.11]) {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), new THREE.MeshLambertMaterial({ color: 0x2a2a30 }))
    cup.position.set(0.7, 1.36, 0.32 + dz)
    cup.rotation.x = Math.PI / 2
    stationAnchor.add(cup)
  }
  // Shelf on the wall behind, and the sleeve of whatever is on the deck.
  const shelf = box(1.2, 0.03, 0.2, 0x2f3830)
  shelf.position.set(0, 1.28, -0.6)
  stationAnchor.add(shelf)
  const deckSleeve = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const deckSleeveMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.62, 0.008),
    [deckSleeve, deckSleeve, deckSleeve, deckSleeve, deckSleeve, deckSleeve],
  )
  deckSleeveMesh.position.set(0, 1.295 + 0.31, -0.6)
  deckSleeveMesh.rotation.x = -0.12
  deckSleeveMesh.visible = false
  stationAnchor.add(deckSleeveMesh)
  const stationSign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.26),
    new THREE.MeshLambertMaterial({ map: labelTexture('LISTENING STATION', 1.5 / 0.26, '#f3eee2') }),
  )
  stationSign.position.set(0, 2.25, -0.69)
  stationAnchor.add(stationSign)
  stationAnchor.add(contactShadow(1.6, 1.0))
  blockers.push({
    minX: STATION_POS.x - 0.55, maxX: STATION_POS.x + 1.0,
    minZ: STATION_POS.z - 0.85, maxZ: STATION_POS.z + 0.85,
  })

  const dispose = (): void => {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    disposables.forEach((d) => d.dispose())
  }

  return { scene, blockers, bins, displays, posterSlots, stationAnchor, platter, deckSleeve, deckSleeveMesh, dispose }
}
