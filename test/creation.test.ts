import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type TransactionReceipt } from 'viem'

import { factoryAbi, realityAbi } from '../src/chain/abis.js'
import { marketFromReceipt, questionFromReceipt } from '../src/chain/creation.js'
import {
  creatorNameError,
  launchTimingError,
  loginMessage,
  validateDraft,
  type MarketDraftInput,
} from '../src/planner/creation.js'

const NOW = 1_800_000_000n // a whole minute
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString()

function input(overrides: Partial<MarketDraftInput> = {}): MarketDraftInput {
  return {
    title: 'BTC above $90K',
    template: { type: 'price_threshold', asset: 'BTC', direction: 'above', price: '90000' },
    category: 'Crypto',
    sourceUrl: 'https://www.coinbase.com/price/bitcoin',
    endTime: iso(NOW + 3_600n),
    resolutionDelayMinutes: 30,
    ...overrides,
  }
}

const match = (overrides: Partial<MarketDraftInput> = {}) =>
  input({
    category: 'Sports',
    template: { type: 'event_outcome', event: 'Real Madrid beat Barcelona' },
    resolutionDelayMinutes: undefined,
    ...overrides,
  })

describe('validateDraft', () => {
  it('builds the question from the template, dated at the resolve time', () => {
    const { errors, draft } = validateDraft(input(), NOW)

    assert.deepEqual(errors, [])
    assert.equal(draft?.endTime, NOW + 3_600n)
    assert.equal(draft?.resolveTime, NOW + 3_600n + 1_800n)
    assert.equal(draft?.templateId, 'price_threshold_v1')
    assert.equal(draft?.question, 'Will BTC be above $90000 at 2027-01-15 09:30 UTC?')
  })

  it('passes template field errors through with the rest', () => {
    const { errors } = validateDraft(input({ template: { type: 'event_outcome', event: 'Will it?' }, sourceUrl: 'nope' }), NOW)
    assert.ok(errors.some((e) => /event/.test(e)))
    assert.ok(errors.some((e) => /source_url/.test(e)))
  })

  it('wants room for the second transaction on top of the factory minimum', () => {
    // 15 minutes would pass the factory now, and fail by the time the market is launched.
    assert.equal(validateDraft(input({ endTime: iso(NOW + 15n * 60n) }), NOW).draft, null)
    assert.ok(validateDraft(input({ endTime: iso(NOW + 20n * 60n) }), NOW).draft)
  })

  it('refuses a close more than 10 days out', () => {
    const { errors } = validateDraft(input({ endTime: iso(NOW + 11n * 86_400n) }), NOW)
    assert.ok(errors.some((e) => /10 days/.test(e)))
  })

  it('refuses a time without a timezone', () => {
    const { errors } = validateDraft(input({ endTime: '2027-01-15T12:00:00' }), NOW)
    assert.ok(errors.some((e) => /timezone/.test(e)))
  })

  it('refuses a close between minutes', () => {
    const { errors } = validateDraft(input({ endTime: iso(NOW + 3_630n) }), NOW)
    assert.ok(errors.some((e) => /whole minute/.test(e)))
  })

  it('still reports the timing limits alongside a close between minutes', () => {
    const { errors } = validateDraft(input({ endTime: iso(NOW + 630n) }), NOW)
    assert.ok(errors.some((e) => /whole minute/.test(e)))
    assert.ok(errors.some((e) => /minutes from now/.test(e)))
  })

  it('only takes the resolution delays the site offers, 30 minutes by default', () => {
    assert.ok(validateDraft(input({ resolutionDelayMinutes: 45 }), NOW).errors.some((e) => /resolution_delay_minutes/.test(e)))
    assert.equal(validateDraft(input({ resolutionDelayMinutes: undefined }), NOW).draft?.resolveTime, NOW + 3_600n + 1_800n)
  })

  it('needs a public source URL', () => {
    for (const sourceUrl of ['not a url', 'ftp://example.com/x', 'http://localhost:3000', 'http://192.168.1.10/a']) {
      assert.equal(validateDraft(input({ sourceUrl }), NOW).draft, null, sourceUrl)
    }
  })

  it('keeps the title to one line', () => {
    assert.ok(validateDraft(input({ title: 'BTC above\n$90K' }), NOW).errors.some((e) => /single line/.test(e)))
  })

  it('stores a known category the way the site spells it', () => {
    assert.equal(validateDraft(input({ category: 'crypto' }), NOW).draft?.category, 'Crypto')
  })

  it('reports every problem at once', () => {
    const { errors } = validateDraft(input({ title: '', category: 'X', sourceUrl: 'nope' }), NOW)
    assert.equal(errors.length, 3)
  })
})

describe('validateDraft for sports', () => {
  it('asks whether a Sports market is a match', () => {
    assert.ok(validateDraft(match(), NOW).errors.some((e) => /sports_match/.test(e)))
  })

  it("closes a match at kick-off and resolves it on the sport's delay", () => {
    const { draft } = validateDraft(match({ sportsMatch: 'football' }), NOW)
    assert.equal(draft?.resolveTime, NOW + 3_600n + 180n * 60n)
  })

  it("refuses a delay that contradicts the sport's", () => {
    assert.ok(validateDraft(match({ sportsMatch: 'football', resolutionDelayMinutes: 30 }), NOW).errors.some((e) => /180/.test(e)))
  })

  it('wants the event template for a match', () => {
    const priced = match({ sportsMatch: 'basketball', template: { type: 'price_threshold', asset: 'BTC', direction: 'above', price: '1' } })
    assert.ok(validateDraft(priced, NOW).errors.some((e) => /event_outcome/.test(e)))
  })

  it('lets an unlisted sport set its own delay, warning when it looks too short', () => {
    assert.ok(validateDraft(match({ sportsMatch: 'other' }), NOW).errors.some((e) => /resolution_delay_minutes/.test(e)))
    const { draft } = validateDraft(match({ sportsMatch: 'other', resolutionDelayMinutes: 60 }), NOW)
    assert.equal(draft?.warnings.length, 1)
  })

  it('treats transfers and tournaments as ordinary markets', () => {
    assert.ok(validateDraft(match({ sportsMatch: 'not_a_match', resolutionDelayMinutes: 1440 }), NOW).draft)
  })

  it('keeps match rules out of other categories', () => {
    assert.ok(validateDraft(input({ sportsMatch: 'football' }), NOW).errors.some((e) => /Sports category/.test(e)))
  })
})

describe('creatorNameError', () => {
  it('follows the site rule for display names', () => {
    assert.equal(creatorNameError('Bop Agent_2'), null)
    assert.ok(creatorNameError('2fast'))
    assert.ok(creatorNameError('ab'))
  })
})

describe('launchTimingError', () => {
  it('lets a launch through while the close is still 15 minutes away', () => {
    assert.equal(launchTimingError(NOW + 16n * 60n, NOW + 30n * 60n, NOW), null)
  })

  it('says to start over once the close is too near, like the factory would', () => {
    assert.match(launchTimingError(NOW + 10n * 60n, NOW + 30n * 60n, NOW) ?? '', /Start over/)
  })
})

describe('loginMessage', () => {
  it('is the exact message the backend verifies, with the address lowercased', () => {
    assert.equal(
      loginMessage('0xAbC0000000000000000000000000000000000001', 'n0nce'),
      'Bopster Fun login\naddress=0xabc0000000000000000000000000000000000001\nnonce=n0nce',
    )
  })
})

describe('reading receipts', () => {
  const REALITY: Address = getAddress('0x2f39f464d16402ca3d8527da89617b73de2f60e8')
  const FACTORY: Address = getAddress('0x11a2a549286567f7427d990423e5a3560ea16750')
  const ASKER: Address = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
  const QUESTION_ID = `0x${'ab'.repeat(32)}` as const
  const MARKET: Address = getAddress('0x00000000000000000000000000000000000000cc')

  function receipt(logs: { address: Address; topics: readonly `0x${string}`[]; data: `0x${string}` }[]): TransactionReceipt {
    return { logs, blockNumber: 123n, status: 'success' } as unknown as TransactionReceipt
  }

  const askedLog = {
    address: REALITY,
    topics: encodeEventTopics({
      abi: realityAbi,
      eventName: 'LogNewQuestion',
      args: { question_id: QUESTION_ID, user: ASKER, content_hash: `0x${'cd'.repeat(32)}` },
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'string' },
        { type: 'address' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [0n, 'Will it rain?', ASKER, 43_200, 1_800_003_600, 1n, 1_800_000_000n],
    ),
  }

  it('finds the question a transaction asked', () => {
    const asked = questionFromReceipt(receipt([askedLog]), REALITY)

    assert.equal(asked?.questionId, QUESTION_ID)
    assert.equal(asked?.asker, ASKER)
    assert.equal(asked?.timeout, 43_200)
    assert.equal(asked?.openingTs, 1_800_003_600)
    assert.equal(asked?.question, 'Will it rain?')
  })

  it("ignores a question logged by some other contract", () => {
    assert.equal(questionFromReceipt(receipt([{ ...askedLog, address: MARKET }]), REALITY), null)
  })

  it('finds the market a transaction created', () => {
    const created = marketFromReceipt(
      receipt([
        {
          address: FACTORY,
          topics: encodeEventTopics({
            abi: factoryAbi,
            eventName: 'MarketCreated',
            args: { market: MARKET, creator: ASKER, questionId: QUESTION_ID },
          }) as `0x${string}`[],
          data: encodeAbiParameters(
            [{ type: 'uint64' }, { type: 'uint64' }, { type: 'string' }],
            [1_800_001_800n, 1_800_003_600n, 'ipfs://bafy'],
          ),
        },
      ]),
      FACTORY,
    )

    assert.equal(created?.market, MARKET)
    assert.equal(created?.blockNumber, 123n)
    assert.equal(created?.resolveTime, 1_800_003_600n)
  })
})
