/**
 * The whole year on one page (2026-10-12): the story's facts and the rest of
 * the review to browse after the reveal. Every heading is computed from the
 * facts; nothing here is a sentence the numbers don't carry.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirPageView.swift (the phone's whole-year page).
 */
import { useAudio } from '../../hooks/useAudio'
import YirImg, { type YirCtx } from './YirImg'
import { findSong, albumSongs } from './yirData'
import { n, dayName, hour12, isRevealed } from '../../../common/yir-story'
import { localParts } from '../../../common/year-in-review'
import type { YirFacts } from './yirData'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const monthName = (mm: string): string => MONTHS[Number(mm) - 1] ?? mm
const pct = (v: number, max: number): string => `${Math.max(2, Math.round((v / Math.max(1, max)) * 100))}%`
const argMax = (a: number[]): number => a.reduce((b, v, i) => (v > a[b] ? i : b), 0)
const ordinal = (d: number): string => `${d}${['th', 'st', 'nd', 'rd'][(d % 100 > 10 && d % 100 < 14) || d % 10 > 3 ? 0 : d % 10]}`

export default function YirPage({ y, ctx, onStory }: { y: YirFacts; ctx: YirCtx; onStory: () => void }): JSX.Element {
  const { playTrack } = useAudio()
  const playSong = (artist: string, title: string): void => {
    const t = findSong(ctx.tracks, artist, title)
    if (t) playTrack(t, [t], 0, undefined, true)
  }
  const playAlbum = (artist: string, album: string): void => {
    const songs = albumSongs(ctx.tracks, artist, album)
    if (songs.length) playTrack(songs[0], songs, 0, undefined, true)
  }
  const revealed = isRevealed(y.year, new Date())
  const T = y.totals, C = y.coverage, H = y.honesty, D = y.discoveries
  const first = C.firstListen ? localParts(C.firstListen) : null
  const startedLate = C.monthsBeforeHistory.length > 0 && !!C.firstListen
  const last = C.lastListen ? localParts(C.lastListen) : null
  const loudest = y.months.length ? y.months.reduce((a, b) => (b.plays > a.plays ? b : a)) : null
  const peakH = argMax(y.clock.byHour), peakW = argMax(y.clock.byWeekday)
  const hMax = Math.max(...y.clock.byHour), wMax = Math.max(...y.clock.byWeekday)
  const fbm = Object.entries(D.foundByMonth).sort(([a], [b]) => a.localeCompare(b))
  const fMax = Math.max(1, ...fbm.map(([, v]) => v))
  const devs = Object.entries(C.playsByDevice).sort((a, b) => b[1] - a[1])
  const devTot = devs.reduce((s, [, v]) => s + v, 0) || 1
  const top3 = y.topArtists.slice(0, 3)
  const yy = String(y.year)

  return (
    <div className="yir-page">
      <section className="yir-p-hero">
        <div className="yir-p-eyebrow">JakeTunes · Year in Review</div>
        <h1 className="yir-p-year">{yy.slice(0, 2)}<span>{yy.slice(2)}</span></h1>
        <div className="yir-p-sofar">{revealed ? 'Your year in music.' : 'So far.'}</div>
        <div className="yir-p-big3">
          <div><b>{n(T.plays)}</b><span>songs played</span></div>
          <div><b>{n(Math.round(T.minutes / 60))}</b><span>hours of music</span></div>
          <div><b>{n(T.daysListened)}</b><span>days with music</span></div>
        </div>
        {first && C.monthsBeforeHistory.length > 0 && (
          <p className="yir-p-note">Since {dayName(first.date)}, the day JakeTunes started keeping score. {C.monthsBeforeHistory.map(monthName)[0]} through {monthName(C.monthsBeforeHistory.at(-1)!)} aren't in any log.</p>
        )}
        <button type="button" className="yir-p-story" onClick={onStory}>Play the story</button>
      </section>

      {/* Only when the log reaches back to the year's start (the story's rule,
          yir-story.ts): a mid-year first play is not where the year started. */}
      {y.firstPlay && !startedLate && (
        <section>
          <div className="yir-p-eyebrow">Where it started</div>
          <h2>The first song on the record was <em>{y.firstPlay.title}</em>.</h2>
          <p className="yir-p-lede">{y.firstPlay.artist}, {dayName(localParts(y.firstPlay.ts).date)}. Everything below came after it.</p>
        </section>
      )}

      {y.topSongs[0] && (
        <section>
          <div className="yir-p-eyebrow">Your top songs</div>
          <h2><em>{y.topSongs[0].name}</em>, {n(y.topSongs[0].plays)} times.</h2>
          <p className="yir-p-lede">Counted only when the song actually played: never a skip, never a glance. Click one to play it.</p>
          <ol className="yir-p-chart">
            {y.topSongs.slice(0, 10).map((s, k) => (
              <li key={`${s.artist}|${s.name}`}>
                <button type="button" onClick={() => playSong(s.artist ?? '', s.name)} title={`Play ${s.name}`}>
                  <span className="yir-p-rank">{k + 1}</span>
                  <YirImg image={{ kind: 'song', artist: s.artist ?? '', title: s.name }} ctx={ctx} className="yir-p-sm" size={120} />
                  <span className="yir-p-who"><b>{s.name}</b><i>{s.artist}</i></span>
                  <span className="yir-p-num">{s.plays}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {top3.length > 0 && (
        <section>
          <div className="yir-p-eyebrow">Your top artists</div>
          <h2><em>{top3[0].name}</em>, {n(top3[0].plays)} plays.</h2>
          <div className="yir-p-tiles yir-p-tiles--3">
            {top3.map((a, k) => (
              <figure key={a.name} className={k === 0 ? 'lead' : ''}>
                <YirImg image={{ kind: 'artist', name: a.name }} ctx={ctx} className="yir-p-photo" size={480} />
                <figcaption><b>{a.name}</b><span>{n(a.plays)} plays · {n(Math.round((a.minutes ?? 0) / 60))} h</span></figcaption>
              </figure>
            ))}
          </div>
          <ol className="yir-p-rest" start={4}>
            {y.topArtists.slice(3, 10).map((a) => <li key={a.name}><b>{a.name}</b><span>{n(a.plays)}</span></li>)}
          </ol>
        </section>
      )}

      {y.topAlbums[0] && (
        <section>
          <div className="yir-p-eyebrow">Your top albums</div>
          <h2><em>{y.topAlbums[0].name}</em> was the record of the year.</h2>
          <div className="yir-p-tiles yir-p-tiles--5">
            {y.topAlbums.slice(0, 5).map((a) => (
              <figure key={`${a.artist}|${a.name}`}>
                <button type="button" onClick={() => playAlbum(a.artist ?? '', a.name)} title={`Play ${a.name}`}>
                  <YirImg image={{ kind: 'album', artist: a.artist ?? '', album: a.name }} ctx={ctx} className="yir-p-cover" size={320} />
                </button>
                <figcaption><b>{a.name}</b><span>{a.artist} · {n(a.plays)} plays</span></figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {loudest && (
        <section>
          <div className="yir-p-eyebrow">Month by month</div>
          <h2>{monthName(loudest.month)} was the loudest month.</h2>
          <p className="yir-p-lede">Each month's most-played artist on the right.</p>
          <div className="yir-p-months">
            {C.monthsBeforeHistory.map((m) => (
              <div key={m} className="yir-p-mrow yir-p-ghost"><span>{monthName(m).slice(0, 3)}</span><span className="yir-p-mbar" /><span>—</span><span>not in any log</span></div>
            ))}
            {y.months.map((m) => (
              <div key={m.month} className="yir-p-mrow">
                <span>{monthName(m.month).slice(0, 3)}</span>
                <span className="yir-p-mbar"><i className={m === loudest ? 'hot' : ''} style={{ width: pct(m.plays, loudest.plays) }} /></span>
                <span>{n(m.plays)}</span>
                <span>{m.topArtist?.name ?? ''}</span>
              </div>
            ))}
          </div>
          {first && last && <p className="yir-p-foot">{monthName(first.month)} starts on the {ordinal(Number(first.date.slice(8)))}. {monthName(last.month)} runs through {dayName(last.date)}.</p>}
        </section>
      )}

      {T.plays > 0 && (
        <section>
          <div className="yir-p-eyebrow">When you listen</div>
          <h2>{hour12(peakH).charAt(0).toUpperCase() + hour12(peakH).slice(1)} is your hour. {WD[peakW]} is your day.</h2>
          <div className="yir-p-clock">
            <div>
              <div className="yir-p-hours">{y.clock.byHour.map((v, h) => <span key={h} className={v === hMax ? 'hot' : ''} style={{ height: pct(v, hMax) }} title={`${hour12(h)} · ${n(v)} plays`} />)}</div>
              <div className="yir-p-axis"><span>12 AM</span><span>6 AM</span><span>Noon</span><span>6 PM</span><span>11 PM</span></div>
            </div>
            <div className="yir-p-week">
              {y.clock.byWeekday.map((v, d) => <div key={d}><span className={v === wMax ? 'hot' : ''} style={{ height: pct(v, wMax) }} title={`${WD[d]} · ${n(v)} plays`} /><small>{WD[d][0]}</small></div>)}
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="yir-p-eyebrow">Moments</div>
        <h2>The ones that stood out.</h2>
        <div className="yir-p-moments">
          {T.longestStreak.from && T.longestStreak.to && (
            <div><span className="k">The streak</span><span className="v">{n(T.longestStreak.days)} <small>days</small></span>
              <p>Music every single day from <b>{dayName(T.longestStreak.from)}</b> to <b>{dayName(T.longestStreak.to)}</b>.</p></div>
          )}
          {y.onRepeat && (
            <div><span className="k">On repeat</span><span className="v">{n(y.onRepeat.plays)} <small>in a week</small></span>
              <p><b>{y.onRepeat.title}</b> by {y.onRepeat.artist}, the week of {dayName(y.onRepeat.weekOf)}.</p></div>
          )}
          {T.biggestDay.date && T.biggestDay.firstHour !== null && T.biggestDay.lastHour !== null && (
            <div><span className="k">The day it never stopped</span><span className="v">{n(T.biggestDay.plays)} <small>songs</small></span>
              <p><b>{dayName(T.biggestDay.date)}</b>. The music started at {hour12(T.biggestDay.firstHour)} and was still going at {hour12(T.biggestDay.lastHour)}.</p></div>
          )}
        </div>
      </section>

      <section>
        <div className="yir-p-eyebrow">What you found</div>
        <h2>You brought <em>{n(D.foundTotal)}</em> songs home.</h2>
        <p className="yir-p-lede">Found and downloaded through JakeTunes this year. The old collection moving in doesn't count.</p>
        <div className="yir-p-split">
          <div>
            <div className="yir-p-stat">{n(D.newArtistCount)}</div><span>artists joined your library</span>
            <div className="yir-p-found">{fbm.map(([m, v]) => <div key={m}><span className={v === fMax ? 'hot' : ''} style={{ height: pct(v, fMax) }} title={`${monthName(m)} · ${n(v)}`} /><small>{monthName(m).slice(0, 3)}</small></div>)}</div>
          </div>
          <div>
            <div className="yir-p-eyebrow">Most-played newcomers</div>
            <ul className="yir-p-plain">
              {D.newArtists.slice(0, 8).map((a) => (
                <li key={a.name}><YirImg image={{ kind: 'artist', name: a.name }} ctx={ctx} className="yir-p-sm yir-p-round" size={120} /><span className="yir-p-who"><b>{a.name}</b><i>{n(a.plays)} plays</i></span></li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {y.starredClass.count > 0 && (
        <section>
          <div className="yir-p-eyebrow">The starred class</div>
          <h2><em>{n(y.starredClass.count)}</em> new finds got your star.</h2>
          <p className="yir-p-lede">The ones you came back to most.</p>
          <ol className="yir-p-chart">
            {y.starredClass.top.slice(0, 6).map((s, k) => (
              <li key={`${s.artist}|${s.name}`}>
                <button type="button" onClick={() => playSong(s.artist ?? '', s.name)} title={`Play ${s.name}`}>
                  <span className="yir-p-rank">{k + 1}</span>
                  <YirImg image={{ kind: 'song', artist: s.artist ?? '', title: s.name }} ctx={ctx} className="yir-p-sm" size={120} />
                  <span className="yir-p-who"><b>{s.name}</b><i>{s.artist}</i></span>
                  <span className="yir-p-num">{s.plays}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {y.concerts.length > 0 && (
        <section>
          <div className="yir-p-eyebrow">Live</div>
          <h2>{n(y.concerts.length)} concert{y.concerts.length === 1 ? '' : 's'} on the shelf.</h2>
          <p className="yir-p-lede">Every live show you put together this year.</p>
          <ul className="yir-p-live">
            {y.concerts.map((c) => {
              const key = `${c.artist.toLowerCase().trim()}|||${c.album.toLowerCase().trim()}`
              const sc = ctx.concerts.find((x) => x.albumKey === key)
              return (
                <li key={key}>
                  <YirImg image={{ kind: 'concert', albumKey: key, band: sc?.band ?? c.artist, show: sc?.show ?? c.album }} ctx={ctx} className="yir-p-postr" size={320} />
                  <span className="yir-p-who"><b>{sc?.venue ?? c.album}</b><i>{c.artist}{sc?.date ? ` · ${sc.date}` : ''}</i></span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {y.mixtapes.length > 0 && (
        <section>
          <div className="yir-p-eyebrow">Tapes</div>
          <h2>{n(y.mixtapes.length)} tape{y.mixtapes.length === 1 ? '' : 's'} made.</h2>
          <ul className="yir-p-tapes">
            {[...y.mixtapes].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).map((m) => (
              <li key={`${m.title}|${m.createdAt}`}><b>{m.title}</b><i>{n(m.songs)} songs{m.createdAt ? ` · ${dayName(localParts(m.createdAt).date)}` : ''}</i></li>
            ))}
          </ul>
        </section>
      )}

      {H.realSkipRate !== null && (
        <section>
          <div className="yir-p-eyebrow">Straight talk</div>
          <h2>You skipped <em>{n(H.skips)}</em> songs for real.</h2>
          <div className="yir-p-honest">
            <div className="yir-p-stat">{(H.realSkipRate * 100).toFixed(1)}%</div>
            <p className="yir-p-lede">That's your real skip rate. The {n(H.glances)} times you left a song in its first few seconds don't count, and neither do the {n(H.mechanical)} rapid-fire skips while hunting for something. Those aren't verdicts.</p>
          </div>
          <div className="yir-p-devs">
            {devs.map(([k, v]) => <div key={k}><span style={{ width: pct(v, devs[0][1]) }} /><em><b>{k}</b> {n(v)} · {Math.round((v / devTot) * 100)}%</em></div>)}
          </div>
          <p className="yir-p-foot">Where the plays happened.</p>
        </section>
      )}

      <section className="yir-p-end">
        <div className="yir-p-eyebrow">{revealed ? 'Happy birthday' : 'To be continued'}</div>
        <h2>{revealed ? `That was ${y.year}.` : `The rest of ${y.year} is still being written.`}</h2>
        <p className="yir-p-lede">{last ? `Facts through ${dayName(last.date)}. ` : ''}Every number on this page is a count of real plays or library records.</p>
      </section>
    </div>
  )
}
