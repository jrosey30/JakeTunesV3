/**
 * Arguments the sync orchestrator passes to ~/bin/jaketunes-homemini-sync.sh.
 *
 * The script's source is Dr. Claude/scripts/jaketunes-homemini-sync.sh.
 * The process that runs is the copy in ~/bin. `--skip-library-json` only
 * works after that copy is updated; an older script ignores unknown
 * arguments and still publishes library.json.
 *
 * A replica still launches the script. The flag drops library.json from
 * both publish sites inside it (phone backend + SYNC_FILES). Music,
 * artwork, overrides, playlists, play logs, and stars still run.
 */
export const SKIP_LIBRARY_JSON_ARG = '--skip-library-json'

export function syncLaunchArgs(opts: {
  script: string
  quick: boolean
  homeminiOnly: boolean
  skipLibraryJson: boolean
}): string[] {
  const args = [opts.script]
  if (opts.quick) args.push('--quick')
  if (opts.homeminiOnly) args.push('--homemini-only')
  if (opts.skipLibraryJson) args.push(SKIP_LIBRARY_JSON_ARG)
  return args
}
