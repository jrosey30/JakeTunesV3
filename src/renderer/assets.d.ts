// Ambient declarations for static asset imports.
//
// electron-vite resolves these to URL strings at build time, but tsc
// (--noEmit type-check) doesn't know that without help. Each declaration
// gives us a `string` default export so `import avatar from
// '../assets/musicman-avatar.png'` type-checks even when the .png itself
// isn't tracked yet.

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

declare module '*.webp' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
