import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Hex } from 'viem'

import {
  EMERGENCY_REFUND_DELAY,
  STATUS,
  planClaim,
  positionBlocker,
  quotePosition,
  resolveFromAnswer,
  settlementPath,
  type MarketSnapshot,
  type WalletState,
} from '../src/planner/market.js'

const USDC = 1_000_000n
const END = 1_800_000_000n
const RESOLVE = END + 3_600n

const YES_ANSWER: Hex = `0x${'0'.repeat(63)}1`
const NO_ANSWER: Hex = `0x${'0'.repeat(64)}`
const INVALID_ANSWER: Hex = `0x${'f'.repeat(64)}`

/** A 100 USDC market, 60 on YES and 40 on NO, with mainnet's 2% / 1% / 0.2% fees. */
function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    address: '0x0000000000000000000000000000000000000001',
    status: STATUS.OPEN,
    endTime: END,
    resolveTime: RESOLVE,
    totalYes: 60n * USDC,
    totalNo: 40n * USDC,
    protocolFeeBps: 200,
    creatorFeeBps: 100,
    resolverRewardBps: 20,
    totalWinningSide: 0n,
    netPayoutPool: 0n,
    outcomeYes: false,
    oracle: { finalized: false, answer: null },
    blockTime: END - 1n,
    ...overrides,
  }
}

function wallet(overrides: Partial<WalletState> = {}): WalletState {
  return { address: '0x0000000000000000000000000000000000000002', yes: 0n, no: 0n, claimed: false, ...overrides }
}

const finalizedYes = { oracle: { finalized: true, answer: YES_ANSWER } }

describe('resolveFromAnswer', () => {
  it('takes each fee off the whole pool when someone won', () => {
    const resolution = resolveFromAnswer(market(), YES_ANSWER)

    // 100 USDC pool: 2 + 1 + 0.2 off the top.
    assert.deepEqual(resolution, {
      refund: false,
      outcomeYes: true,
      winningSide: 60n * USDC,
      netPool: 96_800_000n,
      resolverReward: 200_000n,
    })
  })

  it('refunds when the answer is neither YES nor NO', () => {
    assert.deepEqual(resolveFromAnswer(market(), INVALID_ANSWER), { refund: true })
  })

  it('refunds when nobody holds the winning side', () => {
    assert.deepEqual(resolveFromAnswer(market({ totalNo: 0n }), NO_ANSWER), { refund: true })
  })
})

describe('settlementPath', () => {
  it('waits while positions are open', () => {
    const path = settlementPath(market(), END - 1n)
    assert.equal(path.state, 'waiting')
    assert.equal(path.state === 'waiting' && path.until, END)
  })

  it('waits for the resolve time once positions close', () => {
    const path = settlementPath(market(), END + 1n)
    assert.equal(path.state === 'waiting' && path.until, RESOLVE)
  })

  it('settles an open market past its end with finalize alone', () => {
    const path = settlementPath(market(finalizedYes), RESOLVE)
    assert.equal(path.state, 'ready')
    assert.deepEqual(path.state === 'ready' && path.calls, ['finalize'])
  })

  it('waits for Reality.eth when the answer is not final, until the emergency date', () => {
    const path = settlementPath(market({ status: STATUS.LOCKED }), RESOLVE + 10n)
    assert.equal(path.state, 'waiting')
    assert.equal(path.state === 'waiting' && path.until, RESOLVE + EMERGENCY_REFUND_DELAY)
  })

  it('opens the emergency refund for a locked market whose answer never became final', () => {
    const path = settlementPath(market({ status: STATUS.LOCKED }), RESOLVE + EMERGENCY_REFUND_DELAY)
    assert.deepEqual(path.state === 'ready' && path.calls, ['triggerEmergencyRefund'])
    assert.deepEqual(path.state === 'ready' && path.resolution, { refund: true })
  })

  it('locks an open market before an emergency refund', () => {
    const path = settlementPath(market(), RESOLVE + EMERGENCY_REFUND_DELAY)
    assert.deepEqual(path.state === 'ready' && path.calls, ['lock', 'triggerEmergencyRefund'])
  })

  it('reads a resolved market as settled, from the contract state', () => {
    const path = settlementPath(
      market({ status: STATUS.RESOLVED, totalWinningSide: 60n * USDC, netPayoutPool: 96_800_000n, outcomeYes: true }),
      RESOLVE,
    )
    assert.equal(path.state, 'settled')
    assert.equal(path.state === 'settled' && !path.resolution.refund && path.resolution.netPool, 96_800_000n)
  })

  it('reads a resolved market with no winners as a refund', () => {
    const path = settlementPath(market({ status: STATUS.RESOLVED, totalWinningSide: 0n }), RESOLVE)
    assert.deepEqual(path.state === 'settled' && path.resolution, { refund: true })
  })
})

describe('planClaim', () => {
  it('settles then claims for a winner when nobody has finalized yet', () => {
    const plan = planClaim(market(finalizedYes), wallet({ yes: 30n * USDC }), RESOLVE)

    assert.equal(plan.outcome, 'claim')
    assert.deepEqual(plan.calls, ['finalize', 'claim'])
    // Half the YES side: half of the 96.8 USDC net pool.
    assert.equal(plan.amount, 48_400_000n)
  })

  it('claims straight away once the market is resolved', () => {
    const resolved = market({ status: STATUS.RESOLVED, totalWinningSide: 60n * USDC, netPayoutPool: 96_800_000n, outcomeYes: true })
    const plan = planClaim(resolved, wallet({ yes: 60n * USDC }), RESOLVE)

    assert.deepEqual(plan.calls, ['claim'])
    assert.equal(plan.amount, 96_800_000n)
  })

  it('refunds both sides of the stake, with no fees, when the answer is invalid', () => {
    const plan = planClaim(
      market({ oracle: { finalized: true, answer: INVALID_ANSWER } }),
      wallet({ yes: 5n * USDC, no: 3n * USDC }),
      RESOLVE,
    )

    assert.equal(plan.outcome, 'refund')
    assert.deepEqual(plan.calls, ['finalize', 'claimRefund'])
    assert.equal(plan.amount, 8n * USDC)
  })

  it('refunds through the emergency path', () => {
    const plan = planClaim(market({ status: STATUS.EMERGENCY_REFUND }), wallet({ no: 4n * USDC }), RESOLVE)

    assert.deepEqual(plan.calls, ['claimRefund'])
    assert.equal(plan.amount, 4n * USDC)
  })

  it('has nothing for a wallet that only backed the losing side', () => {
    const plan = planClaim(market(finalizedYes), wallet({ no: 10n * USDC }), RESOLVE)

    assert.equal(plan.outcome, 'lost')
    assert.deepEqual(plan.calls, [])
  })

  it('plans no claim when the winning share rounds down to zero', () => {
    const resolved = market({ status: STATUS.RESOLVED, totalWinningSide: 10n ** 18n, netPayoutPool: 10n, outcomeYes: true })
    const plan = planClaim(resolved, wallet({ yes: 1n }), RESOLVE)

    assert.equal(plan.outcome, 'rounds_to_zero')
    assert.deepEqual(plan.calls, [])
  })

  it('has nothing for a wallet that already claimed', () => {
    assert.equal(planClaim(market(finalizedYes), wallet({ yes: 1n, claimed: true }), RESOLVE).outcome, 'already_claimed')
  })

  it('has nothing for a wallet with no position', () => {
    assert.equal(planClaim(market(finalizedYes), wallet(), RESOLVE).outcome, 'no_position')
  })

  it('says when a claim becomes possible while the market is still running', () => {
    const plan = planClaim(market(), wallet({ yes: USDC }), END - 1n)

    assert.equal(plan.outcome, 'not_ready')
    assert.equal(plan.outcome === 'not_ready' && plan.until, END)
  })
})

describe('quotePosition', () => {
  it('pays a winning position its share of the pool after fees', () => {
    // 40 NO + 10 more = 50 on NO, pool 110 → net 106.48; 10/50 of it.
    const quote = quotePosition(market(), 'NO', 10n * USDC)

    assert.equal(quote.poolAfter, 110n * USDC)
    assert.equal(quote.sideAfter, 50n * USDC)
    assert.equal(quote.payoutIfWins, 21_296_000n)
  })

  it('pays back less than the stake when nobody is on the other side', () => {
    const quote = quotePosition(market({ totalYes: 0n, totalNo: 0n }), 'YES', 10n * USDC)

    assert.equal(quote.otherSide, 0n)
    assert.equal(quote.payoutIfWins, 9_680_000n)
  })
})

describe('positionBlocker', () => {
  it('allows a position on an open market before its end', () => {
    assert.equal(positionBlocker(market(), END - 1n), null)
  })

  it('refuses at and after the end time, like the contract', () => {
    assert.match(positionBlocker(market(), END) ?? '', /closed/)
  })

  it('refuses a market that is no longer open', () => {
    assert.match(positionBlocker(market({ status: STATUS.LOCKED }), END - 1n) ?? '', /LOCKED/)
  })
})
