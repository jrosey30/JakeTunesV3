/**
 * nameKey and the spacing modifier letters (2026-10-11).
 *
 * U+02B0–U+02FF are letters to Unicode (Lm) but apostrophes and primes in
 * practice. nameKey kept them, so "Donʼt" (U+02BC) never met "Don't", the
 * okina'd "Hawaiʻi" never met "Hawai'i", and the Ukrainian apostrophe split
 * one word two ways. They now separate words like any apostrophe.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nameKey, storedNameKey, hasOtherScript } from '../../common/fold-text.ts'

const SRC = join(import.meta.dirname, '../..')

describe('modifier apostrophes are apostrophes', () => {
  it('ʼ, ʻ, ʹ, ʾ, ʿ fold like the ASCII apostrophe', () => {
    assert.equal(nameKey('Donʼt Stop'), nameKey("Don't Stop"))
    assert.equal(nameKey('Donʼt Stop', ''), 'dontstop')
    assert.equal(nameKey('Hawaiʻi'), nameKey("Hawai'i"))
    assert.equal(nameKey('Saʿid'), nameKey("Sa'id"))
    assert.equal(nameKey('Qurʾan', ''), 'quran')
    assert.equal(nameKey('Obʹekt'), nameKey("Ob'ekt"))
  })
  it('the Ukrainian apostrophe (ʼ is the official one) no longer splits a word two ways', () => {
    assert.equal(nameKey('Обʼєднання'), nameKey("Об'єднання"))
    assert.equal(nameKey('Пʼятниця', ''), 'пятниця')
  })
  it("Japanese ー and 々 are Lm too, and stay: they are part of the word", () => {
    // (nameKey's output is NFD — ズ comes back as ス + dakuten — so compare in NFD)
    assert.equal(nameKey('ラーメンズ'), 'ラーメンズ'.normalize('NFD'))
    assert.equal(nameKey('佐々木'), '佐々木')
  })
  it('everything nameKey already did is unchanged', () => {
    assert.equal(nameKey('Björk'), 'bjork')
    assert.equal(nameKey('JAŸ-Z'), 'jay z')
    assert.equal(nameKey('MØ'), 'mo')
    assert.equal(nameKey('Sigur Rós', ''), 'sigurros')
    assert.equal(nameKey('ברי סחרוף'), 'ברי סחרוף')
    assert.equal(nameKey('Молчат Дома'), 'молчат дома')
    assert.equal(nameKey('!!!'), '')
  })
  it('a stored Latin key keeps its legacy bytes (a modifier apostrophe is not another script)', () => {
    const legacy = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    assert.equal(hasOtherScript('Donʼt'), false)
    assert.equal(storedNameKey('Donʼt', legacy), 'dont')
  })
})

describe('Rock DNA folds with nameKey — no third copy', () => {
  it('both of its keys are nameKey', () => {
    for (const f of ['common/rock-dna.ts', 'renderer/views/RockDnaView.tsx']) {
      const src = readFileSync(join(SRC, f), 'utf-8')
      assert.match(src, /const nk = \(s: string \| undefined\): string => nameKey\(s\)/, f)
      assert.doesNotMatch(src, /p\{L\}\\p\{M\}\\p\{N\}/, f)
    }
  })
})

describe('the Arabic tatweel is deleted, not a word break', () => {
  it('"عـربي" is "عربي" — a stretched word is the same word', () => {
    assert.equal(nameKey('عـربي'), nameKey('عربي'))
    assert.equal(nameKey('كــتــاب'), 'كتاب')
    assert.equal(nameKey('فيـروز', ''), nameKey('فيروز', ''))
    assert.equal(nameKey('ـ'), '')
  })
  it('Arabic itself is untouched, and still another script', () => {
    assert.equal(nameKey('فيروز'), 'فيروز')
    assert.equal(nameKey('أم كلثوم'), 'ام كلثوم', 'the hamza on alef folds away (harakat/hamza PR)')
    assert.equal(hasOtherScript('فيـروز'), true)
  })
})

describe('Arabic harakat and hamza fold away, like accents', () => {
  it('a name written with its vowel marks is the same name', () => {
    assert.equal(nameKey('مُحَمَّد'), nameKey('محمد'))
    assert.equal(nameKey('فَيْرُوز'), 'فيروز')
    assert.equal(nameKey('عَمْرو دِيَاب'), nameKey('عمرو دياب'))
  })
  it('أ إ آ ٱ are ا; ؤ is و; ئ is ي', () => {
    assert.equal(nameKey('أم كلثوم'), nameKey('ام كلثوم'))
    assert.equal(nameKey('إليسا'), 'اليسا')
    assert.equal(nameKey('آمال ماهر'), 'امال ماهر')
    assert.equal(nameKey('ٱلقمر'), 'القمر')
    assert.equal(nameKey('مؤمن'), 'مومن')
    assert.equal(nameKey('هيئة'), 'هيية')
  })
  it('Arabic is still its own script, and nothing else moves', () => {
    assert.equal(hasOtherScript('مُحَمَّد'), true)
    assert.equal(nameKey('Beyoncé'), 'beyonce')
    assert.equal(nameKey('ברי סחרוף'), 'ברי סחרוף')
    assert.equal(nameKey('Молчат Дома'), 'молчат дома')
    assert.equal(nameKey('عـربي'), nameKey('عربي'), 'tatweel still goes')
  })
})
