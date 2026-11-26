/**
 * The never-looser differential (PR 411), shared by the two
 * sync-script-publish-never-looser-*.test.ts files: each runs its share of ZONES, so the
 * file that used to hold all of it stays under the runner's 300 s cap. Together they run
 * every zone on every Python, as the one describe did. Not a test file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAY, HOUR, NOW, PYTHONS, guardSource } from './sync-script-publish-rig.ts'

/** Every zone the differential runs in. */
export const ZONES = ['America/New_York', 'Asia/Kolkata', 'UTC'] as const

/**
 * Never looser. The guard as it ran before PR 411 is frozen in
 * fixtures/publish-guard-before-pr411.py. Both guards get the same folder and the same
 * clock, for a missing song dated in every shape at every distance from the two lines
 * the old guard drew (30 days ago; this copy's newest song), in three time zones, on
 * every Python. Wherever the old guard refused, the new one must refuse, unless a
 * deletion on record covers the song, which is the one thing this PR lets through.
 */
export function describeNeverLooser(zones: readonly string[], opts: { checksTheCheck: boolean }): void {
describe('guarded publish: never looser than the guard before it', () => {
  const BEFORE = readFileSync(join(import.meta.dirname, 'fixtures', 'publish-guard-before-pr411.py'), 'utf8')
  // The clock is the harness's to set, so the lines are put where the readings disagree:
  // 30 days before each of these is between UTC midnight and New York's (02:00Z), between
  // Kolkata's and UTC's (21:00Z), clear of both (12:00Z), and wherever today happens to be.
  const TODAY = Math.floor(NOW / DAY) * DAY
  const CLOCKS = [Math.floor(NOW / 1000) * 1000, TODAY + 2 * HOUR, TODAY + 21 * HOUR, TODAY + 12 * HOUR]
  const MIN = 60 * 1000
  const NEAR = [1 * MIN, 30 * MIN, 3 * HOUR, 4.5 * HOUR, 5 * HOUR, 5.5 * HOUR, 6 * HOUR, 13 * HOUR, 25 * HOUR].flatMap((d) => [-d, d])
  const FEWER = [1 * MIN, 3 * HOUR, 5.5 * HOUR, 25 * HOUR].flatMap((d) => [-d, d])
  const ABSENT = '__absent__'

  /** One instant, written every way a date has been or could be written. */
  function shapes(ms: number, tz: string): Array<[string, unknown]> {
    const z = new Date(ms).toISOString()
    const head = z.slice(0, 19)
    const shifted = (h: number) => new Date(ms + h * HOUR).toISOString().slice(0, 23)
    const wallClock = new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
    return [
      ['ms', z],
      ['one digit', `${head}.${z.slice(20, 21)}Z`],
      ['no fraction', `${head}Z`],
      ['six digits', `${head}.${z.slice(20, 23)}000Z`],
      ['+05:00', `${shifted(5)}+05:00`],
      ['-05:00', `${shifted(-5)}-05:00`],
      ['+0530', `${shifted(5.5)}+0530`],
      ['lower case', z.replace('T', 't').replace('Z', 'z')],
      ['space', z.replace('T', ' ')],
      ['no zone, local digits', wallClock],
      ['no zone, UTC digits', head],
      ['no zone, minutes only', wallClock.slice(0, 16)],
      ['date only, UTC day', z.slice(0, 10)],
      ['date only, local day', wallClock.slice(0, 10)],
    ]
  }
  const UNREADABLE: Array<[string, unknown]> = [
    ['text', 'yesterday'], ['empty', ''], ['null', null], ['epoch number', 1794500000000], ['absent', ABSENT],
    ['month 13', '2026-13-45'], ['compact', '20261112'], ['us', '11/12/2026'], ['true', true],
  ]

  interface Probe { label: string; now: number; cur: unknown[]; incoming: unknown[]; tombstones?: unknown; excused: boolean }
  const song = (id: number, dateAdded: unknown, fp = `fp-${id}`) =>
    ({ id, title: `Song ${id}`, audioFingerprint: fp, ...(dateAdded === ABSENT ? {} : { dateAdded }) })

  const probes = (tz: string): Probe[] => CLOCKS.flatMap((clock) => probesAt(tz, clock))

  function probesAt(tz: string, NOW_MS: number): Probe[] {
    const out: Probe[] = []
    const at = `${new Date(NOW_MS).toISOString().slice(11, 16)}Z`
    const add = (p: Omit<Probe, 'now'>) => out.push({ ...p, label: `[${at}] ${p.label}`, now: NOW_MS / 1000 })
    const old = [song(1, new Date(NOW_MS - 200 * DAY).toISOString()), song(2, new Date(NOW_MS - 90 * DAY).toISOString())]
    const covering = { v: 1, tombstones: [{ id: '9', audioFingerprint: 'fp-9', title: 't', artist: 'a', durationMs: 1, deletedAt: new Date(NOW_MS - MIN).toISOString() }] }
    const unrelated = { v: 1, tombstones: [{ ...covering.tombstones[0], audioFingerprint: 'someone-else' }] }

    // Line 1: 30 days ago. This copy has a song from an hour ago, so nothing missing is "newer".
    const line = NOW_MS - 30 * DAY
    const fresh = [...old, song(3, new Date(NOW_MS - HOUR).toISOString())]
    for (const d of NEAR) {
      for (const [name, text] of shapes(line + d, tz)) {
        const cur = [...fresh, song(9, text)]
        add({ label: `30-day line ${d / MIN} min, ${name}`, cur, incoming: fresh, excused: false })
        add({ label: `30-day line ${d / MIN} min, ${name}, someone else deleted`, cur, incoming: fresh, tombstones: unrelated, excused: false })
        add({ label: `30-day line ${d / MIN} min, ${name}, deleted`, cur, incoming: fresh, tombstones: covering, excused: true })
      }
    }
    // Line 2: this copy's newest song, 60 days ago, itself written every way.
    const newest = NOW_MS - 60 * DAY
    for (const [newestName, newestText] of shapes(newest, tz)) {
      const incoming = [...old, song(3, newestText)]
      for (const d of FEWER) {
        for (const [name, text] of shapes(newest + d, tz)) {
          add({ label: `newest (${newestName}) ${d / MIN} min, ${name}`, cur: [...incoming, song(9, text)], incoming, excused: false })
        }
      }
      for (const [name, value] of UNREADABLE) {
        add({ label: `newest (${newestName}), missing song dated ${name}`, cur: [...incoming, song(9, value)], incoming, excused: false })
      }
    }
    // Dates nobody can read: with and without a deletion that would cover the song.
    for (const [name, value] of UNREADABLE) {
      const cur = [...fresh, song(9, value)]
      add({ label: `unreadable ${name}`, cur, incoming: fresh, excused: false })
      add({ label: `unreadable ${name}, deleted`, cur, incoming: fresh, tombstones: covering, excused: false })
      // ... and as this copy's newest song.
      const incoming = [...old, song(3, value)]
      add({ label: `newest unreadable ${name}`, cur: [...incoming, song(9, new Date(NOW_MS - 45 * DAY).toISOString())], incoming, excused: false })
    }
    return out
  }

  // Both guards on every case, in one Python, in a folder kept in memory. A guard touches
  // its folder only through open() to read and os.replace() to publish, so those two see a
  // dict. On disk, one run's ten thousand cases were about 100,000 file writes, deletes and
  // renames, and a test at background priority waits on every one (2026-11-19: 20 s a run,
  // and once the whole file past its 300 s cap). Opening or replacing anything else fails
  // the ask, and so does a file left in the real folder the harness runs in. The cases
  // listed in job["disk"] then run again in that real folder, written to disk as before,
  // so a test can hold the two answers equal.
  const HARNESS = `
import sys, json, os, io, time, tempfile, shutil
job = json.load(sys.stdin)
clock = [0.0]
time.time = lambda: clock[0]
guards = {"before": compile(job["before"], "before", "exec"), "after": compile(job["after"], "after", "exec")}
FOLDER = ("library.json", ".library.json.incoming", "track-tombstones.json")
folder = {}
strange = []
def read(path, mode="r", *rest, **kw):
    if path not in FOLDER or mode not in ("r", "rt"): strange.append("open(%r, %r)" % (path, mode))
    if path not in folder: raise FileNotFoundError(2, "No such file or directory", path)
    return io.StringIO(folder[path])
def replace(src, dst):
    if (src, dst) != (".library.json.incoming", "library.json"): strange.append("os.replace(%r, %r)" % (src, dst))
    folder[dst] = folder.pop(src)
os_replace = os.replace
real_out, real_err = sys.stdout, sys.stderr
home = tempfile.mkdtemp()
os.chdir(home)
def run(which, case, files, disk):
    clock[0] = float(case["now"])
    if disk:
        for name in os.listdir("."): os.remove(name)
        for name, text in files.items():
            with open(name, "w") as f: f.write(text)
        scope = {"__name__": "__main__"}
    else:
        folder.clear()
        folder.update(files)
        os.replace = replace
        scope = {"__name__": "__main__", "open": read}
    out = io.StringIO()
    sys.stdout, sys.stderr = out, io.StringIO()
    try:
        exec(guards[which], scope)
    except SystemExit:
        pass
    finally:
        sys.stdout, sys.stderr = real_out, real_err
        os.replace = os_replace
    if strange: raise SystemExit("a guard reached past the folder in memory: " + strange[0])
    if disk:
        with open("library.json") as f: served = f.read()
    else:
        served = folder["library.json"]
    return [out.getvalue().strip(), len(json.loads(served)["tracks"])]
def files_of(case):
    files = {"library.json": json.dumps({"tracks": case["cur"]}), ".library.json.incoming": json.dumps({"tracks": case["incoming"]})}
    if case.get("tombstones") is not None: files["track-tombstones.json"] = json.dumps(case["tombstones"])
    return files
answers = []
for case in job["cases"]:
    files = files_of(case)
    answers.append([run("before", case, files, False), run("after", case, files, False)])
if os.listdir("."): raise SystemExit("a guard wrote to disk past the folder in memory: %r" % os.listdir("."))
disk = []
for i in job["disk"]:
    case = job["cases"][i]
    files = files_of(case)
    disk.append([run("before", case, files, True), run("after", case, files, True)])
os.chdir("/")
shutil.rmtree(home, ignore_errors=True)
json.dump({"answers": answers, "disk": disk}, sys.stdout)
`

  type Answer = [[string, number], [string, number]]
  /** answers[i] is case i, in the folder in memory; disk[k] is case onDisk[k] again, in a real folder. */
  function ask(python: string, tz: string, cases: Probe[], after = guardSource(), onDisk: number[] = []): { answers: Answer[]; disk: Answer[] } {
    const r = spawnSync(python, ['-c', HARNESS], {
      input: JSON.stringify({
        before: BEFORE, after, disk: onDisk,
        cases: cases.map(({ now, cur, incoming, tombstones }) => ({ now, cur, incoming, tombstones })),
      }),
      encoding: 'utf8', env: { ...process.env, TZ: tz }, maxBuffer: 256 * 1024 * 1024,
    })
    assert.equal(r.status, 0, r.stderr.slice(-2000))
    return JSON.parse(r.stdout)
  }
  const refused = (out: string) => out.startsWith('refused-')

  if (opts.checksTheCheck) it('the frozen guard is the one main ran', () => {
    assert.match(BEFORE, /datetime\.fromisoformat/)
    assert.equal(BEFORE.includes('track-tombstones'), false)
  })

  for (const python of PYTHONS) {
    for (const tz of zones) {
      it(`${python}, ${tz}: what the old guard refused is still refused`, () => {
        const cases = probes(tz)
        // Every 199th case runs again in a real folder on disk, and the folder in memory must
        // answer it word for word: fifty cases from every block of the probes, with both
        // verdicts and a deletion that lets a song go among them.
        const spot = cases.map((_, i) => i).filter((i) => i % 199 === 0)
        const { answers, disk } = ask(python, tz, cases, guardSource(), spot)
        assert.equal(answers.length, cases.length)
        assert.deepEqual(disk, spot.map((i) => answers[i]), 'a real folder answers as the folder in memory does')
        const spotNow = spot.map((i) => answers[i][1][0])
        assert.ok(spotNow.some(refused) && !spotNow.every(refused), 'both verdicts are among the cases run on disk')
        assert.ok(spot.some((i) => cases[i].excused && !refused(answers[i][1][0])), 'a deletion that lets a song go is among the cases run on disk')
        const looser: string[] = []
        const count = { same: 0, stricter: 0, excused: 0, oldRefused: 0, oldPublished: 0 }
        answers.forEach(([[was, wasKept], [now, nowKept]], i) => {
          const c = cases[i]
          assert.match(was, /^(published \d+|refused-\S+.*)$/, c.label)
          assert.match(now, /^(published \d+|refused-\S+.*)$/, c.label)
          // The verdict is what happened to the file, not only what was printed.
          assert.equal(refused(was), wasKept === c.cur.length, c.label)
          assert.equal(refused(now), nowKept === c.cur.length, c.label)
          if (refused(was)) count.oldRefused++; else count.oldPublished++
          if (refused(was) === refused(now)) count.same++
          else if (refused(now)) count.stricter++
          else if (c.excused) count.excused++
          else looser.push(`${c.label}: was "${was}", now "${now}"`)
          // The shape every real row has, with no deletion in play: not one word changes.
          if (!c.tombstones && / ms$/.test(c.label) && (!c.label.includes('] newest') || c.label.includes('] newest (ms)'))) assert.equal(now, was, c.label)
        })
        assert.deepEqual(looser, [], `${looser.length} case(s) the old guard refused now publish`)
        // Not vacuous: both verdicts were on the table, and the deletion excuse did fire.
        assert.ok(count.oldRefused > 100 && count.oldPublished > 100, JSON.stringify(count))
        assert.ok(count.excused > 0, JSON.stringify(count))
      })
    }
  }

  if (opts.checksTheCheck) it('the comparison can fail: a guard that reads a bare date as UTC only is caught', () => {
    // The reader PR 411 first shipped with (7da6501a): UTC midnight for a bare date, where
    // the old guard on homemini took local midnight. West of Greenwich that is hours looser.
    const loose = guardSource().replace('return (min(utc, loc), max(utc, loc)) if loc is not None else (utc, utc)', 'return (utc, utc)')
      .replace('    return max(r[1], old) if old is not None else r[1]\n', '    return r[1]\n')
    assert.notEqual(loose, guardSource())
    const cases = probes('America/New_York')
    const { answers } = ask(PYTHONS[0], 'America/New_York', cases, loose)
    const looser = answers.filter(([[was], [now]], i) => refused(was) && !refused(now) && !cases[i].excused)
    assert.ok(looser.length > 0, 'the differential saw nothing wrong with a looser guard')
  })
})
}
