/**
 * "Update ready" (2026-10-30) — what the status bar draws when a newer build
 * is staged on this Mac and waiting at the install gate.
 *
 * ⚠️ TWIN: scripts/install/jaketunes-install-gate.sh writes the marker these
 * fields come from (update-ready.json: v, sha, version, note, stagedAt,
 * gatePid). The main process (src/main/update-ready-core.ts) validates the
 * marker and reduces it to this shape for the renderer.
 */
export interface UpdateReadyState {
  /** Commit the staged build was made from — the gate's 4th argument. */
  sha: string
  /** CFBundleShortVersionString of the staged app ('' when the gate could not read it). */
  version: string
  /** Free text from the install pipeline — what is in the update ('' when none). */
  note: string
}
