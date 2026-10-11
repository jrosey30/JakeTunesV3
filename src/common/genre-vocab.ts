/**
 * Jake's genre list (2026-10-11): 132 genres, one per album, one shelf per
 * artist. Approved by him shelf by shelf — the genre filer may ONLY choose from
 * this list, never invent. Generated from the practice run's vocab.py; edit here.
 *
 * His rules, enforced in code by the filer (src/main/genre-filer.ts):
 *   - a specific genre he already gave a song stands (only CATCH_ALL tags are re-filed)
 *   - rock is conservative: a song tagged Rock / Classic Rock only moves to a rock shelf
 *   - one shelf per artist, except PER_ALBUM artists (genre-hopping on purpose)
 *   - no genre shaped around one artist, except the ones he kept on purpose
 */
export type GenreArea = string
export interface GenreDef { area: GenreArea; name: string; definition: string; strict: boolean }

const RAW: Array<[string, string, string, boolean]> = [
  ["Rock", "Rock", "Straight-ahead rock that fits no narrower rock shelf \u2014 today's bands included", false],
  ["Rock", "Classic Rock", "60s\u201370s album-rock canon: Beatles, Who, Stones, Zeppelin-era bands", false],
  ["Rock", "Hard Rock", "Riff-driven, loud and bluesy: Van Halen, AC/DC", false],
  ["Rock", "Prog Rock", "Long-form, virtuoso, conceptual: Rush, Yes, Pink Floyd", false],
  ["Rock", "Glam Rock", "Theatrical 70s stomp and sparkle: Bowie, T. Rex, Sweet", false],
  ["Rock", "Southern Rock", "Guitar rock from the American South: Skynyrd, Allmans", false],
  ["Rock", "Americana Rock", "Heartland and roots rock: Tom Petty, Wilburys", false],
  ["Rock", "Psychedelic Rock", "Trippy guitar rock, 60s originals and modern heirs", false],
  ["Rock", "Space Rock", "Spacey, droning, cosmic rock", false],
  ["Rock", "Garage Rock", "Raw, fuzzy, stripped-down rock and its revival", false],
  ["Rock", "Alternative", "80s\u201390s alternative rock \u2014 Pixies, Sonic Youth, Pumpkins", true],
  ["Rock", "College Rock", "80s US college-radio guitar bands: R.E.M., Replacements, Camper Van Beethoven", false],
  ["Rock", "Grunge", "Seattle and Sub Pop: Nirvana, Soundgarden, Alice In Chains", false],
  ["Rock", "Indie Rock", "Guitar indie from the 2000s on", false],
  ["Rock", "Indie Sleaze", "Late-2000s party indie and blog rock", false],
  ["Rock", "Power Pop", "Big hooks, crunchy guitars, harmonies: Lemon Twigs, Big Star", false],
  ["Rock", "Shoegaze", "Walls of guitar noise and buried vocals", false],
  ["Rock", "Math Rock", "Odd meters, tapped guitars, intricate rhythms", false],
  ["Rock", "Stoner Rock", "Heavy, fuzzed desert rock: Kyuss, QOTSA", false],
  ["Rock", "Blues Rock", "Blues-rooted rock: Black Keys, White Stripes", false],
  ["Rock", "Funk Rock", "Rock built on funk grooves: Chili Peppers, Primus", false],
  ["Rock", "Latin Rock", "Rock with Latin rhythms: Santana", false],
  ["Punk", "Punk", "First-wave punk: Ramones, Clash, Buzzcocks", false],
  ["Punk", "Hardcore Punk", "Fast, short, intense: Black Flag, Minor Threat, Turnstile", false],
  ["Punk", "Pop-Punk", "Melodic punk: blink-182, Green Day, Sum 41", false],
  ["Punk", "Ska-Punk", "Punk with ska upstrokes and horns", false],
  ["Punk", "Garage Punk", "Snotty, lo-fi punk-rooted garage", false],
  ["Punk", "Post-Punk", "Angular, dark, rhythmic \u2014 originals and today's UK wave", false],
  ["Punk", "Dance-Punk", "Punk you can dance to: LCD Soundsystem, Fat Dog", false],
  ["Metal", "Heavy Metal", "Classic metal: Black Sabbath, Ozzy, Iron Maiden", false],
  ["Metal", "Thrash Metal", "Fast, aggressive 80s metal: Metallica, Slayer", false],
  ["Metal", "Nu-Metal", "Rap-inflected metal: Korn, Linkin Park", false],
  ["Metal", "Groove Metal", "Mid-tempo crushing grooves: Pantera, White Zombie", false],
  ["New Wave & Synth", "New Wave", "Late-70s/80s new wave: Cars, Blondie, Talking Heads", false],
  ["New Wave & Synth", "Synth-Pop", "Synthesizer-led pop, 80s and modern", false],
  ["New Wave & Synth", "Darkwave", "Cold, dark synth music", false],
  ["New Wave & Synth", "Goth Rock", "Gothic rock: The Cure's dark side, Siouxsie", false],
  ["New Wave & Synth", "Synthwave", "Retro-80s synth revival", false],
  ["New Wave & Synth", "Future Funk", "Chopped disco/funk edits, vaporwave-adjacent", false],
  ["Pop", "Pop", "mainstream chart pop", true],
  ["Pop", "Dance-Pop", "Club-ready chart pop", false],
  ["Pop", "Indie Pop", "Indie-label pop with guitars or synths", false],
  ["Pop", "Bedroom Pop", "Home-recorded, intimate pop: Clairo, Frankie Cosmos", false],
  ["Pop", "Dream Pop", "Hazy, reverb-soaked pop", false],
  ["Pop", "Jangle Pop", "Chiming guitar pop", false],
  ["Pop", "Psychedelic Pop", "Swirly, trippy pop: Tame Impala, TV Girl", false],
  ["Pop", "Art Pop", "Experimental, high-concept pop", false],
  ["Pop", "Hyperpop", "Maximalist, glitchy, pitched-up pop", false],
  ["Pop", "Yacht Rock", "Smooth late-70s/80s soft rock-soul: Steely Dan, Hall & Oates", false],
  ["Pop", "Traditional Pop", "Crooners and standards: Sinatra, Armstrong", false],
  ["Pop", "Easy Listening", "Lounge and light instrumental", false],
  ["Hip-Hop", "East Coast Rap", "New York and East Coast: Biggie, Nas, Mobb Deep, Big Pun", false],
  ["Hip-Hop", "West Coast Rap", "LA and Bay: Dr. Dre, 2Pac, Snoop, N.W.A", false],
  ["Hip-Hop", "Southern Rap", "The South: Outkast, T.I., Ludacris", false],
  ["Hip-Hop", "Midwest Rap", "Detroit, Chicago, St. Louis: Eminem, D12", false],
  ["Hip-Hop", "Trap", "Hi-hat rolls and 808s: Future, Migos, Travis Scott", false],
  ["Hip-Hop", "Jazz Rap", "Jazzy, sample-rich: Tribe, De La Soul, Jurassic 5", false],
  ["Hip-Hop", "Conscious Rap", "Socially focused lyricism: Kendrick, J. Cole, Lupe", false],
  ["Hip-Hop", "Alternative Hip-Hop", "Left-field rap outside the regional lanes", false],
  ["Hip-Hop", "Cloud Rap", "Hazy, atmospheric rap: A$AP Rocky", false],
  ["Hip-Hop", "Melodic Rap", "Sung, introspective rap: Drake, Kid Cudi, Mac Miller", false],
  ["Hip-Hop", "Old School Hip-Hop", "70s\u201380s pioneers: Grandmaster Flash, Kurtis Blow", false],
  ["Hip-Hop", "Rap Rock", "Rap over rock: Beastie Boys, Cypress Hill", false],
  ["Hip-Hop", "Club Rap", "Radio and club rap hits and collabs: Akon, Nelly-style crossovers", false],
  ["Hip-Hop", "Instrumental Hip-Hop", "Beat-tape and instrumental rap production", false],
  ["Hip-Hop", "Dub-Hop", "Hip-hop on dub and reggae foundations", false],
  ["Hip-Hop", "Israeli Hip-Hop", "Hebrew-language rap", false],
  ["R&B, Soul & Funk", "R&B", "contemporary R&B: Usher, Timberlake", true],
  ["R&B, Soul & Funk", "Alternative R&B", "Moody, art-leaning R&B: Frank Ocean, SZA, The Weeknd", false],
  ["R&B, Soul & Funk", "Neo-Soul", "90s-onward soul revival: D'Angelo, Erykah Badu", false],
  ["R&B, Soul & Funk", "Classic Soul", "60s\u201370s soul: James Brown, Bill Withers, Curtis Mayfield", false],
  ["R&B, Soul & Funk", "Motown", "Detroit hit-factory soul: Stevie Wonder, Jackson 5", false],
  ["R&B, Soul & Funk", "Modern Soul", "Today's retro-soul bands", false],
  ["R&B, Soul & Funk", "Funk", "Classic funk and P-Funk: Parliament, Funkadelic", false],
  ["R&B, Soul & Funk", "Nu Funk", "Modern funk revival", false],
  ["R&B, Soul & Funk", "Boogie", "Early-80s post-disco funk", false],
  ["R&B, Soul & Funk", "Brazilian Boogie", "Brazilian post-disco funk", false],
  ["R&B, Soul & Funk", "Indie Groove", "Indie bands built on funk/soul grooves: Jungle", false],
  ["Electronic & Dance", "House", "Four-on-the-floor house that fits no narrower shelf", false],
  ["Electronic & Dance", "Deep House", "Warm, soulful, slower house", false],
  ["Electronic & Dance", "Disco House", "House built on disco samples", false],
  ["Electronic & Dance", "Chicago House", "Original Chicago house", false],
  ["Electronic & Dance", "Acid House", "Squelchy 303 house", false],
  ["Electronic & Dance", "Tech House", "Tech-leaning, minimal house", false],
  ["Electronic & Dance", "French House", "French touch filter-disco: Daft Punk, Modjo", false],
  ["Electronic & Dance", "Latin House", "House with Latin rhythms", false],
  ["Electronic & Dance", "Electro House", "Big-room, distorted house: Benny Benassi, deadmau5", false],
  ["Electronic & Dance", "Disco", "Classic 70s disco: Bee Gees, Donna Summer", false],
  ["Electronic & Dance", "Nu Disco", "Modern disco: Poolside, Donny Ben\u00e9t", false],
  ["Electronic & Dance", "Italo Disco", "Italian synth disco", false],
  ["Electronic & Dance", "Electroclash", "2000s punky, deadpan electro", false],
  ["Electronic & Dance", "French Electro", "Ed Banger-style distorted electro: Justice, SebastiAn", false],
  ["Electronic & Dance", "Alternative Dance", "Indie bands on the dancefloor: New Order", false],
  ["Electronic & Dance", "Big Beat", "Late-90s breaks: Fatboy Slim, Chemical Brothers", false],
  ["Electronic & Dance", "Breakbeat", "Broken-beat dance music", false],
  ["Electronic & Dance", "Drum & Bass", "Fast breakbeats and heavy bass", false],
  ["Electronic & Dance", "UK Garage", "Skippy UK garage and 2-step", false],
  ["Electronic & Dance", "EDM", "Festival electronic and bass drops: Skrillex, Calvin Harris", false],
  ["Electronic & Dance", "Trance", "Euphoric, building trance", false],
  ["Electronic & Dance", "Eurodance", "90s Euro club hits: Alice Deejay, Technotronic", false],
  ["Electronic & Dance", "Techno", "Driving, machine-made techno", false],
  ["Electronic & Dance", "Ambient", "Beatless, atmospheric", false],
  ["Electronic & Dance", "Ambient House", "Chill-out house and dub: The Orb", false],
  ["Electronic & Dance", "Downtempo", "Slow, laid-back electronica", false],
  ["Electronic & Dance", "Chillwave", "Hazy, nostalgic electronic pop", false],
  ["Electronic & Dance", "Trip Hop", "Bristol-style slow beats: Massive Attack", false],
  ["Electronic & Dance", "Indietronica", "Indie songwriting with electronics: The Postal Service", false],
  ["Electronic & Dance", "Electro Swing", "Swing samples on dance beats", false],
  ["Electronic & Dance", "Experimental", "Defies genre on purpose", false],
  ["Electronic & Dance", "Mashup", "Built from other records: Girl Talk", false],
  ["Country, Folk & Blues", "Country", "All country, kept general: classic, outlaw and today's", false],
  ["Country, Folk & Blues", "Folk", "Acoustic folk", false],
  ["Country, Folk & Blues", "Singer-Songwriter", "Song-first storytellers: Jim Croce, Neil Young", false],
  ["Country, Folk & Blues", "Blues", "The blues", false],
  ["Jazz, Brazil, Latin & Global", "Jazz", "Jazz proper", false],
  ["Jazz, Brazil, Latin & Global", "Jazz Fusion", "Jazz-funk and fusion: Azymuth, Robson Jorge", false],
  ["Jazz, Brazil, Latin & Global", "Jazz Pop", "Pop songs with jazz harmony: Mei Semones, Norah Jones", false],
  ["Jazz, Brazil, Latin & Global", "Latin Jazz", "Latin-rhythm jazz", false],
  ["Jazz, Brazil, Latin & Global", "Nu Jazz", "Jazz with electronic and club production", false],
  ["Jazz, Brazil, Latin & Global", "Geordie Jazz", "Newcastle jazz scene", false],
  ["Jazz, Brazil, Latin & Global", "Bossa Nova", "Classic bossa: Jobim", false],
  ["Jazz, Brazil, Latin & Global", "MPB", "Brazilian popular music: Jorge Ben, Tim Maia", false],
  ["Jazz, Brazil, Latin & Global", "Latin", "Latin music that fits no narrower shelf", false],
  ["Jazz, Brazil, Latin & Global", "Latin Pop", "Spanish-language pop", false],
  ["Jazz, Brazil, Latin & Global", "Reggae", "Reggae and roots: Bob Marley, Toots", false],
  ["Jazz, Brazil, Latin & Global", "Dancehall", "Dancehall", false],
  ["Jazz, Brazil, Latin & Global", "Afrobeat", "Fela-descended afrobeat and UK afro-jazz", false],
  ["Jazz, Brazil, Latin & Global", "Global Psych", "Psych and funk from around the world: Altin G\u00fcn, Y\u012aN Y\u012aN", false],
  ["Other", "Soundtrack", "Film and TV soundtracks and scores", false],
  ["Other", "Video Game Music", "Game soundtracks", false],
  ["Other", "Comedy", "Comedy and novelty", false],
  ["Other", "Children's", "Kids' music", false],
]
export const GENRES: readonly GenreDef[] = RAW.map(([area, name, definition, strict]) => ({ area, name, definition, strict }))
export const GENRE_NAMES: ReadonlySet<string> = new Set(GENRES.map((g) => g.name))
export const isListGenre = (g: string | undefined): boolean => !!g && GENRE_NAMES.has(g.trim())

/** His old catch-all tags: the only list genres the filer may re-file. */
export const CATCH_ALL: ReadonlySet<string> = new Set(['Alternative', 'Rock', 'Classic Rock', 'Pop', 'R&B', 'Punk'])
/** Every rock, punk and metal shelf, plus Yacht Rock (Soft Rock folded into it). */
export const ROCK_FAMILY: ReadonlySet<string> = new Set([...GENRES.filter((g) => ['Rock', 'Punk', 'Metal'].includes(g.area)).map((g) => g.name), 'Yacht Rock'])
/** Filed album by album, on purpose (Jake 10/11: King Gizzard changes genre every record). */
export const PER_ALBUM_ARTISTS: ReadonlySet<string> = new Set(['King Gizzard & The Lizard Wizard'])
/** One-band genres he kept by choice — never flagged as artist-shaped. */
export const KEPT_ONE_ARTIST: ReadonlySet<string> = new Set(["Electro Swing", "Geordie Jazz", "Israeli Hip-Hop", "Space Rock"])

/** Phone edits layered over the desktop's (2026-10-11): a phone genre only wins
 *  when it's a SPECIFIC genre on the list — old phone tags like "Alternative "
 *  or "Pop, Rock" would otherwise mask the shelf the desktop filed. Every other
 *  field passes. */
export function phoneOverlayFields(fields: Record<string, string>): Record<string, string> {
  if (fields.genre === undefined || (isListGenre(fields.genre) && !CATCH_ALL.has(fields.genre.trim()))) return fields
  const { genre: _dropped, ...rest } = fields
  return rest
}
