import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  UPSTREAM_NOT_CONFIGURED,
  clientUrl,
  httpBaseFromServerUrl,
  isPlainUpstreamHostAllowed,
  normalizeUpstreamUrl,
} from '../../src/shared/upstream.ts'

// A qqpet-server address is one value the client derives everything else from: the paired
// sync URL (wss://host/v1/sync) or the address typed into the settings. Both must land on the
// same trailing-slash-free http(s) origin, and anything unusable must fail loudly instead of
// quietly asking a third party.

const PAIRED = [
  ['wss://pet.example.com/v1/sync', 'https://pet.example.com'],
  ['wss://pet.example.com/sync', 'https://pet.example.com'],
  ['wss://pet.example.com/v1/sync/', 'https://pet.example.com'],
  ['wss://pet.example.com', 'https://pet.example.com'],
  ['wss://pet.example.com:443/v1/sync', 'https://pet.example.com'],
  ['WSS://Pet.Example.COM/V1/Sync', 'https://pet.example.com'],
  ['ws://127.0.0.1:8787/v1/sync', 'http://127.0.0.1:8787'],
  ['ws://localhost:8787/sync', 'http://localhost:8787'],
  ['ws://192.168.1.20:8787/v1/sync', 'http://192.168.1.20:8787'],
  ['ws://10.1.2.3/v1/sync', 'http://10.1.2.3'],
  ['ws://100.101.102.103:8787/v1/sync', 'http://100.101.102.103:8787'],
  ['ws://[fd7a:115c:a1e0::1]:8787/v1/sync', 'http://[fd7a:115c:a1e0::1]:8787'],
  ['https://pet.example.com', 'https://pet.example.com'],
  ['https://pet.example.com/', 'https://pet.example.com'],
  ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
]

test('a paired sync address becomes its http(s) origin', () => {
  for (const [input, expected] of PAIRED) {
    assert.equal(httpBaseFromServerUrl(input), expected, input)
    assert.equal(normalizeUpstreamUrl(input), expected, input)
  }
})

test('plaintext to a public host is refused; loopback and private literals keep http', () => {
  assert.equal(normalizeUpstreamUrl('http://pet.example.com'), null)
  assert.equal(normalizeUpstreamUrl('ws://pet.example.com/v1/sync'), null)
  assert.equal(httpBaseFromServerUrl('http://pet.example.com'), null)
  assert.equal(normalizeUpstreamUrl('http://app.localhost:8787'), 'http://app.localhost:8787')

  for (const host of ['localhost', '127.0.0.1', '127.5.6.7', '[::1]']) {
    assert.equal(isPlainUpstreamHostAllowed(host), true, host)
  }
  for (const host of ['10.0.0.5', '172.16.3.9', '172.31.0.1', '192.168.0.10', '169.254.1.1', '100.101.102.103', '[fd7a:115c:a1e0::1]', '[fe80::1]']) {
    assert.equal(isPlainUpstreamHostAllowed(host), true, host)
  }
  assert.equal(isPlainUpstreamHostAllowed('pet.example.com'), false)
  assert.equal(isPlainUpstreamHostAllowed('172.32.0.1'), false)
  assert.equal(isPlainUpstreamHostAllowed('8.8.8.8'), false)
  assert.equal(isPlainUpstreamHostAllowed('[2001:db8::1]'), false)

  // Secure schemes reach any host, public ones included.
  assert.equal(normalizeUpstreamUrl('https://8.8.8.8'), 'https://8.8.8.8')
  assert.equal(normalizeUpstreamUrl('wss://8.8.8.8/v1/sync'), 'https://8.8.8.8')
})

test('unusable addresses are refused rather than guessed at', () => {
  for (const input of [
    '', '   ', 'pet.example.com', 'ftp://pet.example.com', 'javascript:alert(1)',
    'https://pet.example.com/other', 'https://pet.example.com/v2/sync', 'https://pet.example.com/v1/sync/x',
    'https://pet.example.com?token=1', 'https://pet.example.com#x',
    'https://user:pass@pet.example.com', 'wss://', 'http://',
  ]) {
    assert.equal(httpBaseFromServerUrl(input), null, String(input))
    assert.equal(normalizeUpstreamUrl(input), null, String(input))
  }
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(httpBaseFromServerUrl(value), null, String(value))
    assert.equal(normalizeUpstreamUrl(value), null, String(value))
  }
})

test('clientUrl joins one GET path under the base', () => {
  assert.equal(UPSTREAM_NOT_CONFIGURED, 'upstream_not_configured')
  assert.equal(clientUrl('https://pet.example.com', '/v1/client/release'), 'https://pet.example.com/v1/client/release')
  assert.equal(clientUrl('https://pet.example.com/', '/v1/client/release'), 'https://pet.example.com/v1/client/release')
  assert.equal(clientUrl('https://pet.example.com', 'v1/client/release'), 'https://pet.example.com/v1/client/release')
  assert.equal(clientUrl('wss://pet.example.com/v1/sync', '/v1/client/release'), 'https://pet.example.com/v1/client/release')
  assert.equal(clientUrl('https://pet.example.com', ''), 'https://pet.example.com')
  const query = '/v1/client/weather?city=' + encodeURIComponent('北京')
  assert.equal(clientUrl('https://pet.example.com', query), 'https://pet.example.com' + query)
  assert.equal(
    clientUrl('https://pet.example.com', '/v1/client/calendar?from=2026-11-19&days=31'),
    'https://pet.example.com/v1/client/calendar?from=2026-11-19&days=31',
  )
})

test('clientUrl refuses a missing upstream and a path that could smuggle headers', () => {
  for (const base of ['', null, undefined, 'pet.example.com', 'http://pet.example.com']) {
    assert.throws(() => clientUrl(base, '/v1/client/release'), (error) => {
      assert.equal(error instanceof Error, true)
      assert.equal(error.message, UPSTREAM_NOT_CONFIGURED)
      return true
    })
  }
  assert.throws(() => clientUrl('https://pet.example.com', '/v1/client/release\r\nHost: evil'), TypeError)
  assert.throws(() => clientUrl('https://pet.example.com', 42), TypeError)
})

test('the module stays free of Node/Electron imports', () => {
  const source = readFileSync(new URL('../../src/shared/upstream.ts', import.meta.url), 'utf8')
  assert.equal(/from\s+'node:/.test(source), false)
  assert.equal(/from\s+'electron'/.test(source), false)
})
