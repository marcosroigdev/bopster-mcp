import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { aliasSegment, isWalletHandle, ToolInputError } from '../src/tools/shared.js'

describe('isWalletHandle', () => {
  it('accepts valid 0x + 40 hex addresses', () => {
    assert.equal(isWalletHandle('0x65eb0e883a5b0d10620c1311db56cd2931f743eb'), true)
    assert.equal(isWalletHandle('0x0000000000000000000000000000000000000000'), true)
    assert.equal(isWalletHandle('  0x65EB0E883A5B0D10620C1311DB56CD2931F743EB  '), true)
  })

  it('rejects aliases and malformed addresses', () => {
    assert.equal(isWalletHandle('vhagar'), false)
    assert.equal(isWalletHandle('@gorilla'), false)
    assert.equal(isWalletHandle('0x123'), false) // too short
    assert.equal(isWalletHandle('65eb0e883a5b0d10620c1311db56cd2931f743eb'), false) // no 0x
    assert.equal(isWalletHandle('0xZZZ0e883a5b0d10620c1311db56cd2931f743eb'), false) // non-hex
  })
})

describe('aliasSegment', () => {
  it('escapes an alias for the URL path and drops a leading @', () => {
    assert.equal(aliasSegment('@gorilla'), 'gorilla')
    assert.equal(aliasSegment('a/b?c'), 'a%2Fb%3Fc')
  })

  it('refuses "." and "..", which would point at another path', () => {
    for (const handle of ['.', '..', '@..', '', '@']) assert.throws(() => aliasSegment(handle), ToolInputError)
  })
})
