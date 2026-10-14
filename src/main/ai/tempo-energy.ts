/**
 * Grounded tempo / key / Camelot text folded into embed + mood vectors.
 * Pure — no Electron / disk — so unit tests can import it.
 *
 * Brief 181: the implementation lives in src/common/embedding-text.ts, the
 * ONE source of truth the nightly trainer (scripts/brain-trainer.mjs) also
 * imports. This file is a re-export shim so existing import sites
 * (`./tempo-energy`) don't move. Do not re-implement tempoEnergyText here —
 * the hand-synced twin it used to be had already drifted from the trainer
 * on untrimmed string fields.
 */
export { tempoEnergyText, KEY_CONFIDENCE_FLOOR, type TempoEnergyInput } from '../../common/embedding-text.ts'
