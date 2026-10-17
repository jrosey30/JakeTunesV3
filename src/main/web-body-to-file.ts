/**
 * Write a fetch() response body to a file — safely.
 *
 * Jake (2026-10-17, two "A JavaScript error occurred in the main process —
 * Uncaught Exception: TypeError: terminated" dialogs, "why does this keep
 * happening"). The spool and the ALAC cache both did
 *   Readable.fromWeb(res.body).pipe(out).on('finish', resolve).on('error', reject)
 * — `.pipe()` returns the DESTINATION, so the error listener sat on the file
 * while the DOWNLOAD had none. When homemini's connection dropped mid-body
 * (backend restart, Wi-Fi, a timeout), the source emitted 'error' to no one:
 * Electron's uncaught-exception dialog. And the promise never settled, so the
 * spool slot stayed taken until restart.
 *
 * pipeline() listens on both ends, destroys both on failure and rejects with
 * the source's error, so callers' existing catch blocks finally run.
 * No Electron imports: node --test loads it.
 */
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function writeWebBodyToFile(body: ReadableStream<Uint8Array>, dest: string): Promise<void> {
  await pipeline(Readable.fromWeb(body as never), createWriteStream(dest))
}
