import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { config } from '../config.js'

/**
 * A market draft, as prepare_market_question built it. The token ties these fields together under
 * this server's key, so prepare_market_launch can tell a draft it made from one an agent made up.
 * Without it, launch would take any Reality question, free text included.
 */
export type SignedDraft = {
  wallet: string
  metadataUri: string
  question: string
  endTime: bigint
  resolveTime: bigint
}

const key = config.draftSecret ? Buffer.from(config.draftSecret) : randomBytes(32)

function mac(draft: SignedDraft): Buffer {
  const payload = JSON.stringify([
    'bopster-draft-v1',
    config.chainId,
    draft.wallet.toLowerCase(),
    draft.metadataUri,
    draft.question,
    draft.endTime.toString(),
    draft.resolveTime.toString(),
  ])
  return createHmac('sha256', key).update(payload).digest()
}

export function signDraft(draft: SignedDraft): string {
  return mac(draft).toString('base64url')
}

export function isSignedDraft(draft: SignedDraft, token: string): boolean {
  const expected = mac(draft)
  const given = Buffer.from(token, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
