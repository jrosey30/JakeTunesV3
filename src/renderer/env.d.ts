/// <reference types="vite/client" />

// Image asset modules — Vite resolves these at build time but tsc needs
// declarations so e.g. `import avatar from './foo.png'` type-checks.
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.jpeg' {
  const src: string
  export default src
}
declare module '*.gif' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
declare module '*.webp' {
  const src: string
  export default src
}

// Electron extends the DOM File interface with an absolute filesystem
// path. The standard browser typings don't know about it, so without
// this augmentation `f.path` reports as a missing property.
//
// See: https://www.electronjs.org/docs/latest/api/file-object
interface File {
  readonly path: string
}
