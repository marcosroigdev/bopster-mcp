import type { Address, Hex } from 'viem'

/**
 * Pure decisions about a BopsterMarket: what a position would pay, and which calls settle it.
 * Everything here mirrors the BopsterMarket contract verified on Base mainnet, so the plans it
 * produces are the calls the contract will accept. No I/O: the tools read a snapshot and pass it in.
 */

export const STATUS = { OPEN: 0, LOCKED: 1, RESOLVED: 2, EMERGENCY_REFUND: 3 } as const
export const STATUS_NAMES = ['OPEN', 'LOCKED', 'RESOLVED', 'EMERGENCY_REFUND'] as const

/** BopsterMarket.EMERGENCY_REFUND_DELAY: how long after resolveTime a stuck market can refund. */
export const EMERGENCY_REFUND_DELAY = 90n * 24n * 60n * 60n

/** Reality.eth answers the market reads as YES / NO; anything else settles as invalid. */
const ANSWER_YES = `0x${'0'.repeat(63)}1`
const ANSWER_NO = `0x${'0'.repeat(64)}`

export type Side = 'YES' | 'NO'

export type MarketSnapshot = {
  address: Address
  status: number
  endTime: bigint
  resolveTime: bigint
  totalYes: bigint
  totalNo: bigint
  protocolFeeBps: number
  creatorFeeBps: number
  resolverRewardBps: number
  /** Only meaningful once RESOLVED. */
  totalWinningSide: bigint
  /** Only meaningful once RESOLVED or EMERGENCY_REFUND. */
  netPayoutPool: bigint
  /** Only meaningful once RESOLVED. */
  outcomeYes: boolean
  /** Reality.eth's view of the market's question. `answer` is set only once it's final. */
  oracle: { finalized: boolean; answer: Hex | null }
  /** The chain's timestamp when this was read: the clock the contract itself goes by. */
  blockTime: bigint
}

export type WalletState = {
  address: Address
  yes: bigint
  no: bigint
  claimed: boolean
}

export type MarketCall = 'lock' | 'finalize' | 'triggerEmergencyRefund' | 'claim' | 'claimRefund'

/** How a market's pool gets paid out, decided or about to be. */
export type Resolution =
  | { refund: true }
  | { refund: false; outcomeYes: boolean; winningSide: bigint; netPool: bigint; resolverReward: bigint }

/**
 * Where the market stands before payout:
 * - `settled`: nothing left to call before claims.
 * - `ready`: calling `calls` (by anyone) settles it, after which the pool pays out as `resolution`.
 * - `waiting`: nothing can settle it yet; `reason` says why and `until` when, if known.
 */
export type SettlementPath =
  | { state: 'settled'; resolution: Resolution }
  | { state: 'ready'; calls: MarketCall[]; resolution: Resolution }
  | { state: 'waiting'; reason: string; until: bigint | null }

/** Mirrors finalize(): fees come off the whole pool, each floored, and only when someone won. */
export function resolveFromAnswer(market: MarketSnapshot, answer: Hex): Resolution {
  const pool = market.totalYes + market.totalNo
  const isYes = answer.toLowerCase() === ANSWER_YES
  const isNo = answer.toLowerCase() === ANSWER_NO
  if (!isYes && !isNo) return { refund: true }

  const winningSide = isYes ? market.totalYes : market.totalNo
  if (pool === 0n || winningSide === 0n) return { refund: true }

  const cut = (bps: number) => (pool * BigInt(bps)) / 10_000n
  const resolverReward = cut(market.resolverRewardBps)
  const netPool = pool - cut(market.protocolFeeBps) - cut(market.creatorFeeBps) - resolverReward
  return { refund: false, outcomeYes: isYes, winningSide, netPool, resolverReward }
}

export function settlementPath(market: MarketSnapshot, now: bigint): SettlementPath {
  if (market.status === STATUS.RESOLVED) {
    if (market.totalWinningSide === 0n) return { state: 'settled', resolution: { refund: true } }
    return {
      state: 'settled',
      resolution: {
        refund: false,
        outcomeYes: market.outcomeYes,
        winningSide: market.totalWinningSide,
        netPool: market.netPayoutPool,
        resolverReward: 0n,
      },
    }
  }
  if (market.status === STATUS.EMERGENCY_REFUND) {
    return { state: 'settled', resolution: { refund: true } }
  }

  // OPEN past its end time behaves like LOCKED: finalize() locks it on the way.
  if (market.status === STATUS.OPEN && now < market.endTime) {
    return { state: 'waiting', reason: 'Positions are still open.', until: market.endTime }
  }
  if (now < market.resolveTime) {
    return { state: 'waiting', reason: 'Positions are closed; settlement opens at the resolve time.', until: market.resolveTime }
  }

  if (market.oracle.finalized && market.oracle.answer) {
    return { state: 'ready', calls: ['finalize'], resolution: resolveFromAnswer(market, market.oracle.answer) }
  }

  const emergencyAt = market.resolveTime + EMERGENCY_REFUND_DELAY
  if (now >= emergencyAt) {
    // triggerEmergencyRefund() only accepts a LOCKED market, and unlike finalize() it won't lock it.
    const calls: MarketCall[] = market.status === STATUS.OPEN ? ['lock', 'triggerEmergencyRefund'] : ['triggerEmergencyRefund']
    return { state: 'ready', calls, resolution: { refund: true } }
  }

  return {
    state: 'waiting',
    reason:
      'Waiting for the Reality.eth answer to become final. If it never does, everyone can take a full refund from the emergency date.',
    until: emergencyAt,
  }
}

export type ClaimPlan =
  | { outcome: 'claim' | 'refund'; calls: MarketCall[]; amount: bigint }
  | { outcome: 'already_claimed' | 'no_position' | 'lost' | 'rounds_to_zero'; calls: []; amount: 0n }
  | { outcome: 'not_ready'; calls: []; amount: 0n; reason: string; until: bigint | null }

/** What `wallet` can take out of the market now, and the calls (in order) that get it there. */
export function planClaim(market: MarketSnapshot, wallet: WalletState, now: bigint): ClaimPlan {
  if (wallet.claimed) return { outcome: 'already_claimed', calls: [], amount: 0n }

  const stake = wallet.yes + wallet.no
  if (stake === 0n) return { outcome: 'no_position', calls: [], amount: 0n }

  const path = settlementPath(market, now)
  if (path.state === 'waiting') return { outcome: 'not_ready', calls: [], amount: 0n, reason: path.reason, until: path.until }

  const before = path.state === 'ready' ? path.calls : []
  const { resolution } = path

  // A refund returns the whole stake, both sides, with no fees taken.
  if (resolution.refund) return { outcome: 'refund', calls: [...before, 'claimRefund'], amount: stake }

  const winningStake = resolution.outcomeYes ? wallet.yes : wallet.no
  if (winningStake === 0n) return { outcome: 'lost', calls: [], amount: 0n }

  const amount = (winningStake * resolution.netPool) / resolution.winningSide
  // claim() reverts NothingToClaim on a zero payout, so planning one would only waste gas.
  if (amount === 0n) return { outcome: 'rounds_to_zero', calls: [], amount: 0n }
  return { outcome: 'claim', calls: [...before, 'claim'], amount }
}

export type PositionQuote = {
  side: Side
  amount: bigint
  /** Pools after this position, as they would stand if nobody else joined before close. */
  poolAfter: bigint
  sideAfter: bigint
  otherSide: bigint
  /** What this position alone would pay if its side wins and the pools don't move. */
  payoutIfWins: bigint
  totalFeeBps: number
}

/** Mirrors claim() for a position added now, assuming the pools hold until close. */
export function quotePosition(market: MarketSnapshot, side: Side, amount: bigint): PositionQuote {
  const sideNow = side === 'YES' ? market.totalYes : market.totalNo
  const otherSide = side === 'YES' ? market.totalNo : market.totalYes
  const poolAfter = market.totalYes + market.totalNo + amount
  const sideAfter = sideNow + amount

  const cut = (bps: number) => (poolAfter * BigInt(bps)) / 10_000n
  const netPool = poolAfter - cut(market.protocolFeeBps) - cut(market.creatorFeeBps) - cut(market.resolverRewardBps)
  const payoutIfWins = sideAfter === 0n ? 0n : (amount * netPool) / sideAfter

  return {
    side,
    amount,
    poolAfter,
    sideAfter,
    otherSide,
    payoutIfWins,
    totalFeeBps: market.protocolFeeBps + market.creatorFeeBps + market.resolverRewardBps,
  }
}

/** Why a position can't be taken right now, or null if it can. Mirrors _position(). */
export function positionBlocker(market: MarketSnapshot, now: bigint): string | null {
  if (market.status !== STATUS.OPEN) return `The market is ${STATUS_NAMES[market.status] ?? 'not open'}; positions are closed.`
  if (now >= market.endTime) return 'The market has passed its end time; positions are closed.'
  return null
}
