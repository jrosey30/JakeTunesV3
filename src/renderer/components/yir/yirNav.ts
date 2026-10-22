/** Which Year in Review mode opens next: the story or the whole-year page.
 *  ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YearInReview.swift (YirNav). */
export type YirMode = 'story' | 'page'
let pending: YirMode = 'story'
export function setYirMode(mode: YirMode): void { pending = mode }
export function takeYirMode(): YirMode { const m = pending; pending = 'story'; return m }
