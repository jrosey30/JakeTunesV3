/**
 * Rock DNA — Rocksurgence step 2 (2026-10-11). A taste assessment, not trivia:
 * no right answers. Jake's words: "JakeTunes must learn WHY Jake likes music,
 * not just WHAT he likes."
 *
 * Everything here is pure and node-tested: the question bank, the
 * deterministic branching (no LLM writes questions), and the profile built
 * from the answers. The renderer walks the screens; main reads the same
 * profile to steer the Record Shop (src/main/discovery-focus.ts).
 *
 * Rules the code enforces, from Jake's brief:
 *   - Picking one band never counts against the others (relative preference).
 *   - RESPECT is never enjoyment — it adds nothing to taste.
 *   - "I don't know these songs well enough" is unfamiliarity, not dislike.
 *   - Every profile line names the answers it came from; with no answers a
 *     line says so instead of guessing.
 *   - Separate threads (heavy riffs AND 60s melody) are listed side by side,
 *     never averaged into one.
 *   - The Geese rule: discovery keeps room for music unlike the profile.
 *
 * Stored at userData/rock-dna.json (structured, hand-editable). Reusable for
 * another listener later (`person`), but this phase is Jake's alone.
 */

export type SectionId = 'A' | 'B' | 'C' | 'D' | 'E'
export type Rating = 'love' | 'like' | 'respect' | 'dislike' | 'unfamiliar'
export const RATINGS: Array<{ id: Rating; label: string; meaning: string }> = [
  { id: 'love', label: 'Love', meaning: 'One of my favorites' },
  { id: 'like', label: 'Like', meaning: 'I genuinely enjoy their music' },
  { id: 'respect', label: 'Respect', meaning: "I recognize their talent but don't particularly enjoy listening" },
  { id: 'dislike', label: 'Dislike', meaning: "Their music doesn't appeal to me" },
  { id: 'unfamiliar', label: 'Unfamiliar', meaning: "I don't know enough to judge" },
]

export const SECTIONS: Array<{ id: SectionId; title: string; blurb: string }> = [
  { id: 'A', title: 'Classic Rock Foundations', blurb: 'Where your rock instincts come from.' },
  { id: 'B', title: "Rock's Evolution", blurb: 'The later movements that shaped you.' },
  { id: 'C', title: 'Anatomy of a Great Rock Song', blurb: 'The parts of a record that grab you.' },
  { id: 'D', title: 'Song for Song', blurb: 'Specific songs, straight choices.' },
  { id: 'E', title: 'The Rocksurgence Connection', blurb: "How it carries into what you're digging now." },
]

// ── Traits ────────────────────────────────────────────────────────────────
// Four separate attributes Jake asked to keep apart (originality ≠ identity ≠
// songwriting ≠ performance), plus the qualities the questions ask about.

export type Dimension = 'vocals' | 'songwriting' | 'instruments' | 'experiment' | 'attributes' | 'turnoffs'
export const DIMENSIONS: Array<{ id: Dimension; title: string }> = [
  { id: 'vocals', title: 'Vocal preferences' },
  { id: 'songwriting', title: 'Songwriting preferences' },
  { id: 'instruments', title: 'Instrumental preferences' },
  { id: 'experiment', title: 'Experimental tolerance' },
  { id: 'attributes', title: 'What makes an artist matter' },
  { id: 'turnoffs', title: 'Musical dealbreakers' },
]

export const TRAITS = {
  'voice-first': { dim: 'vocals', label: 'The singer is what grabs you first' },
  'voice-identity': { dim: 'vocals', label: 'A voice you can pick out in a second' },
  'voice-power': { dim: 'vocals', label: 'Power and range' },
  'voice-swagger': { dim: 'vocals', label: 'Swagger and personality' },
  'voice-atmosphere': { dim: 'vocals', label: 'Fragile, atmospheric delivery' },
  hooks: { dim: 'songwriting', label: "Hooks and choruses you can't shake" },
  melody: { dim: 'songwriting', label: 'Melody first' },
  harmony: { dim: 'songwriting', label: 'Vocal harmonies' },
  twists: { dim: 'songwriting', label: 'Traditional songs with unusual twists' },
  energy: { dim: 'songwriting', label: 'Urgency and pace' },
  riffs: { dim: 'instruments', label: 'Guitar riffs' },
  heavy: { dim: 'instruments', label: 'Weight and heaviness' },
  rhythm: { dim: 'instruments', label: 'The rhythm section' },
  arrangement: { dim: 'instruments', label: 'Arrangement and studio craft' },
  interplay: { dim: 'instruments', label: 'Band chemistry and interplay' },
  atmosphere: { dim: 'instruments', label: 'Dark atmosphere' },
  complexity: { dim: 'experiment', label: 'Complex time and structure' },
  ambition: { dim: 'experiment', label: 'Ambitious, unexpected structures' },
  'slow-burn': { dim: 'experiment', label: 'Music that reveals itself over time' },
  originality: { dim: 'attributes', label: 'Originality — how unconventional it is' },
  identity: { dim: 'attributes', label: 'Identity — how recognizable the artist is' },
  songwriting: { dim: 'attributes', label: 'Songwriting — how compelling the songs are' },
  performance: { dim: 'attributes', label: 'Performance — how well it is played' },
  'tb-generic': { dim: 'turnoffs', label: 'Generic songwriting' },
  'tb-vocals': { dim: 'turnoffs', label: "Vocals that don't land" },
  'tb-overproduced': { dim: 'turnoffs', label: 'Overproduction' },
  'tb-excess': { dim: 'turnoffs', label: 'Experimentation for its own sake' },
  'tb-imitation': { dim: 'turnoffs', label: 'Sounding like a copy of a 70s band' },
  'tb-personality': { dim: 'turnoffs', label: 'No personality of its own' },
} as const satisfies Record<string, { dim: Dimension; label: string }>
export type TraitId = keyof typeof TRAITS

// ── Traditions (historical influences) — genre lineage, not opinion ─────────

export const TRADITIONS = {
  inv: 'British Invasion & 60s pop',
  powerpop: 'Power pop',
  blues: 'Blues & hard rock',
  heavy: 'Heavy riffs',
  prog: 'Psych & prog',
  glam: 'Glam & art rock',
  proto: 'Proto-punk & punk',
  roots: 'American roots rock',
  craft: 'Studio pop craft',
  grunge: '90s alternative & grunge',
  britpop: 'Britpop',
  garage: 'Garage rock revival',
  postpunk: 'Post-punk revival',
  artalt: 'Art rock & indie',
} as const
export type TraditionId = keyof typeof TRADITIONS

/** Each artist's lineage — one or two traditions. */
export const ARTIST_TRADITIONS: Record<string, TraditionId[]> = {
  'The Beatles': ['inv', 'craft'], 'The Rolling Stones': ['inv', 'blues'], 'Led Zeppelin': ['blues', 'heavy'], 'Pink Floyd': ['prog'],
  'The Who': ['inv'], Queen: ['glam', 'craft'], 'Black Sabbath': ['heavy'], 'Deep Purple': ['heavy', 'blues'],
  'David Bowie': ['glam'], 'Lou Reed': ['proto', 'glam'], 'Jimi Hendrix': ['blues', 'prog'], 'Eric Clapton': ['blues'],
  'The Kinks': ['inv'], 'The Doors': ['prog'], 'Creedence Clearwater Revival': ['roots'], 'The Velvet Underground': ['proto', 'artalt'],
  'Fleetwood Mac': ['craft'], 'Steely Dan': ['craft'], 'Electric Light Orchestra': ['craft', 'prog'], 'The Beach Boys': ['craft'],
  Rush: ['prog', 'heavy'], Yes: ['prog'], Genesis: ['prog'], 'The Allman Brothers Band': ['roots', 'blues'],
  'The Stooges': ['proto'], 'T. Rex': ['glam'], 'Thin Lizzy': ['heavy', 'blues'], 'The Animals': ['inv', 'blues'],
  'The Yardbirds': ['inv', 'blues'], 'The Byrds': ['roots', 'inv'], Cream: ['blues', 'prog'], 'Big Star': ['powerpop'],
  'The Strokes': ['garage'], 'Arctic Monkeys': ['garage'], 'The White Stripes': ['garage', 'blues'], 'The Black Keys': ['garage', 'blues'],
  Nirvana: ['grunge'], Soundgarden: ['grunge', 'heavy'], 'Alice in Chains': ['grunge', 'heavy'], 'Pearl Jam': ['grunge'],
  Radiohead: ['artalt'], 'Red Hot Chili Peppers': ['grunge'], 'Foo Fighters': ['grunge'], Muse: ['artalt', 'prog'],
  'The Smashing Pumpkins': ['grunge'], 'Queens of the Stone Age': ['heavy'], 'The Killers': ['postpunk'], 'The Raconteurs': ['garage', 'blues'],
  Oasis: ['britpop'], Blur: ['britpop'], Pulp: ['britpop'], 'The Verve': ['britpop'],
  'The Libertines': ['garage'], 'Franz Ferdinand': ['postpunk'], Interpol: ['postpunk'], 'The Hives': ['garage', 'proto'],
  'The Vines': ['garage'], 'The Rapture': ['postpunk'], 'Cage the Elephant': ['garage'], 'Kings of Leon': ['roots', 'garage'],
  'The National': ['artalt'], 'The Flaming Lips': ['artalt', 'prog'], 'The Mars Volta': ['prog'], 'The War on Drugs': ['roots'],
  'My Morning Jacket': ['roots'], 'Greta Van Fleet': ['blues'], 'Rival Sons': ['blues'], Geese: ['artalt'], 'The Lemon Twigs': ['powerpop'],
}

// ── The question bank ──────────────────────────────────────────────────────

export interface DnaOption {
  id: string
  label: string
  sub?: string
  /** An artist card — cover and "in your library" note come from the library. */
  artist?: string
  /** A song card — playable when Jake owns it (existing playback, nothing new). */
  song?: { artist: string; title: string }
  signals?: Partial<Record<TraitId, number>>
  traditions?: TraditionId[]
}

export interface DnaScreen {
  id: string
  section: SectionId
  kind: 'pick' | 'multi' | 'rate'
  text: string
  options?: DnaOption[]
  /** kind 'rate': the artists to place on Love / Like / Respect / Dislike / Unfamiliar. */
  artists?: string[]
  /** Song comparisons: "I don't know these songs well enough" — never dislike. */
  unsureLabel?: string
  /** Artist this question is about (shown as the hero; ties answers to an exception). */
  about?: string
  /** Adaptive follow-up: shown only when `after` was answered with one of `ifPicked`. */
  after?: string
  ifPicked?: string[]
  /** A recorded specific (an album, an era) — shown in the profile, no trait signals. */
  specific?: string
}

const band = (artist: string, sub?: string): DnaOption => ({ id: slug(artist), label: artist, artist, sub, traditions: ARTIST_TRADITIONS[artist] })
const song = (artist: string, title: string, signals?: DnaOption['signals']): DnaOption => ({ id: slug(`${artist} ${title}`), label: `“${title}”`, sub: artist, song: { artist, title }, signals, traditions: ARTIST_TRADITIONS[artist] })
const say = (id: string, label: string, signals?: DnaOption['signals'], traditions?: TraditionId[]): DnaOption => ({ id, label, signals, traditions })
const UNSURE = "I don't know these songs well enough"

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
}

export const SCREENS: DnaScreen[] = [
  // Section A — Classic Rock Foundations
  { id: 'a-catalog', section: 'A', kind: 'pick', text: "Pick one. You can only keep one band's entire catalog.",
    options: [band('The Beatles'), band('The Rolling Stones'), band('Led Zeppelin'), band('Pink Floyd')] },
  { id: 'f-beatles-album', section: 'A', kind: 'pick', after: 'a-catalog', ifPicked: ['the-beatles'], specific: 'Favorite Beatles album',
    text: 'Which Beatles album do you prefer?',
    options: [say('rubber-soul', 'Rubber Soul'), say('revolver', 'Revolver'), say('sgt-pepper', "Sgt. Pepper's Lonely Hearts Club Band"), say('abbey-road', 'Abbey Road')] },
  { id: 'f-stones-era', section: 'A', kind: 'pick', after: 'a-catalog', ifPicked: ['the-rolling-stones'], specific: 'Favorite Stones era',
    text: 'Which Rolling Stones do you reach for?',
    options: [say('60s-singles', 'The 60s singles'), say('beggars-to-exile', 'Beggars Banquet through Exile on Main St.'), say('some-girls', 'Some Girls and after'), say('all', 'No favorite era')] },
  { id: 'f-zeppelin', section: 'A', kind: 'multi', after: 'a-catalog', ifPicked: ['led-zeppelin'],
    text: 'What pulls you to Led Zeppelin?',
    options: [say('page', "Jimmy Page's riffs", { riffs: 1 }), say('plant', "Robert Plant's voice", { 'voice-power': 1 }), say('bonham', "John Bonham's drumming", { rhythm: 1 }), say('range', 'Their range, from folk to blues to heavy')] },
  { id: 'f-floyd-era', section: 'A', kind: 'pick', after: 'a-catalog', ifPicked: ['pink-floyd'], specific: 'Favorite Pink Floyd era',
    text: 'Which Pink Floyd era do you prefer?',
    options: [say('syd', 'Syd Barrett psychedelia'), say('meddle', 'The Meddle years'), say('dsotm-wywh', 'Dark Side of the Moon and Wish You Were Here'), say('animals-wall', 'Animals and The Wall')] },
  { id: 'a-live', section: 'A', kind: 'pick', text: 'Which band would you rather see live in its prime?',
    options: [band('The Who'), band('Queen'), band('Black Sabbath'), band('Deep Purple')] },
  { id: 'f-sabbath', section: 'A', kind: 'multi', after: 'a-live', ifPicked: ['black-sabbath'],
    text: 'What do you gravitate toward in Black Sabbath?',
    options: [say('riffs', 'Heavy riffs', { riffs: 1, heavy: 1 }), say('dark', 'Dark atmospheres', { atmosphere: 1 }), say('ozzy', "Ozzy Osbourne's vocals", { 'voice-identity': 1 }), say('songs', "The band's songwriting", { songwriting: 1 })] },
  { id: 'a-musician', section: 'A', kind: 'pick', text: 'Which artist interests you most musically?',
    options: [band('David Bowie'), band('Lou Reed'), band('Jimi Hendrix'), band('Eric Clapton')] },
  { id: 'f-bowie-era', section: 'A', kind: 'pick', after: 'a-musician', ifPicked: ['david-bowie'], specific: 'Favorite Bowie era',
    text: 'Which Bowie era do you prefer?',
    options: [say('ziggy', 'Ziggy Stardust and Aladdin Sane'), say('station', 'Young Americans and Station to Station'), say('berlin', 'The Berlin trilogy'), say('80s', "Let's Dance and after")] },
  { id: 'a-prefer', section: 'A', kind: 'pick', text: 'Which band do you prefer?',
    options: [band('The Kinks'), band('The Doors'), band('Creedence Clearwater Revival'), band('The Velvet Underground')] },
  { id: 'a-beatles-era', section: 'A', kind: 'pick', specific: 'Beatles era', text: 'Which era of The Beatles do you prefer?',
    options: [say('63-65', '1963–1965'), say('66-67', '1966–1967'), say('68-70', '1968–1970'), say('all', 'I enjoy all eras equally')] },
  { id: 'a-craft', section: 'A', kind: 'pick', text: 'Which would you put on first?',
    options: [band('Fleetwood Mac'), band('Steely Dan'), band('Electric Light Orchestra'), band('The Beach Boys')] },
  { id: 'a-players', section: 'A', kind: 'pick', text: 'Which band interests you most?',
    options: [band('Rush'), band('Yes'), band('Genesis'), band('The Allman Brothers Band')] },
  { id: 'a-attitude', section: 'A', kind: 'pick', text: 'Which band do you prefer?',
    options: [band('The Stooges'), band('T. Rex'), band('Thin Lizzy'), band('The Animals')] },
  { id: 'a-rate', section: 'A', kind: 'rate', text: 'How do you feel about each of these?',
    artists: ['Led Zeppelin', 'Black Sabbath', 'The Doors', 'Rush', 'Steely Dan', 'Fleetwood Mac', 'Cream', 'The Byrds', 'The Yardbirds', 'Big Star'] },

  // Section B — Rock's Evolution
  { id: 'b-2000s', section: 'B', kind: 'pick', text: 'Which band would you rather listen to?',
    options: [band('The Strokes'), band('Arctic Monkeys'), band('The White Stripes'), band('The Black Keys')] },
  { id: 'f-strokes', section: 'B', kind: 'pick', after: 'b-2000s', ifPicked: ['the-strokes'], specific: 'Favorite Strokes album',
    text: 'Which Strokes album do you prefer?',
    options: [say('is-this-it', 'Is This It'), say('room-on-fire', 'Room on Fire'), say('first-impressions', 'First Impressions of Earth'), say('new-abnormal', 'The New Abnormal')] },
  { id: 'f-arctic', section: 'B', kind: 'pick', after: 'b-2000s', ifPicked: ['arctic-monkeys'], specific: 'Favorite Arctic Monkeys era',
    text: 'Which Arctic Monkeys era do you prefer?',
    options: [say('whatever', 'Whatever People Say I Am, That’s What I’m Not'), say('fwn-humbug', 'Favourite Worst Nightmare and Humbug'), say('am', 'AM'), say('tbhc', 'Tranquility Base and after')] },
  { id: 'b-grunge', section: 'B', kind: 'pick', text: 'Pick your favorite.',
    options: [band('Nirvana'), band('Soundgarden'), band('Alice in Chains'), band('Pearl Jam')] },
  { id: 'f-nirvana', section: 'B', kind: 'pick', after: 'b-grunge', ifPicked: ['nirvana'], specific: 'Favorite Nirvana album',
    text: 'Which Nirvana record do you prefer?',
    options: [say('bleach', 'Bleach'), say('nevermind', 'Nevermind'), say('in-utero', 'In Utero'), say('unplugged', 'MTV Unplugged in New York')] },
  { id: 'b-identity', section: 'B', kind: 'pick', text: 'Which band has the most compelling musical identity?',
    options: [band('Radiohead'), band('Red Hot Chili Peppers'), band('Foo Fighters'), band('Muse')] },
  { id: 'f-radiohead', section: 'B', kind: 'pick', after: 'b-identity', ifPicked: ['radiohead'], specific: 'Favorite Radiohead era',
    text: 'Which Radiohead era do you prefer?',
    options: [say('bends', 'The Bends'), say('okc', 'OK Computer'), say('kid-a', 'Kid A'), say('in-rainbows', 'In Rainbows')] },
  { id: 'b-discover', section: 'B', kind: 'pick', text: 'Which band would you rather discover for the first time?',
    options: [band('The Smashing Pumpkins'), band('Queens of the Stone Age'), band('The Killers'), band('The Raconteurs')] },
  { id: 'b-britpop', section: 'B', kind: 'pick', text: 'Which band do you prefer?',
    options: [band('Oasis'), band('Blur'), band('Pulp'), band('The Verve')] },
  { id: 'b-revival', section: 'B', kind: 'pick', text: 'Which band would you rather hear?',
    options: [band('The Libertines'), band('Franz Ferdinand'), band('Interpol'), band('The Hives')] },
  { id: 'b-noughties', section: 'B', kind: 'pick', text: 'Which band do you prefer?',
    options: [band('The Vines'), band('The Rapture'), band('Cage the Elephant'), band('Kings of Leon')] },
  { id: 'b-wide', section: 'B', kind: 'pick', text: 'Which band would you rather go deep on?',
    options: [band('The National'), band('The Flaming Lips'), band('The Mars Volta'), band('The War on Drugs')] },

  // Section C — Anatomy of a Great Rock Song
  { id: 'c-first', section: 'C', kind: 'pick', text: 'What grabs you first when hearing an unfamiliar rock song?',
    options: [say('vocalist', 'The vocalist', { 'voice-first': 1 }), say('riff', 'The guitar riff', { riffs: 1 }), say('rhythm', 'The rhythm section', { rhythm: 1 }), say('melody', 'The melody', { melody: 1 })] },
  { id: 'c-replay', section: 'C', kind: 'multi', text: 'What makes you replay a song?',
    options: [say('chorus', 'An unforgettable chorus', { hooks: 1 }), say('arrangement', 'A fascinating instrumental arrangement', { arrangement: 1 }), say('vocal', 'A distinctive vocal performance', { 'voice-identity': 1 }), say('unusual', "Something unusual I didn't notice initially", { 'slow-burn': 1 })] },
  { id: 'c-time', section: 'C', kind: 'pick', text: 'How do you feel about complicated time signatures?',
    options: [say('love', 'Love them', { complexity: 2 }), say('serve', 'Appreciate them when they serve the song', { complexity: 1, songwriting: 1 }), say('indifferent', 'Usually indifferent'), say('no', 'Generally not interested', { complexity: -1 })] },
  { id: 'f-complexity', section: 'C', kind: 'multi', after: 'c-time', ifPicked: ['love', 'serve'],
    text: 'What kind of complexity keeps you listening?',
    options: [say('prog', 'Long prog epics', { ambition: 1 }), say('fusion', 'Jazz-fusion chops', { performance: 1 }), say('math', 'Interlocking math-rock patterns', { complexity: 1 }), say('hidden', 'Odd meters hiding inside catchy songs', { complexity: 1, hooks: 1 })] },
  { id: 'c-vocalist', section: 'C', kind: 'pick', text: 'Which vocalist would you rather hear?',
    // A singer, not a band: the cover is their band's, but no lineage is counted.
    options: [{ id: 'plant', label: 'Robert Plant', sub: 'Led Zeppelin', artist: 'Led Zeppelin', signals: { 'voice-power': 1 } },
      { id: 'jagger', label: 'Mick Jagger', sub: 'The Rolling Stones', artist: 'The Rolling Stones', signals: { 'voice-swagger': 1 } },
      { id: 'yorke', label: 'Thom Yorke', sub: 'Radiohead', artist: 'Radiohead', signals: { 'voice-atmosphere': 1 } },
      { id: 'mercury', label: 'Freddie Mercury', sub: 'Queen', artist: 'Queen', signals: { 'voice-power': 1 } }] },
  { id: 'c-bothers', section: 'C', kind: 'multi', text: 'What bothers you most about an otherwise talented band?',
    options: [say('generic', 'Generic songwriting', { 'tb-generic': 1 }), say('vocals', 'Unappealing vocals', { 'tb-vocals': 1 }), say('overproduction', 'Overproduction', { 'tb-overproduced': 1 }), say('excess', 'Excessive experimentation', { 'tb-excess': 1 })] },
  { id: 'c-approach', section: 'C', kind: 'pick', text: 'Which approach to rock music interests you most?',
    options: [say('simple', 'Simple songs performed brilliantly', { performance: 1 }), say('twists', 'Traditional songwriting with unusual twists', { twists: 1, songwriting: 1 }), say('ambitious', 'Ambitious compositions with unexpected structures', { ambition: 1 }), say('heavy', 'Heavy, riff-driven music', { riffs: 1, heavy: 1 })] },
  { id: 'c-originality', section: 'C', kind: 'pick', text: 'How important is originality?',
    options: [say('extremely', 'Extremely important', { originality: 2 }), say('songwriting-more', 'Important, but songwriting matters more', { originality: 1, songwriting: 1 }), say('not', 'Not particularly important if the music is excellent'), say('depends', 'Depends on the artist')] },

  // Section D — Song for Song
  { id: 'd-now', section: 'D', kind: 'pick', text: 'Which song would you rather hear right now?', unsureLabel: UNSURE,
    options: [song('Led Zeppelin', 'Black Dog', { riffs: 1 }), song('The Rolling Stones', 'Gimme Shelter'), song('The Who', "Won't Get Fooled Again", { energy: 1 }), song('Deep Purple', 'Highway Star', { performance: 1 })] },
  { id: 'd-writing', section: 'D', kind: 'pick', text: 'Which song has the most compelling songwriting?', unsureLabel: UNSURE,
    options: [song('The Beatles', 'A Day in the Life', { ambition: 1 }), song('The Beach Boys', 'Good Vibrations', { arrangement: 1 }), song('Queen', 'Bohemian Rhapsody', { ambition: 1 }), song('David Bowie', 'Life on Mars?', { melody: 1 })] },
  { id: 'd-guitar', section: 'D', kind: 'pick', text: 'Which guitar-driven song do you prefer?', unsureLabel: UNSURE,
    options: [song('Nirvana', 'In Bloom', { hooks: 1 }), song('Soundgarden', 'Outshined', { heavy: 1 }), song('Alice in Chains', 'Would?', { atmosphere: 1 }), song('Pearl Jam', 'Alive')] },
  { id: 'd-riff', section: 'D', kind: 'pick', text: 'Which riff hits hardest?', unsureLabel: UNSURE,
    options: [song('Black Sabbath', 'Iron Man'), song('Queens of the Stone Age', 'No One Knows'), song('The White Stripes', 'Seven Nation Army'), song('Cream', 'Sunshine of Your Love')] },
  { id: 'd-melody', section: 'D', kind: 'pick', text: 'Which would you rather hear right now?', unsureLabel: UNSURE,
    options: [song('The Kinks', 'Waterloo Sunset', { melody: 1 }), song('Big Star', 'September Gurls', { hooks: 1 }), song('The Beach Boys', 'God Only Knows', { harmony: 1 }), song('The Strokes', 'Last Nite', { energy: 1 })] },

  // Section E — The Rocksurgence Connection (multiple answers allowed)
  { id: 'e-geese', section: 'E', kind: 'multi', about: 'Geese', text: 'What makes Geese special to you?',
    options: [say('voice', "Cameron Winter's voice", { 'voice-identity': 1 }), say('unpredictable', 'The unpredictable songwriting', { ambition: 1 }), say('chemistry', "The band's instrumental chemistry", { interplay: 1 }), say('unusual', 'Their ability to make unusual music compelling', { 'slow-burn': 1 })] },
  { id: 'e-twigs', section: 'E', kind: 'multi', about: 'The Lemon Twigs', text: 'What appeals most about The Lemon Twigs?',
    options: [say('harmonies', 'Their harmonies', { harmony: 1 }), say('melodies', 'Their melodies', { melody: 1 }), say('60s', 'Their 1960s influences', undefined, ['inv', 'powerpop']), say('urgency', 'The urgency and flow of their songs', { energy: 1 })] },
  { id: 'e-gvf', section: 'E', kind: 'multi', about: 'Greta Van Fleet', text: 'Why does Greta Van Fleet appeal less than Rival Sons?',
    options: [say('vocals', 'The vocal delivery', { 'tb-vocals': 1 }), say('songwriting', 'The songwriting', { 'tb-generic': 1 }), say('zeppelin', 'The resemblance to Led Zeppelin', { 'tb-imitation': 1 }), say('personality', 'The overall musical personality', { 'tb-personality': 1 })] },
  { id: 'f-imitation', section: 'E', kind: 'pick', after: 'e-gvf', ifPicked: ['zeppelin'],
    text: 'Is it the imitation itself, or how they do it?',
    options: [say('any', 'Any band that sounds like a 70s band is a hard sell', { 'tb-imitation': 1 }), say('new', 'Influence is fine if they bring something new', { originality: 1, identity: 1 }), say('zeppelin-only', "It's specifically the Zeppelin copy"), say('unsure', 'Not sure')] },
  { id: 'e-angine', section: 'E', kind: 'multi', about: 'Angine de Poitrine', text: 'What makes Angine de Poitrine an exception to your general lack of interest in math rock?',
    options: [say('musicianship', 'Their extraordinary musicianship', { performance: 1 }), say('sound', 'Their unusual sound', { originality: 1 }), say('rhythm', 'Their rhythmic inventiveness', { rhythm: 1 }), say('concept', 'Their overall musical concept', { identity: 1 })] },
  { id: 'e-exciting', section: 'E', kind: 'multi', text: 'What makes a new rock artist exciting?',
    options: [say('identity', 'A recognizable musical identity', { identity: 1 }), say('songwriting', 'Excellent songwriting', { songwriting: 1 }), say('musicianship', 'Exceptional musicianship', { performance: 1 }), say('new', "Something I haven't heard before", { originality: 1 })] },
  { id: 'e-rate', section: 'E', kind: 'rate', text: 'How do you feel about each of these?',
    artists: ['Greta Van Fleet', 'Rival Sons', 'Geese', 'The Lemon Twigs', 'Angine de Poitrine', 'My Morning Jacket', 'The War on Drugs', 'The Mars Volta'] },
]

export const MAX_FOLLOW_UPS = 10
export const CORE_COUNT = SCREENS.filter((s) => !s.after).length

// ── Stored state ───────────────────────────────────────────────────────────

export interface DnaAnswer { picks?: string[]; skipped?: boolean; unsure?: boolean; at?: string }
export interface DnaState {
  version: 1
  person: string
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  /** The screen to resume on. */
  position?: string
  answers: Record<string, DnaAnswer>
  ratings: Record<string, Rating>
  /** Jake's own corrections to a profile line — they win over the answers. */
  traitEdits: Partial<Record<TraitId, TraitLevel>>
  /** The last completed run, kept when he retakes. */
  previous?: Omit<DnaState, 'previous'>
}

export const EMPTY_DNA: DnaState = { version: 1, person: 'jake', answers: {}, ratings: {}, traitEdits: {} }
const RATING_IDS = new Set<string>(RATINGS.map((r) => r.id))
const LEVELS = new Set<string>(['strong', 'some', 'mixed', 'low'])

function normalizeCore(raw: unknown): Omit<DnaState, 'previous'> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const answers: Record<string, DnaAnswer> = {}
  if (r.answers && typeof r.answers === 'object') {
    for (const [k, v] of Object.entries(r.answers as Record<string, unknown>)) {
      const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
      const picks = Array.isArray(a.picks) ? a.picks.filter((p): p is string => typeof p === 'string') : undefined
      answers[k] = { picks, skipped: a.skipped === true || undefined, unsure: a.unsure === true || undefined, at: typeof a.at === 'string' ? a.at : undefined }
    }
  }
  const ratings: Record<string, Rating> = {}
  if (r.ratings && typeof r.ratings === 'object') {
    for (const [k, v] of Object.entries(r.ratings as Record<string, unknown>)) if (typeof v === 'string' && RATING_IDS.has(v)) ratings[k] = v as Rating
  }
  const traitEdits: DnaState['traitEdits'] = {}
  if (r.traitEdits && typeof r.traitEdits === 'object') {
    for (const [k, v] of Object.entries(r.traitEdits as Record<string, unknown>)) if (k in TRAITS && typeof v === 'string' && LEVELS.has(v)) traitEdits[k as TraitId] = v as TraitLevel
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return { version: 1, person: str(r.person) || 'jake', startedAt: str(r.startedAt), updatedAt: str(r.updatedAt), completedAt: str(r.completedAt), position: str(r.position), answers, ratings, traitEdits }
}

export function normalizeDnaState(raw: unknown): DnaState {
  const core = normalizeCore(raw)
  const prev = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).previous : undefined)
  return prev && typeof prev === 'object' ? { ...core, previous: normalizeCore(prev) } : core
}

// ── Branching ──────────────────────────────────────────────────────────────

/** The screens this run walks: the core, plus each follow-up whose trigger
 *  answer was picked (in order, capped at MAX_FOLLOW_UPS). */
export function activeScreens(state: Pick<DnaState, 'answers'>): DnaScreen[] {
  let followUps = 0
  return SCREENS.filter((s) => {
    if (!s.after) return true
    const picks = state.answers[s.after]?.picks ?? []
    if (!s.ifPicked?.some((p) => picks.includes(p))) return false
    return ++followUps <= MAX_FOLLOW_UPS
  })
}

export function screenById(id: string | undefined): DnaScreen | undefined {
  return SCREENS.find((s) => s.id === id)
}

export function isAnswered(state: Pick<DnaState, 'answers' | 'ratings'>, s: DnaScreen): boolean {
  const a = state.answers[s.id]
  if (a && (a.skipped || a.unsure || (a.picks && a.picks.length > 0))) return true
  return s.kind === 'rate' && (s.artists ?? []).some((x) => state.ratings[x])
}

/** Where to resume: the saved position if it is still on the path, else the
 *  first unanswered screen, else null (finished). */
export function resumeScreen(state: DnaState): DnaScreen | null {
  const screens = activeScreens(state)
  const saved = screens.find((s) => s.id === state.position)
  if (saved && !isAnswered(state, saved)) return saved
  return screens.find((s) => !isAnswered(state, s)) ?? null
}

export function nextScreen(state: DnaState, currentId: string): DnaScreen | null {
  const screens = activeScreens(state)
  const i = screens.findIndex((s) => s.id === currentId)
  return i >= 0 && i + 1 < screens.length ? screens[i + 1] : null
}

export function prevScreen(state: DnaState, currentId: string): DnaScreen | null {
  const screens = activeScreens(state)
  const i = screens.findIndex((s) => s.id === currentId)
  return i > 0 ? screens[i - 1] : null
}

export function progress(state: DnaState): { answered: number; total: number } {
  const screens = activeScreens(state)
  return { answered: screens.filter((s) => isAnswered(state, s)).length, total: screens.length }
}

/** Retake: start fresh, keeping the last run as `previous`. */
export function retake(state: DnaState, now: string): DnaState {
  const { previous: _drop, ...last } = state
  void _drop
  return { ...EMPTY_DNA, person: state.person, startedAt: now, updatedAt: now, previous: last }
}

// ── The profile ────────────────────────────────────────────────────────────

export type TraitLevel = 'strong' | 'some' | 'mixed' | 'low'
export const LEVEL_LABEL: Record<TraitLevel | 'none', string> = {
  strong: 'Strong', some: 'Some', mixed: 'Mixed', low: 'Not for you', none: 'Not enough answers yet',
}
export const TURNOFF_LABEL: Record<TraitLevel | 'none', string> = {
  strong: 'Often a dealbreaker', some: 'Sometimes a turn-off', mixed: 'Mixed', low: "Doesn't bother you", none: 'Not enough answers yet',
}

export interface ProfileTrait { id: TraitId; label: string; level: TraitLevel | 'none'; edited: boolean; from: string[] }
export interface DnaProfile {
  answered: number
  total: number
  finished: boolean
  dims: Array<{ id: Dimension; title: string; traits: ProfileTrait[]; summary?: string }>
  /** Separate threads, never averaged — each with the artists that put it there. */
  traditions: Array<{ id: TraditionId; name: string; score: number; artists: string[] }>
  loves: string[]
  likes: string[]
  /** Talent recognized, not listening taste. Never counted as enjoyment. */
  respects: string[]
  dislikes: string[]
  unfamiliar: string[]
  exceptions: Array<{ artist: string; genre: string; why: string[] }>
  specifics: Array<{ label: string; answer: string }>
  /** Jake's own discovery rules (from his brief), plus what his answers add. */
  philosophy: string[]
}

const RATING_WEIGHT: Record<Rating, number> = { love: 2, like: 1, respect: 0, dislike: -1, unfamiliar: 0 }

function levelOf(score: number, mentions: number): TraitLevel | 'none' {
  if (!mentions) return 'none'
  if (score >= 2) return 'strong'
  if (score === 1) return 'some'
  if (score < 0) return 'low'
  return 'mixed'
}

export function buildProfile(state: DnaState, exceptions: Array<{ artist: string; genre: string }> = []): DnaProfile {
  const screens = activeScreens(state)
  const score = new Map<TraitId, number>()
  const mentions = new Map<TraitId, number>()
  const from = new Map<TraitId, string[]>()
  const trad = new Map<TraditionId, { score: number; artists: Set<string> }>()
  const specifics: DnaProfile['specifics'] = []
  const bump = (id: TraitId, w: number, why: string): void => {
    score.set(id, (score.get(id) ?? 0) + w)
    mentions.set(id, (mentions.get(id) ?? 0) + 1)
    from.set(id, [...(from.get(id) ?? []), why])
  }
  const lineage = (ts: TraditionId[] | undefined, w: number, artist?: string): void => {
    for (const t of ts ?? []) {
      const cur = trad.get(t) ?? { score: 0, artists: new Set<string>() }
      cur.score += w
      if (artist && w > 0) cur.artists.add(artist)
      trad.set(t, cur)
    }
  }

  for (const s of screens) {
    const a = state.answers[s.id]
    if (!a || a.skipped || a.unsure || !a.picks?.length || s.kind === 'rate') continue
    for (const pid of a.picks) {
      const o = s.options?.find((x) => x.id === pid)
      if (!o) continue
      // The answer and the whole question — never a clipped fragment.
      const why = `${o.song ? `${o.label} (${o.song.artist})` : `“${o.label}”`} — ${s.text}`
      for (const [t, w] of Object.entries(o.signals ?? {})) bump(t as TraitId, w as number, why)
      // A pick is +1 for its own lineage; the bands not picked get nothing —
      // choosing one never counts against the others.
      lineage(o.traditions, 1, o.song?.artist ?? o.artist)
      if (s.specific) specifics.push({ label: s.specific, answer: o.label })
    }
  }
  const byRating: Record<Rating, string[]> = { love: [], like: [], respect: [], dislike: [], unfamiliar: [] }
  for (const [artist, r] of Object.entries(state.ratings)) {
    byRating[r].push(artist)
    lineage(ARTIST_TRADITIONS[artist], RATING_WEIGHT[r], artist)
  }

  const dims = DIMENSIONS.map((d) => {
    const traits = (Object.keys(TRAITS) as TraitId[]).filter((id) => TRAITS[id].dim === d.id).map((id): ProfileTrait => {
      const edit = state.traitEdits[id]
      return { id, label: TRAITS[id].label, level: edit ?? levelOf(score.get(id) ?? 0, mentions.get(id) ?? 0), edited: !!edit, from: from.get(id) ?? [] }
    })
    return { id: d.id, title: d.title, traits, summary: d.id === 'experiment' ? experimentSummary(traits, state) : undefined }
  })

  const traditions = [...trad.entries()].filter(([, v]) => v.score > 0)
    .map(([id, v]) => ({ id, name: TRADITIONS[id], score: v.score, artists: [...v.artists] }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  // Why an exception is loved: the answers to the question asked about them.
  const whyLoved = (artist: string): string[] => screens.filter((x) => x.about && nk(x.about) === nk(artist))
    .flatMap((x) => (state.answers[x.id]?.picks ?? []).map((p) => x.options?.find((o) => o.id === p)?.label ?? ''))
    .filter(Boolean)

  const { answered, total } = progress(state)
  const philosophy = [
    "Don't reject music just because it's unlike what you already love. You came around to Geese, and Getting Killed became a 10/10.",
    'What you put on Rocksurgence, and what you mark Not for me in the Record Shop, overrule anything this profile infers.',
  ]
  const excitingPicks = state.answers['e-exciting']?.picks ?? []
  if (excitingPicks.length) {
    const s = screenById('e-exciting')!
    philosophy.push(`What makes a new artist exciting: ${excitingPicks.map((p) => s.options!.find((o) => o.id === p)?.label.toLowerCase()).filter(Boolean).join(', ')}.`)
  }

  return {
    answered, total, finished: answered === total,
    dims, traditions,
    loves: byRating.love, likes: byRating.like, respects: byRating.respect, dislikes: byRating.dislike, unfamiliar: byRating.unfamiliar,
    exceptions: exceptions.map((e) => ({ artist: e.artist, genre: e.genre, why: whyLoved(e.artist) })),
    specifics,
    philosophy,
  }
}

function experimentSummary(traits: ProfileTrait[], state: DnaState): string | undefined {
  const lvl = (id: TraitId): TraitLevel | 'none' => traits.find((t) => t.id === id)?.level ?? 'none'
  const positive = (['complexity', 'ambition', 'slow-burn'] as TraitId[]).some((id) => lvl(id) === 'strong' || lvl(id) === 'some')
  const excess = (state.answers['c-bothers']?.picks ?? []).includes('excess')
  if (lvl('complexity') === 'low' && !positive) return 'Low — complexity rarely pulls you in.'
  if (positive && excess) return 'High when it serves the song. Experimentation for its own sake loses you.'
  if (positive) return 'High — unexpected turns pull you in.'
  if (excess) return 'Experimentation for its own sake loses you.'
  return undefined
}

const nk = (s: string | undefined): string => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()

/** Artists Jake marked Dislike — kept out of the Record Shop (explicit). */
export function dislikedArtists(state: DnaState): string[] {
  return Object.entries(state.ratings).filter(([, r]) => r === 'dislike').map(([a]) => a)
}

/**
 * The profile as one line for the Record Shop's picking prompts. Only what
 * his answers say; '' with no answers (discovery behaves exactly as before).
 */
export function dnaPromptLine(p: DnaProfile): string {
  if (!p.answered) return ''
  const parts: string[] = []
  const strong = (dim: Dimension): string[] => p.dims.find((d) => d.id === dim)!.traits.filter((t) => t.level === 'strong' || t.level === 'some').map((t) => t.label.split(' — ')[0].toLowerCase())
  const values = [...strong('vocals'), ...strong('songwriting'), ...strong('instruments'), ...strong('experiment'), ...strong('attributes')]
  if (p.loves.length) parts.push(`Loves: ${p.loves.join(', ')}.`)
  if (p.likes.length) parts.push(`Likes: ${p.likes.join(', ')}.`)
  if (p.respects.length) parts.push(`Respects but does NOT enjoy (never treat as taste): ${p.respects.join(', ')}.`)
  if (p.dislikes.length) parts.push(`Dislikes: ${p.dislikes.join(', ')}.`)
  if (values.length) parts.push(`Values: ${values.join('; ')}.`)
  const turnoffs = p.dims.find((d) => d.id === 'turnoffs')!.traits.filter((t) => t.level === 'strong' || t.level === 'some').map((t) => t.label.toLowerCase())
  if (turnoffs.length) parts.push(`Turn-offs: ${turnoffs.join('; ')}.`)
  if (p.traditions.length) parts.push(`Threads that coexist (do not average them): ${p.traditions.slice(0, 5).map((t) => t.name).join(' / ')}.`)
  for (const e of p.exceptions) parts.push(`${e.artist} is loved despite ${e.genre || 'its genre'}${e.why.length ? ` (${e.why.join(', ').toLowerCase()})` : ''} — not a door to that genre.`)
  parts.push('Leave room for records unlike all of this that reward patience — he came around to Geese.')
  return `Rock DNA (his own quiz answers): ${parts.join(' ')}`
}
