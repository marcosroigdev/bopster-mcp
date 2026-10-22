import { BaseError, createPublicClient, http, type Address } from 'viem'
import { base, baseSepolia } from 'viem/chains'

import { config } from '../config.js'

export class ChainReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainReadError'
  }
}

export const chain = config.chainId === 84532 ? baseSepolia : base

export const publicClient = createPublicClient({
  chain,
  transport: http(config.rpcUrl, { timeout: config.httpTimeoutMs }),
})

/** viem's one-line message plus the RPC's own reason, e.g. "RPC Request failed. (over rate limit)". */
export function describe(error: unknown): string {
  if (error instanceof BaseError) return error.details ? `${error.shortMessage} (${error.details})` : error.shortMessage
  return error instanceof Error ? error.message : String(error)
}

const RATE_LIMIT_CODES = new Set([429, -32005, -32016])

/**
 * Rate limiting, as RPCs report it: HTTP 429, the JSON-RPC "limit exceeded" code, or the public
 * Base RPC's own -32016 "over rate limit", which viem doesn't retry. Judged by the error's code and
 * status, and by its message. Never by the revert data, whose hex can contain "429".
 */
export function isRateLimited(error: unknown): boolean {
  const carries = (e: unknown) => {
    const { code, status } = e as { code?: unknown; status?: unknown }
    return RATE_LIMIT_CODES.has(code as number) || RATE_LIMIT_CODES.has(status as number)
  }
  if (carries(error)) return true
  if (error instanceof BaseError) {
    if (error.walk(carries)) return true
    return /rate limit|too many requests/i.test(`${error.shortMessage} ${error.details ?? ''}`)
  }
  return /rate limit|too many requests/i.test(error instanceof Error ? error.message : String(error))
}

const RETRY_DELAYS_MS = [300, 900, 2_000]

/**
 * Runs a chain read, retrying when the RPC rate-limits, and turns viem's errors into a
 * ChainReadError, which tools report to the agent as a readable message.
 */
export async function chainRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (error instanceof ChainReadError) throw error
      if (isRateLimited(error) && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
        continue
      }
      throw new ChainReadError(describe(error))
    }
  }
}

/** The configured factory, or an error the agent can act on when the server has none. */
export function requireFactory(): Address {
  if (!config.factoryAddress) {
    throw new ChainReadError('this server has no BopsterFactory address configured (BOPSTER_FACTORY_ADDRESS).')
  }
  return config.factoryAddress as Address
}
