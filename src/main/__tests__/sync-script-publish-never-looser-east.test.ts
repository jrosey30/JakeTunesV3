/**
 * Never looser than the guard before PR 411: Kolkata and UTC.
 * The cases and the harness are in sync-script-never-looser-rig.ts.
 */
import { ZONES, describeNeverLooser } from './sync-script-never-looser-rig.ts'

describeNeverLooser(ZONES.slice(1), { checksTheCheck: false })
