import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { clearLoginLimits, clientKey, LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE, takeLoginMessage } from '../src/tools/loginLimit.js'

describe('takeLoginMessage', () => {
  beforeEach(() => clearLoginLimits())

  // A login can pin metadata to IPFS with no transaction behind it, and wallets are free: one
  // caller must not be able to use up the backend's limit for every agent behind this server.
  it(`allows ${LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE} a minute per client, then says how long to wait`, () => {
    const now = 1_000_000
    for (let i = 0; i < LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE; i++) {
      assert.deepEqual(takeLoginMessage('203.0.113.7', now + i), { allowed: true })
    }

    assert.deepEqual(takeLoginMessage('203.0.113.7', now + 20_000), { allowed: false, retryAfterSeconds: 40 })
  })

  it('counts each client on its own', () => {
    const now = 1_000_000
    for (let i = 0; i < LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE; i++) takeLoginMessage('203.0.113.7', now)

    assert.deepEqual(takeLoginMessage('198.51.100.9', now), { allowed: true })
  })

  it('lets a client in again once its minute is over', () => {
    const now = 1_000_000
    for (let i = 0; i <= LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE; i++) takeLoginMessage('203.0.113.7', now)

    assert.deepEqual(takeLoginMessage('203.0.113.7', now + 60_000), { allowed: true })
  })
})

describe('clientKey', () => {
  it("takes Cloudflare's CF-Connecting-IP over the X-Real-IP nginx sets", () => {
    assert.equal(clientKey({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '172.68.1.1' }), '203.0.113.7')
  })

  it('falls back to X-Real-IP, the first entry of a list, and the first of repeated headers', () => {
    assert.equal(clientKey({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7')
    assert.equal(clientKey({ 'cf-connecting-ip': ' 203.0.113.7, 10.0.0.1' }), '203.0.113.7')
    assert.equal(clientKey({ 'x-real-ip': ['203.0.113.7', '10.0.0.1'] }), '203.0.113.7')
  })

  it('is one key for every caller it cannot tell apart, and one for stdio', () => {
    assert.equal(clientKey({ host: 'mcp.bopster.fun' }), 'unknown')
    assert.equal(clientKey(undefined), 'local')
  })
})
