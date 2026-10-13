/**
 * Dump the app's genre vocab (src/common/genre-vocab.ts) and the iceberg's
 * umbrellas (src/common/genre-iceberg.ts) as JSON on stdout, from the
 * main-branch extract in JT_MAIN_SRC. Read-only; run by export_vocab.py,
 * which writes brain-eval/vocab_snapshot.json.
 */
import { join, resolve } from 'path'

async function main(): Promise<void> {
  const root = resolve(process.env.JT_MAIN_SRC || '')
  const vocab = await import(join(root, 'src', 'common', 'genre-vocab.ts'))
  const berg = await import(join(root, 'src', 'common', 'genre-iceberg.ts'))
  process.stdout.write(JSON.stringify({
    genres: vocab.GENRES,
    catchAll: [...vocab.CATCH_ALL],
    umbrellas: berg.UMBRELLAS,
  }) + '\n')
}
main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.stack : e) + '\n'); process.exit(1) })
