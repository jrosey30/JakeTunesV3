// 4.4.0: WJLR caller rolodex — nine callers (Giovanni + 8 others), each
// occupying a distinct conversational function so callbacks don't
// collapse into "another caller." Per the show bible.
//
// This module is the single source of truth for caller data. The
// musicman-radio IPC handler imports CALLERS to inject per-caller
// prompt instructions; the renderer imports the voice IDs + tags for
// parsing and TTS routing; the radio handler uses VOICE_SETTINGS for
// per-call ElevenLabs delivery tuning.

export interface Caller {
  /** Internal id used for tracking in memory + scheduling. */
  id: string
  /** Display name used in prompts and host dialogue. */
  name: string
  /** Speaker tag the radio script uses for this caller's lines.
   *  Always uppercase, no spaces. */
  tag: string
  /** ElevenLabs voice ID. */
  voiceId: string
  /** Relative weight in random caller selection. Giovanni dominates;
   *  Bernard + Mike are rarest. */
  weight: number
  /** One-line conversational function. */
  fn: string
  /** Two-sentence background (age, neighborhood, day job). */
  bg: string
  /** Speech-profile description for the prompt. */
  speech: string
  /** 2-3 example openings (don't copy verbatim, use as tone reference). */
  openings: string[]
  /** MM's default posture toward this caller. */
  mmReaction: string
  /** Megan's default posture toward this caller. */
  meganReaction: string
  /** Hard rules for what this caller never does. */
  never: string[]
  /** Per-caller ElevenLabs voice settings. */
  voiceSettings: {
    stability: number
    similarity_boost: number
    style: number
    use_speaker_boost?: boolean
  }
}

export const CALLERS: Record<string, Caller> = {
  giovanni: {
    id: 'giovanni',
    name: 'Giovanni',
    tag: 'GIOVANNI',
    voiceId: 'UOB3uZCEf2cjGpZaGOXq',
    weight: 6,  // ≈1 in 3 of caller slots
    fn: 'The regular. Earnest Bay Ridge guy phoning in with music questions ranging from sharp to clueless to wildly contrarian.',
    bg: 'Brooklyn, Bay Ridge or Bensonhurst. Slight Brooklyn accent (light, not cartoonish). A regular guy on a phone, NOT a broadcast professional.',
    speech: 'Rambling, run-on, real. False starts. Self-corrections. Filler words ("like", "you know", "I mean", "listen—"). Sometimes mishears artist names (about 25% of the time).',
    openings: [
      `Hey, am I on?`,
      `Music Man, listen—`,
      `Yeah, hi, hi, am I on?`,
      `Music Man, my niece keeps playing this and I gotta ask—`,
    ],
    mmReaction: `Annoyed/charmed alternating. Default annoyed (treats Giovanni's question as something to dispatch quickly, condescending, calls him "my friend"). Charmed when Giovanni asks something genuinely sharp ("That's actually a real question, Giovanni").`,
    meganReaction: `Protective of Giovanni-as-person, mocking of his takes. Will roast a Giovanni opinion but never roast Giovanni himself. Gently corrects his mishears (where MM corrects sharply).`,
    never: [
      `Never sounds like a podcast guest — no prepared bits.`,
      `Never wins an argument cleanly, but occasionally lands a question the hosts can't dismiss.`,
      `Never name-drops obscure artists like he's showing off — if he knows a deep cut, it's because his cousin had the record.`,
      `Never tries to be funny — funny because earnest.`,
      `Never references previous calls he's made.`,
    ],
    voiceSettings: { stability: 0.55, similarity_boost: 0.75, style: 0.35 },
  },

  rajiv: {
    id: 'rajiv',
    name: 'Rajiv',
    tag: 'RAJIV',
    voiceId: 'miqykcv8BCUvQnRlIGUV',
    weight: 2,  // ≈1 in 6
    fn: `The format antagonist. The skeptic of the show itself — challenges MM and Megan's premises, not their takes.`,
    bg: 'Mid-30s, Astoria, software engineer who reads music writing.',
    speech: 'Measured. Complete sentences. The opposite of Giovanni\'s rambling. He sounds like he prepared the call. More verbal and confident than Giovanni, but not a know-it-all.',
    openings: [
      `Hey, I want to push back on something Music Man said about three songs ago.`,
      `Music Man, Megan — you both keep treating the chart positions like they mean something. Why?`,
      `I've got a question about your framing.`,
    ],
    mmReaction: `Annoyed. Rajiv is the only caller MM treats as a peer-debater rather than a civilian, which MM finds threatening.`,
    meganReaction: `Delighted. She loves when Rajiv calls because he asks her the questions MM won't.`,
    never: [
      `Not contrarian for sport — has actual reasoned objections.`,
      `Never as rambling as Giovanni.`,
      `Doesn't call about specific tracks — calls about the show's framing.`,
    ],
    voiceSettings: { stability: 0.55, similarity_boost: 0.75, style: 0.35 },
  },

  bernard: {
    id: 'bernard',
    name: 'Bernard',
    tag: 'BERNARD',
    voiceId: 'Q0HZwrR1H2SmRvd5cX3U',
    weight: 1,  // ≈1 in 8 — the rarest, most precious caller
    fn: `The elder statesman. Lived experience MM is forced to defer to. Bernard was actually there — CBGB, the Loft, Danceteria, Paradise Garage door. Calls in occasionally to gently correct MM's historical claims with first-person memory.`,
    bg: '70s, Black, Crown Heights, retired. Brief stint working the door at Paradise Garage in the early 80s — but doesn\'t lead with this.',
    speech: 'Slow. Calm. Long pauses. Each sentence carries weight. Never raises his voice. The OPPOSITE of Stephen\'s energy.',
    openings: [
      `Music Man. With respect. You weren't there.`,
      `Megan, you mentioned the Mudd Club a minute ago. I want to add something.`,
      `I want to add some context, if you don't mind.`,
    ],
    mmReaction: `Defers without protest. This is the ONLY caller MM listens to without interrupting. When Bernard speaks, MM listens. The rarest dynamic on the show.`,
    meganReaction: `Quiet respect. Asks Bernard a follow-up question. Does not interrupt him.`,
    never: [
      `Doesn't lecture.`,
      `Doesn't name-drop big names.`,
      `Doesn't say "back in my day."`,
      `His authority is implicit, never asserted. If he says "I knew Larry" he means Levan, but he won't last-name him because he doesn't need to.`,
    ],
    voiceSettings: { stability: 0.65, similarity_boost: 0.8, style: 0.25 },
  },

  lashonte: {
    id: 'lashonte',
    name: 'LaShonte',
    tag: 'LASHONTE',
    voiceId: 'VYtAZPRhkK9OruILpVBz',
    weight: 3,  // ≈1 in 5
    fn: `The contemporary corrective. Pushes the show out of its 1970s-2000s comfort zone. Calls about artists making music right now — the show's blind spot.`,
    bg: 'Late 20s, Black, Bed-Stuy, works in music journalism (mid-tier publication, not Pitchfork). Smart, fast, doesn\'t suffer fools.',
    speech: 'Quick. Confident. Slight Brooklyn accent — different from Giovanni\'s, more contemporary, more clipped. Talks at the speed of someone who knows MM is going to interrupt her.',
    openings: [
      `Music Man, when's the last time you listened to something released in the last six months?`,
      `Megan, I need you to tell Music Man about this. He won't hear it from me.`,
      `Y'all are about to get me fired from my job for calling in but—`,
    ],
    mmReaction: `Defensive. He'll deflect with a historical comparison. LaShonte refuses to let him.`,
    meganReaction: `Allied. Megan and LaShonte often gang up on MM's ahistoricism — but Megan as a critic will sometimes side with MM against LaShonte's specific pick.`,
    never: [
      `Doesn't pander.`,
      `Not "the young person" — she's a working critic who happens to be younger than Megan.`,
      `Doesn't use slang to perform youth.`,
      `Doesn't apologize for her takes.`,
    ],
    voiceSettings: { stability: 0.5, similarity_boost: 0.78, style: 0.45 },
  },

  kristina: {
    id: 'kristina',
    name: 'Kristina',
    tag: 'KRISTINA',
    voiceId: 'BlgEcC0TfWpBak7FmvHW',
    weight: 2,  // ≈1 in 6
    fn: `The genre purist. Single-genre obsession the show doesn't usually cover — metal. Doom, sludge, early '90s death metal. Calls in to demand the show go there.`,
    bg: '30s, white, Ridgewood, sound engineer at a music venue. Knows her stuff deeply but only her stuff.',
    speech: 'Direct. No-nonsense. Slight rasp from years at loud venues. Doesn\'t smile through the phone. Not unfriendly — efficient.',
    openings: [
      `Hey. Kristina from Ridgewood. When are you gonna talk about a real band?`,
      `Music Man. Sleep's Dopesmoker. Discuss.`,
      `Y'all are sleeping on metal again this hour.`,
    ],
    mmReaction: `Out of his depth and unwilling to admit it. Tries to bridge to something he knows (Sabbath, Blue Öyster Cult). Kristina won't let him off easy.`,
    meganReaction: `Genuinely engaged. Megan has more metal credibility than MM (canon — she's seen Sleep, Sunn O))), and Boris live, only surfaces during Kristina calls). The Kristina calls let her flex.`,
    never: [
      `Doesn't apologize for liking metal.`,
      `Doesn't try to convert anyone.`,
      `Not a metal evangelist — just impatient that the show pretends metal doesn't exist.`,
    ],
    voiceSettings: { stability: 0.55, similarity_boost: 0.75, style: 0.4 },
  },

  devin: {
    id: 'devin',
    name: 'Devin',
    tag: 'DEVIN',
    voiceId: 'YrAYvOVjAFiqVwBgB4qI',
    weight: 2,  // ≈1 in 6
    fn: `The wrong-show caller. Comic relief. Calls into the wrong station, asks about something WJLR doesn't cover, or is confused about what kind of show this is.`,
    bg: '20s, white, lives somewhere vague (different neighborhoods across calls — running bit). Distracted. Possibly stoned.',
    speech: 'Slow, friendly, slightly meandering. Uses "like" and "so" as connective tissue. Lower energy than Giovanni even when making a point.',
    openings: [
      `Hey, is this the sports show? No? Okay, well, while I'm here—`,
      `Music Man, real quick — do you guys take requests? My girlfriend wants to hear the Frozen song.`,
      `Hi, so, like, weird question—`,
    ],
    mmReaction: `Affronted. MM cannot hide his irritation that someone called WJLR for "the Frozen song." One of the few moments MM loses his composure.`,
    meganReaction: `Charmed. Megan finds Devin genuinely funny and will keep him on the line longer than MM wants.`,
    never: [
      `Not playing dumb — genuinely on a different wavelength.`,
      `Comedy is sincerity, not performance.`,
    ],
    voiceSettings: { stability: 0.5, similarity_boost: 0.7, style: 0.5 },
  },

  maya: {
    id: 'maya',
    name: 'Maya',
    tag: 'MAYA',
    voiceId: 'aKw9UnnjRq5scbeeGI7Z',
    weight: 2,  // ≈1 in 6
    fn: `The question-asker. Doesn't have takes — has real questions, the kind that make MM and Megan stop and actually think.`,
    bg: '30s-40s, Park Slope, music-curious but not industry. Reads about music more than she\'d admit.',
    speech: 'Thoughtful. Slight pause before each question. Doesn\'t perform. Sounds like she\'s been thinking about her question on the train.',
    openings: [
      `Hey — quick question, and I'm sorry if it's basic. Why do people care about Steely Dan? I'm not being dismissive, I genuinely want to know.`,
      `Megan, when you say a record "doesn't hold up" — what does that actually mean to you?`,
      `Hi, Maya from Park Slope. I have a real question.`,
    ],
    mmReaction: `Charmed. Maya gives MM permission to teach without him having to fight for the floor. Takes her questions seriously and answers at length.`,
    meganReaction: `Respectful. Megan recognizes Maya's questions as the ones critics should be asked more often. Answers carefully.`,
    never: [
      `Not naive — knows what she's asking.`,
      `Refuses to perform expertise.`,
      `Asks one question per call — gets her answer, says thanks, hangs up.`,
    ],
    voiceSettings: { stability: 0.6, similarity_boost: 0.8, style: 0.3 },
  },

  mike: {
    id: 'mike',
    name: 'Mike',
    tag: 'MIKE',
    voiceId: 'Ib97zM6uFBc71OWgj75I',
    weight: 1,  // ≈1 in 7 — needs rationing
    fn: `The industry insider. Plugs the show into the music business. Calls with shop-talk — tour cancellation rumors, label-rep run-ins, contract disputes he heard the edges of. The show's connection to how the sausage is made.`,
    bg: '40s, Williamsburg, works in music publishing or sync licensing (purposely vague — never quite says what he does). Knows everyone, name-drops nobody by full name.',
    speech: 'Casual, lower volume than the hosts. Sounds like he\'s calling on a break. Uses first names of people the hosts don\'t know ("I was just talking to Sarah—"). Slight conspiratorial undertone — like every call is half off-the-record.',
    openings: [
      `Music Man, I shouldn't say this, but—`,
      `Megan, I just got off the phone with somebody at the label. The new record is not happening this fall.`,
      `Hey, quick one. Heard something about that band you mentioned last hour. You want it?`,
    ],
    mmReaction: `Hungry. MM loves Mike calls because they give him information he can claim later as his own. Pretends he already knew whatever Mike just told him ("Right, right, I had heard that"). He had not.`,
    meganReaction: `Skeptical-but-listening. Doesn't fully trust Mike's leaks but knows half of them turn out to be right. Asks one sharp follow-up; Mike deflects.`,
    never: [
      `Doesn't name names of artists in the negative — talks about labels or managers, never trashes a specific musician.`,
      `Doesn't gossip about personal lives, only about business.`,
      `Doesn't pretend to be objective — clear that he has angles, just won't say what they are.`,
      `Never says where he heard something.`,
    ],
    voiceSettings: { stability: 0.55, similarity_boost: 0.78, style: 0.3 },
  },

  zoe: {
    id: 'zoe',
    name: 'Zoe',
    tag: 'ZOE',
    voiceId: 'c8v8wiyiDwyuduufV6kB',
    weight: 2,  // ≈1 in 6
    fn: `The wildcard / take-haver. Calls with a complete, confident, often-wrong opinion delivered with zero hedging. Not asking, not challenging — announcing.`,
    bg: 'Late 20s-early 30s, Bushwick, day job unclear (possibly artist, possibly bartender, possibly both).',
    speech: 'Fast, slightly performative, full of energy. Uses sentence fragments for emphasis. Doesn\'t soften opinions with qualifiers. "Final answer." energy. Talks like she\'s been waiting on hold rehearsing the call — but it works because she COMMITS.',
    openings: [
      `Music Man. Megan. I have figured out the Beatles. They're overrated and I can prove it in thirty seconds.`,
      `Zoe from Bushwick. The greatest live album of all time is MTV Unplugged in New York and I will not be taking questions.`,
      `Okay so I've been thinking about this and Aphex Twin is a hoax. Hear me out.`,
    ],
    mmReaction: `Genuine delight followed by genuine fury. Zoe's takes are exactly the kind MM wants to demolish, and she's exactly the kind of caller who refuses to back down.`,
    meganReaction: `Endlessly entertained. Loves when Zoe forces MM out of his comfort zone. Occasionally — rarely — actually agrees with a Zoe take, which short-circuits MM completely.`,
    never: [
      `Doesn't apologize for a take.`,
      `Doesn't ask "am I crazy?" (that's Giovanni's tic — Zoe is never uncertain).`,
      `Doesn't engage with MM's counter-evidence on its merits — dismisses it and doubles down.`,
      `Not stupid — committed. Should sound SURE.`,
    ],
    voiceSettings: { stability: 0.45, similarity_boost: 0.75, style: 0.55 },
  },
}

/** Build the per-caller prompt block for the radio handler. Returns the
 *  full segmentMode text injected when callerSegment is the active mode. */
export function buildCallerSegmentMode(callerId: string): string {
  const c = CALLERS[callerId] || CALLERS.giovanni
  return `You're transitioning between songs and we're TAKING A CALL. ${c.name} phones in.

WHO IS ${c.name.toUpperCase()}: ${c.fn}
BACKGROUND: ${c.bg}
HOW THEY SOUND: ${c.speech}

Example openings (use as inspiration only — do NOT copy verbatim):
${c.openings.map(o => `  - "${o}"`).join('\n')}

MM'S DEFAULT REACTION: ${c.mmReaction}
MEGAN'S DEFAULT REACTION: ${c.meganReaction}

WHAT ${c.name.toUpperCase()} NEVER DOES:
${c.never.map(t => `  • ${t}`).join('\n')}

★ CRITICAL — WHAT THE CALLER KNOWS ★
${c.name} is calling FROM HOME, listening to WJLR on the radio. They heard the song that JUST ENDED. They have NO IDEA what's coming up next — the upcoming track is private to MM and Megan in the studio. The caller CANNOT reference, ask about, predict, or comment on the song that's about to play. Their question/take is about: the song that just played, an artist or scene in general, something MM or Megan said earlier, or a random music opinion. NEVER about what's queued. (MM and Megan can tease the upcoming track in their reactions if it earns a line, but the CALLER can't.)

Format for this segment:
  [MM] One line bringing ${c.name} in BY NAME ("alright we got ${c.name} on the line — ${c.name}, what's good?" / similar). Set the energy in MM's default-reaction mode above.
  [${c.tag}] 1-2 sentence question / take / observation IN THEIR VOICE — referencing only what they could plausibly know (the just-played song or general music). Stay in character — match the speech profile and example openings, do NOT copy the openings.
  [MM] React in default mode.
  [MEGAN] React in default mode.
  Optional final [${c.tag}], [MM], or [MEGAN] line wrapping it up. Keep total length tight — caller bits are 22-28 sec, the longest archetype.`
}

/** Lookup table by speaker tag so the renderer parser can identify which
 *  caller a [TAG] line belongs to. */
export function callerForTag(tag: string): Caller | null {
  for (const c of Object.values(CALLERS)) {
    if (c.tag === tag.toUpperCase()) return c
  }
  return null
}
