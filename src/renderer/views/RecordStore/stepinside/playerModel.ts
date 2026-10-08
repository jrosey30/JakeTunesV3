/**
 * How walking feels — pure math, no three.js.
 *
 * The brief put movement first, and movement is where cheap 3D gives
 * itself away. Two things separate "a character walking" from "a box
 * sliding":
 *
 *   • MOMENTUM. You accelerate into a walk and you coast out of it. Input
 *     sets a target velocity; the body chases it. Releasing the stick does
 *     not stop you dead.
 *   • THE BODY TURNS. You face where you're going, and turning takes time.
 *     Snapping the model to the input direction reads as a sprite, not a
 *     person.
 *
 * Everything is frame-rate independent (dt in seconds) so the feel doesn't
 * change between a 60 Hz and a 120 Hz panel.
 */
export const WALK_SPEED = 3.4          // m/s — a browsing pace, not a jog
export const ACCEL = 22                // m/s² into motion
export const DAMPING = 14              // how hard we coast to a stop
export const TURN_RATE = 11            // radians/s the body swings around

export interface Body {
  x: number
  z: number
  /** Velocity, world units per second. */
  vx: number
  vz: number
  /** Facing, radians. 0 = -Z (into the screen at default camera). */
  heading: number
}

export const bodyStart = (x = 0, z = 0, heading = 0): Body => ({ x, z, vx: 0, vz: 0, heading })

/** Shortest signed angle from a to b, so turning never takes the long way. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

/**
 * Advance the body one frame.
 *
 * `inputX`/`inputZ` are already camera-relative (-1..1). `dt` in seconds.
 * Diagonals are normalised so walking corner-ways isn't faster — the
 * classic tell of an unfinished controller.
 */
export function stepBody(body: Body, inputX: number, inputZ: number, dt: number): Body {
  const mag = Math.hypot(inputX, inputZ)
  let targetVx = 0
  let targetVz = 0
  if (mag > 0.001) {
    const nx = inputX / mag
    const nz = inputZ / mag
    const throttle = Math.min(1, mag)
    targetVx = nx * WALK_SPEED * throttle
    targetVz = nz * WALK_SPEED * throttle
  }

  // Chase the target: accelerate toward it, or coast when there is none.
  const rate = mag > 0.001 ? ACCEL : DAMPING
  const k = 1 - Math.exp(-rate * dt)          // stable at any dt
  const vx = body.vx + (targetVx - body.vx) * k
  const vz = body.vz + (targetVz - body.vz) * k

  // Face the direction of travel, but only while actually travelling —
  // otherwise the body spins on the spot as velocity decays through zero.
  let heading = body.heading
  const speed = Math.hypot(vx, vz)
  if (speed > 0.35) {
    const want = Math.atan2(vx, vz)
    heading += angleDelta(heading, want) * Math.min(1, TURN_RATE * dt)
  }

  return { x: body.x + vx * dt, z: body.z + vz * dt, vx, vz, heading }
}

/** Speed as 0..1 of a full walk — drives the walk cycle and head bob. */
export const gait = (body: Body): number => Math.min(1, Math.hypot(body.vx, body.vz) / WALK_SPEED)

/** Axis-aligned blockers. Rooms are boxes; this keeps you out of walls
 *  without a physics engine. Resolves per-axis so sliding along a wall
 *  feels right instead of sticking. */
export interface Blocker { minX: number; maxX: number; minZ: number; maxZ: number }

export function resolveCollisions(prev: Body, next: Body, blockers: Blocker[], radius = 0.36): Body {
  let { x, z } = next
  for (const b of blockers) {
    const insideX = x > b.minX - radius && x < b.maxX + radius
    const insideZ = z > b.minZ - radius && z < b.maxZ + radius
    if (!(insideX && insideZ)) continue
    // Came from outside on X? Stop on X. Same for Z. Per-axis = sliding.
    const wasOutX = prev.x <= b.minX - radius || prev.x >= b.maxX + radius
    const wasOutZ = prev.z <= b.minZ - radius || prev.z >= b.maxZ + radius
    if (wasOutX) x = prev.x
    if (wasOutZ) z = prev.z
    if (!wasOutX && !wasOutZ) { x = prev.x; z = prev.z }
  }
  return { ...next, x, z }
}
