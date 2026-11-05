// A voice's stage directions never reach a screen. Takes as the desktop saved them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cleanAiProse } from '../../common/clean-ai-prose.ts'
import { isStageDirection, stripStageDirections } from '../../common/stage-directions.ts'
import { forTheScreen } from '../claude-screen-text.ts'

const takes: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/stage-direction-takes.json', import.meta.url), 'utf8'))

test('the five real takes come out clean, every other word intact', () => {
  assert.equal(Object.keys(takes).length, 5)
  for (const [key, take] of Object.entries(takes)) {
    const clean = stripStageDirections(take)
    assert.doesNotMatch(clean, /\[/, key)
    assert.doesNotMatch(clean, / {2}/, key)
    assert.equal(clean.split(/\s+/).length, take.split(/\s+/).length - 1, key)
  }
  const ants = stripStageDirections(takes['black country, new road|ants from up there|2022']!)
  assert.match(ants, /softer and more devastating\. It's the record where/)
})

test('every tag in the persona, wherever it sits, leaves tidy text', () => {
  for (const tag of ['scoff', 'scoffs', 'laughs', 'chuckles', 'sighs', 'exhales', 'whispers', 'excited', 'sarcastic', 'interrupts', 'curious', 'mischievously', 'softer']) {
    assert.equal(isStageDirection(tag), true, tag)
    assert.equal(stripStageDirections(`[${tag}] Yeah, sure, masterpiece.`), 'Yeah, sure, masterpiece.', tag)
  }
  assert.equal(stripStageDirections('Listen — [sighs] — fine. The bridge works.'), 'Listen — fine. The bridge works.')
  assert.equal(stripStageDirections("It's — [softer] — fine."), "It's — fine.")
  assert.equal(stripStageDirections('[sighs] — fine.'), 'Fine.')
  assert.equal(stripStageDirections('Yeah, [scoff] sure.'), 'Yeah, sure.')
  assert.equal(stripStageDirections('It works [sighs].'), 'It works.')
  assert.equal(stripStageDirections('[Laughs] Sure.'), 'Sure.')
  assert.equal(stripStageDirections('One.\n\n[softer] Two.'), 'One.\n\nTwo.')
  assert.equal(stripStageDirections('[leans against counter] Thirty plays is respect.'), 'Thirty plays is respect.')
  assert.equal(stripStageDirections('[scoff] yeah, sure.'), 'Yeah, sure.')
  assert.equal(stripStageDirections('{"note":"[scoff] Fine, two Strokes tracks."}'), '{"note":"Fine, two Strokes tracks."}')
  assert.equal(stripStageDirections('He said "fine [sighs]" and left.'), 'He said "fine" and left.')
  assert.equal(stripStageDirections('One.  Two. [laughs] Three.'), 'One.  Two. Three.')
})

test('real text in brackets survives, untouched', () => {
  for (const text of [
    'Nutshell [Live] is the one.',
    '"Nutshell" [live] is the one.',
    '"Song" [remastered] holds up.',
    'He said it was the [sic] best.',
    'They called [the band] a fluke.',
    'Radio version [radio edit] exists.',
    '[Interlude] is short.',
    'Track [12] closes it.',
    '{"tags":[null],"ids":[1,2],"names":["a","b"]}',
    'Lowercase [from gtavi] stays.',
  ]) assert.equal(stripStageDirections(text), text, text)
})

test('text with nothing to strip comes back the same, spacing and all', () => {
  const text = 'Two  spaces stay.  So  does  this.\n\nAnd lowercase starts.'
  assert.equal(stripStageDirections(text), text)
  assert.equal(stripStageDirections('lowercase start.'), 'lowercase start.')
})

test('saved words read clean, and a title heading goes even with an apostrophe', () => {
  assert.equal(cleanAiProse('# Can\'t Buy A Thrill\nThe hooks are bait. [softer] Still.', "Can't Buy A Thrill"), 'The hooks are bait. Still.')
  assert.equal(cleanAiProse('**Bold** words.\n\n[sighs] Fine.'), 'Bold words.\n\nFine.')
})

test('every reply that is not for a voice comes back clean; the voice keeps its tags', () => {
  const reply = { id: 'x', content: [{ type: 'text', text: '{"note":"[scoff] Fine, two Strokes tracks."}' }, { type: 'tool_use', name: 'n' }] }
  const read = forTheScreen('listen-list:suggest:1', reply)
  assert.equal(read.content[0]!.text, '{"note":"Fine, two Strokes tracks."}')
  assert.equal(read.id, 'x')
  assert.deepEqual(read.content[1], { type: 'tool_use', name: 'n' })
  assert.equal(reply.content[0]!.text, '{"note":"[scoff] Fine, two Strokes tracks."}', 'the cached reply is untouched')
  for (const key of ['musicman-radio', 'musicman-dj', 'musicman-chat', 'musicman-dj-set', 'musicman-radio-plan']) {
    assert.equal(forTheScreen(key, reply).content[0]!.text, reply.content[0]!.text, key)
  }
  for (const key of ['rediscovery', 'mixtape-build', 'album-take', 'discover-scene-pitch', 'musicman-picks']) {
    assert.doesNotMatch(forTheScreen(key, reply).content[0]!.text!, /\[/, key)
  }
  // JSON survives.
  const json = '{"tags":[],"ids":[1,2],"names":["a","b"],"x":[null]}'
  assert.equal(forTheScreen('rediscovery', { content: [{ type: 'text', text: json }] }).content[0]!.text, json)
})
