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
import { n, dayName, hour12, isRevealed, deviceRows, pctOf } from '../../../common/yir-story'
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
  const T = y.totals, C = y.coverage, D = y.discoveries, R = y.range, K = y.top1000
  const first = C.firstListen ? localParts(C.firstListen) : null
  const startedLate = C.monthsBeforeHistory.length > 0 && !!C.firstListen
  const last = C.lastListen ? localParts(C.lastListen) : null
  const loudest = y.months.length ? y.months.reduce((a, b) => (b.plays > a.plays ? b : a)) : null
  const peakH = argMax(y.clock.byHour), peakW = argMax(y.clock.byWeekday)
  const hMax = Math.max(...y.clock.byHour), wMax = Math.max(...y.clock.byWeekday)
  const fbm = Object.entries(D.foundByMonth).sort(([a], [b]) => a.localeCompare(b))
  const fMax = Math.max(1, ...fbm.map(([, v]) => v))
  const devs = deviceRows(C.playsByDevice ?? {})
  const ipod = devs.find((d) => d.name === 'iPods')
  const aoty = y.topArtists[0]?.name.trim().toLowerCase()
  const seatsOfAoty = K?.variety.topArtists.find((a) => a.name.trim().toLowerCase() === aoty)
  const decMax = Math.max(1, ...(K?.variety.decades.map((d) => d.seats) ?? []))
  const top3 = y.topArtists.slice(0, 3)
  const yy = String(y.year)

  return (
    <div className="yir-page">
      <section className="yir-p-hero">
        <div className="yir-p-eyebrow">JakeTunes · Year in Review</div>
        <h1 className="yir-p-year">{yy.slice(0, 2)}<span>{yy.slice(2)}</span></h1>
        <div className="yir-p-sofar">{revealed ? 'Your year in music. None of it rented.' : 'So far. None of it rented.'}</div>
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
          <p className="yir-p-lede">Elsewhere, thirty seconds counts as a play. Here a skip never does, and neither does a glance. Click one to play it.</p>
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

      {devs.length >= 2 && (
        <section>
          <div className="yir-p-eyebrow">Your world</div>
          <h2>{devs.length} devices. <em>One library</em> you own.</h2>
          <p className="yir-p-lede">Every play was music on your own drives.{ipod ? ` The iPods logged ${n(ipod.plays)} of them with no signal and no subscription.` : ''}</p>
          <div className="yir-p-devs">
            {devs.map((d, k) => <div key={d.name}><span className={k === 0 ? 'hot' : ''} style={{ width: pct(d.plays, devs[0].plays) }} /><em><b>{d.name}</b> {n(d.plays)} · {d.pct}%</em></div>)}
          </div>
          <p className="yir-p-foot">Where the plays happened.</p>
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

      {R && R.artists > 0 && (
        <section>
          <div className="yir-p-eyebrow">Range</div>
          <h2><em>{n(R.artists)}</em> artists. <em>{n(R.genres)}</em> genres.</h2>
          <p className="yir-p-lede">{R.widestDay ? `Your widest day was ${dayName(R.widestDay.date)}: ${n(R.widestDay.artists)} artists across ${n(R.widestDay.genres)} genres in ${n(R.widestDay.plays)} plays. ` : ''}No label paid to be on any of it.</p>
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
        <p className="yir-p-lede">Found and downloaded through JakeTunes this year: found by you, not fed to you. The old collection moving in doesn't count.</p>
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
          <p className="yir-p-lede">The ones you came back to most. No expiring license can take them back.</p>
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

      {K && K.proof.answers > 0 && (
        <section className="yir-p-t1k">
          <div className="yir-p-eyebrow">The Top 1000</div>
          <h2>An algorithm you built, and <em>it works</em>.</h2>
          <p className="yir-p-lede">A tournament over {K.proof.pool ? `${n(K.proof.pool)} of your songs` : 'your whole library'}: heats, one-on-ones, genre brackets, finals. A brain learns from your plays, stars and skips and guesses your answer first. Nobody pays for a seat, and the 1,000 help fill your Original iPod.</p>
          <div className="yir-p-moments">
            {K.proof.sureCalls.n > 0 && (
              <div><span className="k">When it was sure</span><span className="v">{pctOf(K.proof.sureCalls.called, K.proof.sureCalls.n)}% <small>right</small></span>
                <p>It called {n(K.proof.sureCalls.n)} duels at 80% or more before you answered, and got {n(K.proof.sureCalls.called)} of them.</p></div>
            )}
            {K.proof.headToHead.n > 0 && (
              <div><span className="k">Every one-on-one</span><span className="v">{pctOf(K.proof.headToHead.called, K.proof.headToHead.n)}% <small>called</small></span>
                <p>{n(K.proof.headToHead.called)} of {n(K.proof.headToHead.n)}, each called before your answer.{K.proof.tasteAlone.n > 0 ? ` Plays and stars alone: ${pctOf(K.proof.tasteAlone.called, K.proof.tasteAlone.n)}%.` : ''} It asks the close ones on purpose.</p></div>
            )}
            {K.proof.heatCalls.n > 0 && (
              <div><span className="k">Heats</span><span className="v">{pctOf(K.proof.heatCalls.called, K.proof.heatCalls.n)}% <small>exactly right</small></span>
                <p>Named exactly who moves on in {n(K.proof.heatCalls.called)} of {n(K.proof.heatCalls.n)} heats. Guessing gets {Math.round(K.proof.heatCalls.chance * 100)}%.</p></div>
            )}
          </div>
          <p className="yir-p-foot">
            {n(K.proof.answers)} answers, {n(K.proof.songsJudged)} songs judged.
            {K.proof.rechecks.n > 0 ? ` Asked again later, you answered the same way ${pctOf(K.proof.rechecks.same, K.proof.rechecks.n)}% of the time.` : ''}
            {` Today it is ${Math.round(K.sure * 100)}% sure of the whole list.`}
          </p>

          {K.variety.seats > 0 && (
            <>
              <h3 className="yir-p-h3">Who holds a seat</h3>
              <div className="yir-p-big3">
                <div><b>{n(K.variety.artists)}</b><span>artists</span></div>
                <div><b>{K.variety.brackets} of {K.variety.bracketsTotal}</b><span>genre brackets</span></div>
                {K.variety.oldest && K.variety.newest && <div><b>{K.variety.oldest.year}–{K.variety.newest.year}</b><span>oldest seat to newest</span></div>}
              </div>
              {seatsOfAoty && K.variety.topArtists[0] && seatsOfAoty.name !== K.variety.topArtists[0].name && (
                <p className="yir-p-lede yir-p-wink">Artist of the year {seatsOfAoty.name}? {n(seatsOfAoty.seats)} seats, {((100 * seatsOfAoty.seats) / K.variety.seats).toFixed(1)}% of the {n(K.variety.seats)}. {K.variety.topArtists[0].name}? {n(K.variety.topArtists[0].seats)}. Love isn't a monopoly.</p>
              )}
              <div className="yir-p-split">
                <div>
                  <div className="yir-p-eyebrow">Seats by decade</div>
                  <div className="yir-p-found">{K.variety.decades.map((d) => <div key={d.decade}><span className={d.seats === decMax ? 'hot' : ''} style={{ height: pct(d.seats, decMax) }} title={`${d.decade} · ${n(d.seats)} seats`} /><small>{d.decade.slice(2)}</small></div>)}</div>
                </div>
                <div>
                  <div className="yir-p-eyebrow">Most seats</div>
                  <ol className="yir-p-seats">{K.variety.topArtists.slice(0, 6).map((a) => <li key={a.name}><b>{a.name}</b><span>{n(a.seats)}</span></li>)}</ol>
                </div>
              </div>
              {K.variety.bracketChampions.length > 0 && (
                <>
                  <h3 className="yir-p-h3">Number one, everywhere</h3>
                  <ol className="yir-p-chart">
                    {K.variety.bracketChampions.map((c) => (
                      <li key={c.bracket}>
                        <button type="button" onClick={() => playSong(c.artist, c.title)} title={`Play ${c.title}`}>
                          <span className="yir-p-rank">#{c.rank}</span>
                          <YirImg image={{ kind: 'song', artist: c.artist, title: c.title }} ctx={ctx} className="yir-p-sm" size={120} />
                          <span className="yir-p-who"><b>{c.title}</b><i>{c.artist} · #1 in {c.bracket}</i></span>
                          <span className="yir-p-num">{n(c.seats)} <small>seats</small></span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  {K.variety.numberOne && <p className="yir-p-foot">Number one of all {n(K.variety.seats)}: {K.variety.numberOne.title}, {K.variety.numberOne.artist}.</p>}
                </>
              )}
            </>
          )}
        </section>
      )}

      <section className="yir-p-end">
        <div className="yir-p-eyebrow">{revealed ? 'Happy birthday' : 'To be continued'}</div>
        <h2>{revealed ? `That was ${y.year}.` : `The rest of ${y.year} is still being written.`}</h2>
        <p className="yir-p-lede">{last ? `Facts through ${dayName(last.date)}. ` : ''}Every number on this page is a count of real plays, library records or your own answers. None of it rented.</p>
      </section>
    </div>
  )
}
