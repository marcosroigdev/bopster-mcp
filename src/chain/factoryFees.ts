import type { Address } from 'viem'

import { factoryAbi } from './abis.js'
import { chainRead, publicClient } from './client.js'

export type FactoryFees = {
  protocolFeeBps: number
  creatorFeeBps: number
  resolverRewardBps: number
}

/** Basis points to a percentage: 20 bps → 0.2. */
export function bpsToPercent(bps: number): number {
  return bps / 100
}

// The factory's fee configuration is immutable, so one successful read serves the process.
const cache = new Map<string, Promise<FactoryFees>>()

/** Reads the fee split from the factory contract, once per factory per process. */
export function readFactoryFees(factoryAddress: string): Promise<FactoryFees> {
  const key = factoryAddress.toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const address = factoryAddress as Address
  const read = (functionName: 'protocolFeeBps' | 'creatorFeeBps' | 'resolverRewardBps') =>
    chainRead(() => publicClient.readContract({ address, abi: factoryAbi, functionName }))

  // One at a time. The public Base RPC rate-limits bursts of parallel calls.
  const pending = (async () => ({
    protocolFeeBps: await read('protocolFeeBps'),
    creatorFeeBps: await read('creatorFeeBps'),
    resolverRewardBps: await read('resolverRewardBps'),
  }))()

  // A failed read must not stick: drop it so the next call retries.
  pending.catch(() => cache.delete(key))
  cache.set(key, pending)
  return pending
}

/** Clears the per-process cache. Tests only. */
export function clearFactoryFeesCache(): void {
  cache.clear()
}
