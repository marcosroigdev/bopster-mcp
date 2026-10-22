import type { Address, Hex } from 'viem'

import { factoryAbi, marketAbi } from './abis.js'
import { chainRead, publicClient, requireFactory } from './client.js'

/**
 * Markets the factory has deployed, read from its own on-chain registry, with the Reality.eth
 * question each one settles on.
 *
 * Every tool that builds a transaction checks its market here first. Otherwise any contract that
 * answers the same getters could pass as a market and steer an approval to itself. The registry
 * only grows and a market's question never changes, so both are cached and topped up from the
 * last index seen.
 */
const known = new Map<string, Hex>()
let knownCount = 0n

async function refresh(factory: Address): Promise<void> {
  const count = await chainRead(() => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: 'marketsCount' }))
  if (count <= knownCount) return

  const from = knownCount
  const markets = await chainRead(() =>
    publicClient.multicall({
      allowFailure: false,
      contracts: Array.from({ length: Number(count - from) }, (_, i) => ({
        address: factory,
        abi: factoryAbi,
        functionName: 'allMarkets' as const,
        args: [from + BigInt(i)] as const,
      })),
    }),
  )
  const questions = await chainRead(() =>
    publicClient.multicall({
      allowFailure: false,
      contracts: markets.map((market) => ({ address: market, abi: marketAbi, functionName: 'questionId' as const })),
    }),
  )
  markets.forEach((market, i) => known.set(market.toLowerCase(), questions[i]))
  if (count > knownCount) knownCount = count
}

export async function isBopsterMarket(address: string): Promise<boolean> {
  const key = address.toLowerCase()
  if (known.has(key)) return true
  await refresh(requireFactory())
  return known.has(key)
}

/** The question a Bopster market settles on, or null for an address the factory never deployed. */
export async function questionOf(address: string): Promise<Hex | null> {
  return (await isBopsterMarket(address)) ? (known.get(address.toLowerCase()) ?? null) : null
}

/** The Bopster market already built on this Reality.eth question, if there is one. */
export async function marketForQuestion(questionId: Hex): Promise<Address | null> {
  await refresh(requireFactory())
  const wanted = questionId.toLowerCase()
  for (const [market, question] of known) {
    if (question.toLowerCase() === wanted) return market as Address
  }
  return null
}

/** Clears the cached registry. Tests only. */
export function clearRegistryCache(): void {
  known.clear()
  knownCount = 0n
}
