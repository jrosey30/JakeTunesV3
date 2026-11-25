/**
 * One plain line for why removing songs with no file, or deleting files not in
 * the library, was refused (main: reconcile-guard.ts assessDeadTrackRemoval,
 * the external-write check, and purgeLibraryOrphans' machine refusal).
 */
export function refusalWords(reason: string | undefined): string {
  switch (reason) {
    case 'no-music-root':
    case 'music-root-empty':
    case 'music-root-incomplete':
      return 'The music folder isn’t all there right now, so nothing was removed.'
    case 'catastrophic-fraction':
    case 'over-cap':
      return 'That’s too many songs at once to be sure, so nothing was removed.'
    case 'external-write-conflict':
      return 'The library changed while it was checking. Try again.'
    case 'not-this-macs-folder':
      return 'This Mac doesn’t own that music folder, so nothing was deleted.'
    default:
      return 'Couldn’t remove them. Nothing was changed.'
  }
}
