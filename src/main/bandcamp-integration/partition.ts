// Shared partition name for every Bandcamp WebContents / Session in the app.
// Centralized so the v4 embedded view and the legacy auth helpers agree on
// which cookie jar to use; renaming would invalidate the user's login session
// (Brief 036 v4 §6 — do not change).

export const BANDCAMP_PARTITION = 'persist:bandcamp'
