import type { Address, ContractFunctionParameters, Hex } from 'viem'

import type { MarketSnapshot, WalletState } from '../planner/market.js'
import { erc20Abi, factoryAbi, marketAbi, realityAbi } from './abis.js'
import { chain, ChainReadError, chainRead, publicClient, requireFactory } from './client.js'
import { questionOf } from './registry.js'

/** Multicall3's own views: the block's clock, and a wallet's ETH. */
export const multicall3Abi = [
  { type: 'function', name: 'getCurrentBlockTimestamp', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'getEthBalance',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

export type TokenInfo = { address: Address; decimals: number; symbol: string }

// The factory's token and oracle never change, so each is read once per process.
let factoryConstants: Promise<{ token: Address; reality: Address }> | null = null
let tokenInfo: Promise<TokenInfo> | null = null

/** Caches a read, dropping it on failure so the next call retries. */
function once<T>(read: () => Promise<T>, store: (value: Promise<T> | null) => void): Promise<T> {
  const pending = read()
  pending.catch(() => store(null))
  store(pending)
  return pending
}

function readFactoryConstants(): Promise<{ token: Address; reality: Address }> {
  if (factoryConstants) return factoryConstants
  const factory = requireFactory()
  return once(
    () =>
      chainRead(async () => {
        const [token, reality] = await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: factory, abi: factoryAbi, functionName: 'token' },
            { address: factory, abi: factoryAbi, functionName: 'reality' },
          ],
        })
        return { token, reality }
      }),
    (value) => (factoryConstants = value),
  )
}

export function readToken(): Promise<TokenInfo> {
  if (tokenInfo) return tokenInfo
  return once(
    async () => {
      const { token } = await readFactoryConstants()
      const [decimals, symbol] = await chainRead(() =>
        publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: token, abi: erc20Abi, functionName: 'decimals' },
            { address: token, abi: erc20Abi, functionName: 'symbol' },
          ],
        }),
      )
      return { address: token, decimals, symbol }
    },
    (value) => (tokenInfo = value),
  )
}

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }

function value<T>(results: readonly CallResult[], index: number): T {
  const entry = results[index]
  if (entry.status === 'failure') throw new ChainReadError(entry.error.message)
  return entry.result as T
}

/**
 * One market's state, Reality.eth's view of its question and, when asked, a wallet's stake: one
 * RPC round trip, since the question and the oracle are cached. `blockTime` is the chain's clock,
 * not this server's: the contract decides by block.timestamp, so that's what plans compare against.
 */
export async function readMarketState(
  address: Address,
  wallet?: Address,
): Promise<{ market: MarketSnapshot; position: WalletState | null }> {
  const questionId = await questionOf(address)
  if (!questionId) throw new ChainReadError(`${address} is not a Bopster market.`)
  const { reality } = await readFactoryConstants()

  const m = { address, abi: marketAbi } as const
  const r = { address: reality, abi: realityAbi } as const
  // Typed loosely because the wallet calls are optional; each result is checked as it's read.
  const contracts: ContractFunctionParameters[] = [
    { ...m, functionName: 'status' },
    { ...m, functionName: 'endTime' },
    { ...m, functionName: 'resolveTime' },
    { ...m, functionName: 'totalYes' },
    { ...m, functionName: 'totalNo' },
    { ...m, functionName: 'protocolFeeBps' },
    { ...m, functionName: 'creatorFeeBps' },
    { ...m, functionName: 'resolverRewardBps' },
    { ...m, functionName: 'totalWinningSide' },
    { ...m, functionName: 'netPayoutPool' },
    { ...m, functionName: 'outcomeYes' },
    { address: chain.contracts.multicall3.address, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
    { ...r, functionName: 'isFinalized', args: [questionId] },
    { ...r, functionName: 'resultFor', args: [questionId] },
  ]
  if (wallet) {
    contracts.push(
      { ...m, functionName: 'yesPosition', args: [wallet] },
      { ...m, functionName: 'noPosition', args: [wallet] },
      { ...m, functionName: 'claimed', args: [wallet] },
    )
  }
  // resultFor() reverts until the answer is final, so failures are allowed and checked per call.
  const results = (await chainRead(() => publicClient.multicall({ allowFailure: true, contracts }))) as readonly CallResult[]

  const finalized = value<boolean>(results, 12)
  const answer = finalized ? value<Hex>(results, 13) : null

  return {
    market: {
      address,
      status: value<number>(results, 0),
      endTime: value<bigint>(results, 1),
      resolveTime: value<bigint>(results, 2),
      totalYes: value<bigint>(results, 3),
      totalNo: value<bigint>(results, 4),
      protocolFeeBps: value<number>(results, 5),
      creatorFeeBps: value<number>(results, 6),
      resolverRewardBps: value<number>(results, 7),
      totalWinningSide: value<bigint>(results, 8),
      netPayoutPool: value<bigint>(results, 9),
      outcomeYes: value<boolean>(results, 10),
      blockTime: value<bigint>(results, 11),
      oracle: { finalized, answer },
    },
    position: wallet
      ? { address: wallet, yes: value<bigint>(results, 14), no: value<bigint>(results, 15), claimed: value<boolean>(results, 16) }
      : null,
  }
}

export async function readMarket(address: Address): Promise<MarketSnapshot> {
  return (await readMarketState(address)).market
}

/**
 * What the wallet holds of the token, and its gas money. Not the allowance: prepare_position always
 * approves the exact stake, see positionTransactions.
 */
export async function readFunding(token: Address, wallet: Address) {
  const [balance, gas] = await chainRead(() =>
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] },
        { address: chain.contracts.multicall3.address, abi: multicall3Abi, functionName: 'getEthBalance', args: [wallet] },
      ],
    }),
  )
  return { balance, gas }
}

/** Clears the cached factory constants and token. Tests only. */
export function clearTokenCache(): void {
  factoryConstants = null
  tokenInfo = null
}
