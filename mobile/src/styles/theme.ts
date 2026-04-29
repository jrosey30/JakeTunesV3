// Mobile theme tokens. The desktop renderer leans hard into iTunes 8
// chrome (silver/aqua, gloss). On mobile that aesthetic doesn't
// scale — small touch targets, dark mode, OLED. We borrow the
// signature accent (#e0812e) and a 2008-era serif feel for headers,
// but otherwise stay closer to a modern iOS music app.

export const colors = {
  bg: '#0d0d0e',
  bgElevated: '#19191b',
  bgSurface: '#1f1f22',
  border: '#2a2a2e',
  text: '#f5f5f7',
  textDim: '#a1a1a6',
  textFaint: '#6e6e73',
  accent: '#e0812e',
  accentGlow: 'rgba(224, 129, 46, 0.45)',
  positive: '#34c759',
  negative: '#ff453a',
}

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
}

export const typography = {
  // System sans for body, system serif (New York on iOS) for headers
  // to keep a faint nod to iTunes' Lucida Grande/Trebuchet roots
  // without looking dated.
  bodyFamily: undefined as string | undefined,
  headerFamily: 'New York',
  sizes: {
    caption: 11,
    small: 13,
    body: 15,
    title: 17,
    largeTitle: 24,
    display: 32,
  },
  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
}
