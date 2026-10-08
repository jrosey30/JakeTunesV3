/**
 * The per-track comparison, inline under a refused album's Details (Jake
 * 9/7: "one inline action… comparison under Details"). Pure rendering of the
 * read-only compare result; it never touches the queue.
 */
import type { CompareEditionsResult } from '../../common/near-edition-types'
import '../styles/compare-editions.css'

const fmt = (s: number | null | undefined): string => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`

export default function NearEditionTable({ d }: { d: CompareEditionsResult }) {
  return (
    <div className="cmp-inline">
      <div className="cmp-editions">
        <div className="cmp-edition"><span className="cmp-edition-k">Edition you picked</span><span className="cmp-edition-v">{d.picked.label} · {d.picked.trackCount} tracks{d.picked.releaseYear ? ` · ${d.picked.releaseYear}` : ''}</span></div>
        <div className="cmp-edition"><span className="cmp-edition-k">Nearest found</span><span className="cmp-edition-v">{d.found.label} · {d.found.trackCount} tracks{d.found.releaseYear ? ` · ${d.found.releaseYear}` : ''}<span className="cmp-edition-src">{d.found.source}</span></span></div>
      </div>
      <table className="cmp-table">
        <thead><tr><th>#</th><th>Track</th><th className="num">Picked</th><th className="num">Found</th><th>Judge</th><th>Yours</th></tr></thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.n} className={`cmp-row cmp-row--${r.verdict}`}>
              <td>{r.n}</td>
              <td className="cmp-title">{r.wantTitle}{r.gotTitle && r.gotTitle !== r.wantTitle ? <span className="cmp-alt-title">found as “{r.gotTitle}”</span> : null}</td>
              <td className="num">{fmt(r.wantSec)}</td>
              <td className="num">{fmt(r.gotSec)}</td>
              <td className="cmp-verdict">{r.verdict === 'exact' ? '✓ exact' : r.verdict === 'mismatch' ? `✕ ${r.reason}` : `? ${r.reason}`}</td>
              <td className="cmp-owned">{r.owned ? '✓' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cmp-counts">{d.summary.exact} of {d.summary.total} match to within {d.toleranceSec} s · {d.summary.owned} already yours</div>
    </div>
  )
}
