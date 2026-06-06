/** Fixed px tracks — scroll-width anchor for virtual-scroll width sizer. */
export function songsGridTemplateFixed(colWidths: number[]): string {
  return colWidths.map(w => `${w}px`).join(' ')
}

/** Title column grows when the viewport is wider than the column sum. */
export function songsGridTemplate(
  visibleCols: { key: string }[],
  colWidths: number[],
): string {
  return visibleCols.map((col, i) => {
    const w = colWidths[i]
    return col.key === 'title' ? `minmax(${w}px, 1fr)` : `${w}px`
  }).join(' ')
}
