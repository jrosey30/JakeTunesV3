/**
 * The Claude models JakeTunes calls — one place (2026-10-10, Jake: "upgrade
 * the models"). Every call site names MODEL_SMART or MODEL_FAST; the next
 * upgrade is a one-line change here.
 *
 * ⚠️ TWIN: JakeTunesMobile backend (homemini) carries its own copy of these
 * names and the same policy — keep the two in step.
 *
 * Not here on purpose: the OpenAI embedding model (changing it re-embeds the
 * whole library) and homemini's local Gemma.
 */

/** Music Man, picks, mixes, shop shelves, Cynthia's reasoning. */
export const MODEL_SMART = 'claude-sonnet-5-5'
/** Short, cheap jobs: blurbs, quick takes, the playlist-name hint. */
export const MODEL_FAST = 'claude-haiku-5-5'

/**
 * The 5.x models think before answering by default. Every call in this app
 * was written for models that answer straight away: replies are read from
 * content[0], and short budgets (a DJ quip is max_tokens 300) can be spent
 * entirely on thinking, leaving no text. Measured 2026-10-10: Sonnet 5.5 at
 * max_tokens 60 returned [thinking] only; with thinking off it returned
 * [text] in 1.5 s instead of 4 s. Each model spells "off" differently:
 * Sonnet 5.5 rejects {type:'disabled'} and asks for 'between_tools'; Haiku
 * 5.5 rejects 'between_tools' and takes 'disabled'.
 */
const THINKING_OFF: Readonly<Record<string, { type: string }>> = {
  'claude-sonnet-5-5': { type: 'between_tools' },
  'claude-haiku-5-5': { type: 'disabled' },
}

/** These reject `temperature` outright (400 "deprecated for this model"). */
const NO_TEMPERATURE: ReadonlySet<string> = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5'])

/** Every model this file knows how to call safely. */
export const KNOWN_MODELS: readonly string[] = [MODEL_SMART, MODEL_FAST]

/**
 * Make a request safe for the model it names: drop `temperature` where the
 * model refuses it, and turn thinking off unless the caller chose a thinking
 * setting itself. Models not listed (an older one left on purpose) pass
 * through untouched.
 */
export function withModelPolicy<P extends { model: string }>(params: P): P {
  const out = { ...params } as P & { temperature?: unknown; thinking?: unknown }
  if (NO_TEMPERATURE.has(out.model)) delete out.temperature
  const off = THINKING_OFF[out.model]
  if (off && out.thinking === undefined) out.thinking = off
  return out
}
