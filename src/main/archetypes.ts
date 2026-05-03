// 4.4.1: WJLR segment archetypes — the 11 structural templates from the
// show bible. Topic comes from the topic-angle list (genre beef, hot
// take, lyric roast, etc.). SHAPE comes from here. The renderer picks
// one shape per slot per the hour clock; the radio handler pulls the
// matching archetype text into the prompt so Claude knows what
// structural pattern this segment should follow.
//
// Caller archetype (G) and Guest Drop (H, Stephen) are handled by the
// callerSegment / djHandsSegment branches in the radio handler — they
// have richer per-character logic. The other 9 archetypes live here.

export type ArchetypeId =
  | 'cold-open-hot-take'    // A — slot 1
  | 'lateral-pivot'         // B — slot 3
  | 'lightning-round'       // C — slot 9 substitute when Stephen absent, also slot 4
  | 'deferred-punchline'    // D — payoff at slot 11 references slot 1 hot take
  | 'lineage-bridge'        // E — slot 3 or 8
  | 'lyric-roast'           // F — slot 4 or slot 9 substitute
  | 'brooklyn-texture'      // I — slot 4 or 10
  | 'historian-dwell'       // J — slot 8 only, MM-dominant
  | 'hour-out'              // K — slot 11, references slot 1 hot take
  | 'back-announce'         // standard MM/Megan back-announce — slot 2, 6, 10
  | 'recovery'              // post-guest / post-caller recovery beat — slot 6, 10

export interface Archetype {
  id: ArchetypeId
  name: string
  /** One-paragraph structural description Claude reads in the prompt. */
  shape: string
  /** Typical length in seconds — informs max_tokens and the prompt's
   *  pacing instruction. */
  lengthSec: [number, number]
  /** Slots where this archetype is the primary or default pick. */
  defaultSlots: number[]
  /** Example openings — for tone reference, not verbatim use. */
  examples: string[]
  /** Energy tag from §6 of the bible. */
  energy: 'PEAK' | 'HIGH' | 'MED' | 'LOW' | 'MED-LOW' | 'MED-HIGH'
  /** Dwell tag from §6 of the bible. */
  dwell: 'TIGHT' | 'NORMAL' | 'LONG'
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  'cold-open-hot-take': {
    id: 'cold-open-hot-take',
    name: 'Cold Open Hot Take',
    shape: `MM opens with a DECLARATIVE BOMB — no setup, no easing in. Megan rebuts inside 2 sentences. They volley 2-3 times, no resolution. Cut to track. This is the opener of the hour and sets the energy.`,
    lengthSec: [18, 22],
    defaultSlots: [1],
    examples: [
      `I'll say it. The best Steely Dan album is Gaucho and it's not close.`,
      `Here's a fact: Charli XCX has not made a single song that will outlive its release week.`,
      `Folklore is the only Taylor Swift record that holds up. The rest is content-shaped product. Fight me.`,
    ],
    energy: 'HIGH',
    dwell: 'NORMAL',
  },

  'lateral-pivot': {
    id: 'lateral-pivot',
    name: 'Lateral Pivot',
    shape: `Conversation about Track A. One host (either) finds an UNEXPECTED CONNECTION to artist/era/scene B. Lands on a claim about B that recontextualizes A. The pivot has to feel earned, not arbitrary.`,
    lengthSec: [20, 25],
    defaultSlots: [3],
    examples: [
      `Speaking of horn arrangements — and we are speaking of horn arrangements — this whole thing comes out of one Earth, Wind & Fire session in '74…`,
      `Funny you mention Phoebe Bridgers, because the person she most reminds me of is Mark Kozelek before he became insufferable.`,
    ],
    energy: 'MED',
    dwell: 'LONG',
  },

  'lightning-round': {
    id: 'lightning-round',
    name: 'Lightning Round',
    shape: `RAPID-FIRE prompts. One word or one sentence each, alternating MM and Megan. No dwell. Sub-18-second segment. Used to inject TEMPO. Max 6 exchanges. The format is: MM throws a category, Megan responds with one answer, MM judges instantly, repeat with new category.`,
    lengthSec: [15, 18],
    defaultSlots: [4, 9],  // 9 only when Stephen absent (substitute role)
    examples: [
      `Lightning round. Best opening track of the '90s. Go.` /* → */ + ` Smells Like Teen Spirit.` /* → */ + ` Boring. Loser, by Beck.`,
      `Three words on Beach House.` /* → */ + ` Indistinguishable. From. Themselves.`,
    ],
    energy: 'HIGH',
    dwell: 'TIGHT',
  },

  'deferred-punchline': {
    id: 'deferred-punchline',
    name: 'Deferred Punchline (payoff)',
    shape: `THIS SEGMENT IS A PAYOFF. The hour opened (slot 1) with a hot take from MM or Megan. Now (slot 11) the OTHER host calls it back — references the exact claim, asks them to revise, or simply revisits it with new context. The whole closing segment is them litigating it. THIS IS WHAT MAKES THE HOUR FEEL LIKE AN HOUR.

The slot-1 hot take is in your context — use it. Don't invent a new claim, refer to the actual one.`,
    lengthSec: [15, 20],
    defaultSlots: [11],
    examples: [
      `Music Man, you said Aja beats anything from this century. Have you heard Black Country, New Road?`,
      `Megan, you opened the hour saying 1989 was content-shaped product. You sticking with that?`,
    ],
    energy: 'MED',
    dwell: 'NORMAL',
  },

  'lineage-bridge': {
    id: 'lineage-bridge',
    name: 'Lineage Bridge',
    shape: `Track A → "you can hear this in" → Track B → "and that came from" → Track C. A chain of THREE. MM leads (this is his territory). Megan either co-signs or breaks the chain with one alternative theory. Specific records, specific years.`,
    lengthSec: [22, 25],
    defaultSlots: [3, 8],
    examples: [
      `You can draw a straight line from this track back through Talk Talk's Spirit of Eden, and from there back to one specific Robert Wyatt record from 1974…`,
    ],
    energy: 'MED',
    dwell: 'LONG',
  },

  'lyric-roast': {
    id: 'lyric-roast',
    name: 'Lyric Roast',
    shape: `One host quotes 3-5 WORDS of a lyric — NEVER MORE than 5 words for both copyright AND comic timing. Asks the other to defend or condemn. The other answers. First host either escalates or backs off. Megan initiates more often (she's sharper).`,
    lengthSec: [15, 20],
    defaultSlots: [4, 9],
    examples: [
      `"I'm in love with my car." Defend it.`,
      `"I'm a barbie girl." Cultural treasure or war crime?`,
    ],
    energy: 'HIGH',
    dwell: 'TIGHT',
  },

  'brooklyn-texture': {
    id: 'brooklyn-texture',
    name: 'Brooklyn Texture',
    shape: `A non-music aside about something SPECIFICALLY LOCAL. Bay Ridge bagel, the F train, a Greenpoint bar that closed, a Park Slope parent overheard. Functions as breath. Lands on a music observation by the end. Either host. Megan more often (MM gets too into it).`,
    lengthSec: [15, 18],
    defaultSlots: [4, 10],
    examples: [
      `Saw a guy on the Q train this morning with a Steely Dan tattoo. Music Man, your people are reproducing.`,
      `They closed the record store on Manhattan Ave. The one with the cat. RIP.`,
    ],
    energy: 'LOW',
    dwell: 'NORMAL',
  },

  'historian-dwell': {
    id: 'historian-dwell',
    name: 'Historian Dwell',
    shape: `MM picks a SINGLE album/session/scene and goes DEEP. Real depth — three or four specific facts (year, label, who played what, what happened in the room). Megan interrupts ONCE in the middle to keep him honest. He finishes. Megan delivers a one-line DEFLATE at the end. MM dominates ~70% of the dialogue. This is the show's intellectual heart — slot 8 ONLY.`,
    lengthSec: [22, 25],
    defaultSlots: [8],
    examples: [
      `Okay. Let's talk about Larry Levan's last set at the Garage. September 1987…`,
    ],
    energy: 'LOW',
    dwell: 'LONG',
  },

  'hour-out': {
    id: 'hour-out',
    name: 'Hour Out',
    shape: `Closes the hour. Megan delivers it 60% of the time. ALWAYS references the slot-1 hot take (Deferred Punchline payoff lives here) OR resolves a running bit. Lands on a clean exit line that hands off to the next track or the top-of-hour ID.`,
    lengthSec: [15, 20],
    defaultSlots: [11],
    examples: [
      `Alright, before we go — Music Man, you opened the hour saying Aja beats anything this century. You want to revise?`,
      `That's the hour. We argued, he lost, you decide.`,
    ],
    energy: 'MED',
    dwell: 'NORMAL',
  },

  'back-announce': {
    id: 'back-announce',
    name: 'Back-Announce',
    shape: `Standard back-announce of the just-played track + tee up of the next. Lower-stakes than a hot take. The breath after the opener. A small specific observation about what just played, then a one-line setup for what's next. No big claim. No grand pronouncement.`,
    lengthSec: [15, 20],
    defaultSlots: [2, 6, 10],
    examples: [
      `That was [Artist] — and what a snare sound on that one.`,
      `Coming up next — [Artist]. Megan's gonna hate this.`,
    ],
    energy: 'MED',
    dwell: 'NORMAL',
  },

  'recovery': {
    id: 'recovery',
    name: 'Recovery / Cool-down',
    shape: `Post-guest or post-caller cool-down beat. The hosts digest what just happened. Megan teases MM about how the previous segment went (especially if Stephen or LaShonte just demolished his frame). Quieter. Lower energy. The release after a peak.`,
    lengthSec: [15, 18],
    defaultSlots: [6, 10],
    examples: [
      `Music Man, Stephen Hands just retired you in real time. How are we doing.`,
      `Alright — that was Bernard. As usual, leaving us all looking shorter.`,
    ],
    energy: 'LOW',
    dwell: 'NORMAL',
  },
}

/** Build the prompt fragment that tells Claude WHICH archetype shape to
 *  follow for this segment. Injected into the radio prompt under
 *  "ARCHETYPE THIS SEGMENT". */
export function buildArchetypeBlock(archetypeId: ArchetypeId, opts: {
  slot1HotTake?: string  // for deferred-punchline payoff
}): string {
  const a = ARCHETYPES[archetypeId]
  if (!a) return ''
  const lines: string[] = []
  lines.push(`ARCHETYPE THIS SEGMENT: "${a.name}"`)
  lines.push('')
  lines.push(`SHAPE: ${a.shape}`)
  lines.push('')
  lines.push(`Energy: ${a.energy}. Dwell: ${a.dwell}. Length: ${a.lengthSec[0]}-${a.lengthSec[1]} seconds.`)
  if (a.examples.length > 0) {
    lines.push('')
    lines.push('Tone reference (NOT to copy — use only as a sense of voice):')
    for (const ex of a.examples) lines.push(`  - "${ex}"`)
  }
  // Special case: deferred-punchline gets the slot-1 hot take so it can pay it off.
  if (archetypeId === 'deferred-punchline' || archetypeId === 'hour-out') {
    if (opts.slot1HotTake) {
      lines.push('')
      lines.push(`SLOT-1 HOT TAKE FROM THE TOP OF THE HOUR (this is what you're paying off — refer to it specifically, don't invent a new claim):`)
      lines.push(`  "${opts.slot1HotTake.slice(0, 280)}"`)
      lines.push('')
      lines.push(`The closing segment LITIGATES this take. Megan more often opens it (60% of the time). The other host (whoever didn't make the original take) initiates the callback — calls them on it, asks them to revise, references the exact claim. Don't be subtle about the callback — make it explicit.`)
    } else if (archetypeId === 'deferred-punchline') {
      // No hot take captured — fall back to a generic hour-out.
      lines.push('')
      lines.push(`No specific slot-1 hot take is on file for this hour. Treat as a standard Hour Out instead — clean wrap, reference the most memorable thing from this hour if you can find one, otherwise just close cleanly.`)
    }
  }
  return lines.join('\n')
}
