import { z } from 'zod'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'

import { config } from '../config.js'
import { marketAbi } from '../chain/abis.js'
import { chain } from '../chain/client.js'
import { isBopsterMarket } from '../chain/registry.js'
import { formatTokenAmount, unixToIsoUtc } from '../format.js'
import type { MarketCall } from '../planner/market.js'
import type { TokenInfo } from '../chain/marketState.js'
import { ToolInputError } from './shared.js'

/**
 * Shared pieces of the prepare_* tools. They build unsigned transactions and nothing more: this
 * server holds no keys, signs nothing and sends nothing. The agent's own wallet does that.
 */

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x-prefixed EVM address.')

export const marketInput = addressSchema.describe('The Bopster market contract address (0x...).')

export const walletInput = addressSchema.describe(
  'The wallet that will sign and send the transactions (0x...). Balances and positions are read for this address.',
)

export const sideInput = z.enum(['YES', 'NO']).describe('Which side to take.')

export const amountInput = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'A positive decimal amount, e.g. "5" or "2.5".')
  .describe('Stake in whole token units, e.g. "5" for 5 USDC (not base units).')

export type UnsignedTransaction = {
  step: number
  action: GasAction
  description: string
  to: Address
  data: Hex
  /** Wei to send with it, as a decimal string. "0" for everything but a question with a bounty. */
  value: string
  /** The gas limit to send it with, as a decimal string. See GAS_LIMITS. */
  gas: string
}

export type GasAction = MarketCall | 'approve' | 'positionYes' | 'positionNo' | 'askQuestion' | 'createMarket'

/**
 * Gas limits for every transaction these tools prepare, at least about twice what each used, so the
 * wallet sends them as they are instead of estimating. An estimate made right after the previous
 * transaction confirms can reach an RPC node that hasn't seen it: it reverts (a position whose
 * approve the node doesn't know) or comes out short (an approve priced as the cheap
 * nonzero-to-nonzero write that then runs as zero-to-nonzero). Only the gas used is charged.
 *
 * Measured on Base Sepolia and on an anvil fork of Base mainnet, sending with these limits, through
 * a YES win, an INVALID refund and an emergency refund.
 */
export const GAS_LIMITS: Record<GasAction, bigint> = {
  approve: 120_000n, // used 55,437
  positionYes: 250_000n, // used 117,195 for a wallet's first position on a side, about 66,000 after
  positionNo: 250_000n, // used 100,235 first, about 66,000 after
  lock: 120_000n, // used 49,760
  finalize: 500_000n, // used 198,272 paying out a win, 134,684 settling a refund
  triggerEmergencyRefund: 300_000n, // used 88,337
  claim: 300_000n, // used 80,206
  claimRefund: 300_000n, // used 83,094
  askQuestion: 200_000n, // used 82,192; grows a little with the question's length
  createMarket: 2_800_000n, // used 1,401,745: it deploys the market
}

export function gasFor(action: GasAction): string {
  return GAS_LIMITS[action].toString()
}

/** Parses "2.5" into base units, refusing zero and more precision than the token has. */
export function parseAmount(input: string, token: TokenInfo): bigint {
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > token.decimals) {
    throw new ToolInputError(`${token.symbol} has ${token.decimals} decimals; "${input}" has more.`)
  }
  const amount = BigInt(whole + fraction.padEnd(token.decimals, '0'))
  if (amount === 0n) throw new ToolInputError('The amount must be more than zero.')
  return amount
}

export function money(raw: bigint, token: TokenInfo): string {
  return formatTokenAmount(raw, token.decimals, token.symbol) ?? raw.toString()
}

export function time(seconds: bigint | null): string | null {
  return seconds === null ? null : unixToIsoUtc(Number(seconds))
}

/** Checksums the address and refuses anything the factory didn't deploy. */
export async function requireBopsterMarket(input: string): Promise<Address> {
  const address = getAddress(input)
  if (!(await isBopsterMarket(address))) {
    throw new ToolInputError(
      `${address} isn't a market deployed by the Bopster factory on ${chain.name}. Use list_markets to find one.`,
    )
  }
  return address
}

const CALL_DESCRIPTIONS: Record<MarketCall, string> = {
  lock: 'Lock the market: its end time has passed.',
  finalize: 'Settle the market from the final Reality.eth answer. Whoever sends this earns the resolver reward.',
  triggerEmergencyRefund: 'Switch the market to refunds: its oracle answer never became final within the emergency delay.',
  claim: 'Claim the payout for the winning side.',
  claimRefund: 'Claim back the full stake, both sides, with no fees taken.',
}

export function marketCalls(market: Address, calls: MarketCall[], firstStep = 1): UnsignedTransaction[] {
  return calls.map((functionName, i) => ({
    step: firstStep + i,
    action: functionName,
    description: CALL_DESCRIPTIONS[functionName],
    to: market,
    data: encodeFunctionData({ abi: marketAbi, functionName }),
    value: '0',
    gas: gasFor(functionName),
  }))
}

/** The note every prepared plan carries, so no agent mistakes it for something already sent. */
export function signingInstructions(
  wallet: Address | null,
  afterward = 'After the last one confirms, call sync_market with its hash so the Bopster site shows it right away.',
): string {
  const from = wallet ? `from ${wallet} ` : ''
  return (
    `Unsigned. Sign and send each transaction ${from}on ${chain.name} (chain ${config.chainId}), in step order, ` +
    'waiting for each to confirm before the next. Send each with its `gas` as the gas limit instead of estimating: ' +
    "right after a confirmation, an RPC node that hasn't caught up can make an estimate fail or come out short, and " +
    'only the gas used is charged. If your wallet estimates anyway and that fails just after the previous ' +
    `transaction confirmed, wait a few seconds and send it again. This server holds no keys and has sent nothing. ${afterward}`
  )
}
