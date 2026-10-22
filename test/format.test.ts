import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { formatTokenAmount, unixToIsoUtc } from '../src/format.js'

describe('formatTokenAmount', () => {
  it('formats USDC base units (6 decimals)', () => {
    assert.equal(formatTokenAmount('25000000'), '25 USDC')
    assert.equal(formatTokenAmount('1500000'), '1.5 USDC')
    assert.equal(formatTokenAmount('1'), '0.000001 USDC')
    assert.equal(formatTokenAmount('0'), '0 USDC')
  })

  it('handles bigint and negatives', () => {
    assert.equal(formatTokenAmount(2500000n), '2.5 USDC')
    assert.equal(formatTokenAmount('-1500000'), '-1.5 USDC')
  })

  it('supports custom decimals and symbol', () => {
    assert.equal(formatTokenAmount('1000000000000000000', 18, 'ETH'), '1 ETH')
  })

  it('returns null for empty / non-numeric / unsafe number input', () => {
    assert.equal(formatTokenAmount(null), null)
    assert.equal(formatTokenAmount(undefined), null)
    assert.equal(formatTokenAmount(''), null)
    assert.equal(formatTokenAmount('not-a-number'), null)
    assert.equal(formatTokenAmount(9007199254740993), null) // > Number.MAX_SAFE_INTEGER
  })
})

describe('unixToIsoUtc', () => {
  it('converts valid unix seconds to ISO UTC', () => {
    assert.equal(unixToIsoUtc(1785081600), '2026-07-26T16:00:00.000Z')
    assert.equal(unixToIsoUtc('1785081600'), '2026-07-26T16:00:00.000Z')
  })

  it('returns null for invalid / non-positive / out-of-range input', () => {
    assert.equal(unixToIsoUtc(null), null)
    assert.equal(unixToIsoUtc(0), null)
    assert.equal(unixToIsoUtc(-1), null)
    assert.equal(unixToIsoUtc('nope'), null)
    assert.equal(unixToIsoUtc(99999999999999), null) // overflows JS Date range → must not throw
  })
})
