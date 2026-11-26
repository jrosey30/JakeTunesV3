/**
 * Never looser than the guard before PR 411: New York, and the checks that the comparison itself can fail.
 * The cases and the harness are in sync-script-never-looser-rig.ts.
 */
import { ZONES, describeNeverLooser } from './sync-script-never-looser-rig.ts'

describeNeverLooser(ZONES.slice(0, 1), { checksTheCheck: true })
