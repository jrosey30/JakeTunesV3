/** App-wide calendar date format: M-DD-YYYY — month with NO leading zero
 *  (June → 6, October → 10), day kept two-digit, four-digit year, dashes.
 *  e.g. 6-10-2026, 10-09-2026, 1-05-2027.
 *
 *  Accepts an ISO string, a bare YYYY-MM-DD, a millisecond number, or a Date.
 *  A bare YYYY-MM-DD is parsed in LOCAL time so a date never shifts back a day
 *  across time zones. Returns '' for empty/unparseable input (the original
 *  string is returned if it parsed to something, so partial junk passes through
 *  visibly rather than vanishing). Used everywhere the app shows a numeric date
 *  (Date Added columns, recommendation timestamps, "since", etc.). */
/** Date Added and Last Played, as iTunes showed them: 1/2/2004 5:56:02 PM (Jake, 2026-11-05).
 *  Local time. A bare YYYY-MM-DD shows the date alone: about 4,300 songs only ever stored the
 *  day, and a made-up time would be a lie. Returns '' for empty or 0 (never played). */
export function formatAppDateTime(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined || input === '' || input === 0) return ''
  let d: Date
  let dayOnly = false
  if (input instanceof Date) {
    d = input
  } else if (typeof input === 'number') {
    d = new Date(input)
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
    dayOnly = !!m
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(input)
  }
  if (isNaN(d.getTime())) return typeof input === 'string' ? input : ''
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
  if (dayOnly) return date
  const hours = d.getHours()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date} ${hours % 12 || 12}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${hours < 12 ? 'AM' : 'PM'}`
}

export function formatAppDate(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined || input === '') return ''
  let d: Date
  if (input instanceof Date) {
    d = input
  } else if (typeof input === 'number') {
    d = new Date(input)
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input)
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(input)
  }
  if (isNaN(d.getTime())) return typeof input === 'string' ? input : ''
  const month = d.getMonth() + 1 // no leading zero
  const day = String(d.getDate()).padStart(2, '0') // two-digit day
  return `${month}-${day}-${d.getFullYear()}`
}
