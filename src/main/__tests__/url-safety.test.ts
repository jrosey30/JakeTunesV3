import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPrivateOrLocalHostname,
  isAllowedCaptureUrl,
  isAllowedStreamripUrl,
  isAllowedBandcampNavUrl,
  allowWithinRateLimit,
} from '../url-safety.ts'

test('private / local hostnames are refused for SSRF', () => {
  for (const h of [
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    '10.0.0.1', '192.168.1.1', '172.16.5.5', '169.254.1.1',
    'homemini', 'workmini', 'router.local', 'svc.internal',
  ]) {
    assert.equal(isPrivateOrLocalHostname(h), true, h)
  }
  assert.equal(isPrivateOrLocalHostname('open.spotify.com'), false)
  assert.equal(isPrivateOrLocalHostname('qobuz.com'), false)
})

test('capture-resolve-link allowlist', () => {
  assert.equal(isAllowedCaptureUrl('https://open.spotify.com/track/abc'), true)
  assert.equal(isAllowedCaptureUrl('https://youtu.be/xyz'), true)
  assert.equal(isAllowedCaptureUrl('https://www.tiktok.com/@x/video/1'), true)
  assert.equal(isAllowedCaptureUrl('https://evil.example/og'), false)
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:3000/'), false)
  assert.equal(isAllowedCaptureUrl('http://homemini:3000/audio/1'), false)
  assert.equal(isAllowedCaptureUrl('file:///etc/passwd'), false)
})

test('streamrip download allowlist', () => {
  assert.equal(isAllowedStreamripUrl('https://open.qobuz.com/album/123'), true)
  assert.equal(isAllowedStreamripUrl('https://tidal.com/browse/track/1'), true)
  assert.equal(isAllowedStreamripUrl('https://www.deezer.com/track/1'), true)
  assert.equal(isAllowedStreamripUrl('https://www.youtube.com/watch?v=abc'), true)
  assert.equal(isAllowedStreamripUrl('https://soundcloud.com/x/y'), false)
  assert.equal(isAllowedStreamripUrl('http://192.168.0.1/rip'), false)
  assert.equal(isAllowedStreamripUrl('https://evil.example/track'), false)
})

test('bandcamp embedded nav allowlist', () => {
  assert.equal(isAllowedBandcampNavUrl('https://bandcamp.com'), true)
  assert.equal(isAllowedBandcampNavUrl('https://artist.bandcamp.com/album/foo'), true)
  assert.equal(isAllowedBandcampNavUrl('https://geo.captcha-delivery.com/captcha/?x=1'), true)
  assert.equal(isAllowedBandcampNavUrl('https://www.google.com/recaptcha/api2/anchor'), true)
  assert.equal(isAllowedBandcampNavUrl('https://evil.example/phish'), false)
  assert.equal(isAllowedBandcampNavUrl('file:///tmp/x'), false)
  assert.equal(isAllowedBandcampNavUrl('javascript:alert(1)'), false)
})

test('sliding-window rate limit', () => {
  const bucket = new Map<string, number[]>()
  const t0 = 1_000_000
  assert.equal(allowWithinRateLimit(bucket, 'tts', 2, 60_000, t0), true)
  assert.equal(allowWithinRateLimit(bucket, 'tts', 2, 60_000, t0 + 1), true)
  assert.equal(allowWithinRateLimit(bucket, 'tts', 2, 60_000, t0 + 2), false)
  assert.equal(allowWithinRateLimit(bucket, 'tts', 2, 60_000, t0 + 60_001), true)
})
