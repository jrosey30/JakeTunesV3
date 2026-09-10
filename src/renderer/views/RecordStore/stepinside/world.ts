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

export const SHOP_DOOR_Z = -6
export const SHOP_INTERIOR = { minX: -7, maxX: 7, minZ: -19, maxZ: SHOP_DOOR_Z }
export const CRATE_POS = new THREE.Vector3(-2.6, 0, -12)
export const STATION_POS = new THREE.Vector3(3.4, 0, -13.4)
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

/** Records lean back on this angle in the bin, and the whole crate is
 *  built around it, so nothing intersects anything. */
export const BIN = {
  innerHalfX: 0.95,
  innerHalfZ: 0.58,
  wallTop: 0.92,      // the rim you look over
  baseTop: 0.60,      // what the sleeves stand on
  wallThick: 0.055,
}

export interface WorldHandles {
  scene: THREE.Scene
  blockers: Blocker[]
  crateAnchor: THREE.Object3D
  stationAnchor: THREE.Object3D
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
  const interior = new THREE.PointLight(0xffc98a, 70, 24, 2)
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

  // Neighbouring storefronts — solid, so the block has edges you feel.
  for (const [x, w, c] of [[-16, 12, PALETTE.brickA], [16, 12, PALETTE.brickB]] as const) {
    wall(scene, blockers, x, -9, w, 9, 7, c)
  }
  // Kerb line and the far side of the street, so you can't wander to sea.
  wall(scene, blockers, 0, 15, 80, 8, 3, PALETTE.brickB)
  wall(scene, blockers, -26, 0, 3, 9, 40, PALETTE.brickA)
  wall(scene, blockers, 26, 0, 3, 9, 40, PALETTE.brickB)

  // ── The shop shell: front wall with a doorway gap in the middle ──
  const FRONT_H = 5.2
  wall(scene, blockers, -4.5, SHOP_DOOR_Z, 5, FRONT_H, 0.6, PALETTE.shopWall)
  wall(scene, blockers, 4.5, SHOP_DOOR_Z, 5, FRONT_H, 0.6, PALETTE.shopWall)
  // Lintel over the door — geometry only, you walk under it.
  const lintel = box(4, 1.2, 0.6, PALETTE.shopWall)
  lintel.position.set(0, FRONT_H - 0.6, SHOP_DOOR_Z)
  scene.add(lintel)

  const awning = box(14, 0.35, 2.2, PALETTE.awning)
  awning.position.set(0, FRONT_H + 0.1, SHOP_DOOR_Z + 1.1)
  scene.add(awning)

  // Interior shell
  wall(scene, blockers, SHOP_INTERIOR.minX - 0.3, -12.5, 0.6, FRONT_H, 13, PALETTE.shopWall)
  wall(scene, blockers, SHOP_INTERIOR.maxX + 0.3, -12.5, 0.6, FRONT_H, 13, PALETTE.shopWall)
  wall(scene, blockers, 0, SHOP_INTERIOR.minZ, 15, FRONT_H, 0.6, PALETTE.shopWall)

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 13),
    new THREE.MeshLambertMaterial({ color: PALETTE.shopFloor }),
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
  wall(scene, blockers, 0, -17.4, 7, 1.1, 1.2, PALETTE.counter)

  // Wall racks, purely to make the room feel stocked.
  for (const z of [-9.5, -12.5, -15.5]) {
    const rack = box(0.5, 2.2, 2.4, PALETTE.shopWallTrim)
    rack.position.set(SHOP_INTERIOR.minX + 0.4, 1.1, z)
    scene.add(rack)
    const rack2 = box(0.5, 2.2, 2.4, PALETTE.shopWallTrim)
    rack2.position.set(SHOP_INTERIOR.maxX - 0.4, 1.1, z)
    scene.add(rack2)
  }

  // ── The crate you dig in ──
  // An OPEN bin, not a solid block: a base the records stand on, four low
  // walls you look over, and a plinth to the floor. The previous version
  // was one closed box with sleeves floating through its lid, which is the
  // intersection Jake saw.
  const crateAnchor = new THREE.Object3D()
  crateAnchor.position.copy(CRATE_POS)
  scene.add(crateAnchor)

  const binMat = new THREE.MeshLambertMaterial({ color: PALETTE.binBody })
  const rimMat = new THREE.MeshLambertMaterial({ color: PALETTE.binRim })

  const addPiece = (
    w: number, h: number, d: number, x: number, y: number, z: number,
    mat: THREE.Material,
  ): void => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    crateAnchor.add(m)
  }

  const outerX = BIN.innerHalfX + BIN.wallThick
  const outerZ = BIN.innerHalfZ + BIN.wallThick
  const wallH = BIN.wallTop - 0.34

  // Plinth + base
  addPiece(outerX * 2, 0.34, outerZ * 2, 0, 0.17, 0, new THREE.MeshLambertMaterial({ color: PALETTE.binBase }))
  addPiece(BIN.innerHalfX * 2, 0.05, BIN.innerHalfZ * 2, 0, BIN.baseTop - 0.025, 0, rimMat)
  // Long sides
  addPiece(outerX * 2, wallH, BIN.wallThick, 0, 0.34 + wallH / 2, -outerZ + BIN.wallThick / 2, binMat)
  addPiece(outerX * 2, wallH, BIN.wallThick, 0, 0.34 + wallH / 2, outerZ - BIN.wallThick / 2, binMat)
  // End cheeks
  addPiece(BIN.wallThick, wallH, outerZ * 2, -outerX + BIN.wallThick / 2, 0.34 + wallH / 2, 0, binMat)
  addPiece(BIN.wallThick, wallH, outerZ * 2, outerX - BIN.wallThick / 2, 0.34 + wallH / 2, 0, binMat)
  // Rim caps — a lip you can read the edge of, and the thing that makes it
  // look like furniture rather than a chamfered cube.
  addPiece(outerX * 2 + 0.04, 0.05, BIN.wallThick + 0.04, 0, BIN.wallTop, -outerZ + BIN.wallThick / 2, rimMat)
  addPiece(outerX * 2 + 0.04, 0.05, BIN.wallThick + 0.04, 0, BIN.wallTop, outerZ - BIN.wallThick / 2, rimMat)
  addPiece(BIN.wallThick + 0.04, 0.05, outerZ * 2 + 0.04, -outerX + BIN.wallThick / 2, BIN.wallTop, 0, rimMat)
  addPiece(BIN.wallThick + 0.04, 0.05, outerZ * 2 + 0.04, outerX - BIN.wallThick / 2, BIN.wallTop, 0, rimMat)

  // A dedicated warm light over the crate. Digging happens here, so this
  // is where the contrast budget goes.
  const crateLamp = new THREE.PointLight(0xffd9a0, 14, 7, 2)
  crateLamp.position.set(0, 2.5, 0.5)
  crateAnchor.add(crateLamp)

  blockers.push({
    minX: CRATE_POS.x - outerX, maxX: CRATE_POS.x + outerX,
    minZ: CRATE_POS.z - outerZ, maxZ: CRATE_POS.z + outerZ,
  })

  // ── The listening station ──
  const stationAnchor = new THREE.Object3D()
  stationAnchor.position.copy(STATION_POS)
  scene.add(stationAnchor)
  const deck = box(1.6, 1.0, 1.2, PALETTE.counter)
  deck.position.set(0, 0.5, 0)
  stationAnchor.add(deck)
  const platter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.06, 20),
    new THREE.MeshLambertMaterial({ color: 0x14141a }),
  )
  platter.position.set(0, 1.03, 0)
  stationAnchor.add(platter)
  const spindle = box(0.05, 0.12, 0.05, 0xd8d8d8)
  spindle.position.set(0, 1.09, 0)
  stationAnchor.add(spindle)
  blockers.push({
    minX: STATION_POS.x - 0.85, maxX: STATION_POS.x + 0.85,
    minZ: STATION_POS.z - 0.65, maxZ: STATION_POS.z + 0.65,
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

  return { scene, blockers, crateAnchor, stationAnchor, platter, dispose }
}
