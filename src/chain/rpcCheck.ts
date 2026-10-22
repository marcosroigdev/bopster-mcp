import { BaseError, HttpRequestError, TimeoutError, TransactionReceiptNotFoundError, type Hash } from 'viem'

import { config } from '../config.js'
import { describe, isRateLimited, publicClient } from './client.js'

/**
 * Whether BOPSTER_RPC_URL returns transaction receipts.
 *
 * prepare_market_launch and register_market read the receipt of the transaction the agent just
 * sent, and sync_market reads its block from one. An RPC that refuses receipts breaks market
 * creation while every other tool keeps working, so nothing else gives it away: publicnode's free
 * tier answers every receipt, even one from the latest block, with "Archive requests require a
 * personal token". Checked once at startup, logged, and shown on /health.
 */
export type RpcReceiptsStatus =
  | { host: string; receipts: 'pending' | 'ok' }
  | { host: string; receipts: 'refused' | 'unchecked'; detail: string }

/** The two reads the check makes; publicClient, or a stand-in in tests. */
type ReceiptReader = {
  getBlock(args: { blockTag: 'latest' }): Promise<{ transactions: readonly (Hash | { hash: Hash })[] }>
  getTransactionReceipt(args: { hash: Hash }): Promise<unknown>
}

/** The RPC's host alone: the rest of the URL can carry an API key. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the configured RPC'
  }
}

/** A failure that says nothing about the RPC's support for receipts: rate limits, timeouts, a down node. */
function isTransient(error: unknown): boolean {
  if (error instanceof TransactionReceiptNotFoundError || isRateLimited(error)) return true
  const unreachable = (e: unknown) =>
    e instanceof TimeoutError || (e instanceof HttpRequestError && (e.status === undefined || e.status >= 500))
  return unreachable(error) || (error instanceof BaseError && error.walk(unreachable) !== null)
}

export async function checkReceipts(client: ReceiptReader = publicClient, rpcUrl: string = config.rpcUrl): Promise<RpcReceiptsStatus> {
  const host = rpcHost(rpcUrl)
  const scrub = (text: string) => text.split(rpcUrl).join(host)

  let hash: Hash | undefined
  try {
    const first = (await client.getBlock({ blockTag: 'latest' })).transactions[0]
    hash = typeof first === 'string' ? first : first?.hash
  } catch (error) {
    return { host, receipts: 'unchecked', detail: scrub(`couldn't read the latest block: ${describe(error)}`) }
  }
  if (!hash) return { host, receipts: 'unchecked', detail: 'the latest block has no transaction to try' }

  try {
    await client.getTransactionReceipt({ hash })
    return { host, receipts: 'ok' }
  } catch (error) {
    return { host, receipts: isTransient(error) ? 'unchecked' : 'refused', detail: scrub(describe(error)) }
  }
}

let current: RpcReceiptsStatus = { host: rpcHost(config.rpcUrl), receipts: 'pending' }

/** The startup check's result, for /health. */
export function rpcStatus(): RpcReceiptsStatus {
  return current
}

export function describeRpcStatus(status: RpcReceiptsStatus): string {
  switch (status.receipts) {
    case 'ok':
      return `bopster-mcp: RPC ${status.host} returns transaction receipts`
    case 'refused':
      return (
        `bopster-mcp: BOPSTER_RPC_URL (${status.host}) refuses transaction receipts: ${status.detail}. ` +
        "prepare_market_launch and register_market will fail, and sync_market can't tell the backend the block. " +
        "publicnode's free tier does this; use https://mainnet.base.org or a dedicated Base RPC."
      )
    case 'unchecked':
      return `bopster-mcp: couldn't check that BOPSTER_RPC_URL (${status.host}) returns transaction receipts: ${status.detail}`
    default:
      return `bopster-mcp: checking that RPC ${status.host} returns transaction receipts`
  }
}

/** Runs the check once and logs it. Never throws: the server works for every other tool either way. */
export async function checkRpcAtStartup(log: (line: string) => void = console.error): Promise<RpcReceiptsStatus> {
  current = await checkReceipts().catch((error: unknown) => ({
    host: current.host,
    receipts: 'unchecked' as const,
    detail: describe(error),
  }))
  log(describeRpcStatus(current))
  return current
}
