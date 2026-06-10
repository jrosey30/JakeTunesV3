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
