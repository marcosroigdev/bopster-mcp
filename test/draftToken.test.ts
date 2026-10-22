import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isSignedDraft, signDraft, type SignedDraft } from '../src/tools/draftToken.js'

const draft: SignedDraft = {
  wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  metadataUri: 'ipfs://bafy',
  question: 'Will BTC be above $90000 at 2026-10-12 18:30 UTC?',
  endTime: 1_791_000_000n,
  resolveTime: 1_791_001_800n,
}

describe('draft tokens', () => {
  it('accept the draft they were made for, whatever the wallet casing', () => {
    const token = signDraft(draft)
    assert.ok(isSignedDraft(draft, token))
    assert.ok(isSignedDraft({ ...draft, wallet: draft.wallet.toLowerCase() }, token))
  })

  it('refuse any change to the question, metadata or times', () => {
    const token = signDraft(draft)
    assert.equal(isSignedDraft({ ...draft, question: 'Will anything I like happen?' }, token), false)
    assert.equal(isSignedDraft({ ...draft, metadataUri: 'ipfs://other' }, token), false)
    assert.equal(isSignedDraft({ ...draft, resolveTime: draft.resolveTime + 60n }, token), false)
  })

  it('refuse a made-up token', () => {
    assert.equal(isSignedDraft(draft, 'not-a-token'), false)
  })
})
