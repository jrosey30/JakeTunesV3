/** App-wide calendar date format: M-DD-YYYY */
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
  const month = d.getMonth() + 1
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}-${day}-${d.getFullYear()}`
}
