import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAddress, type Hash } from 'viem'

import { publicClient } from '../chain/client.js'
import { sendJson } from '../http/client.js'
import { addressSchema, marketInput, requireBopsterMarket } from './transactions.js'
import { jsonResult, runTool } from './shared.js'

/**
 * The block the transaction landed in, or null when this server's RPC can't say yet. Sent to the
 * backend as from_block, like the site does.
 */
export async function transactionBlock(txHash: Hash): Promise<number | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    return Number(receipt.blockNumber)
  } catch {
    // Not found on this node yet, or the RPC failed. Sync without it.
    return null
  }
}

export function syncBody(txHash: string, wallet: string | undefined, block: number | null): Record<string, unknown> {
  const body: Record<string, unknown> = { tx_hash: txHash }
  if (block !== null) body.from_block = block
  if (wallet) body.user_address = getAddress(wallet).toLowerCase()
  return body
}

export function registerSyncMarket(server: McpServer): void {
  server.registerTool(
    'sync_market',
    {
      title: 'Sync a Bopster market',
      description:
        'Ask the Bopster backend to re-read a market from the chain after a transaction confirms, so the site and the ' +
        'other tools show it right away instead of after the next indexer pass. Changes nothing on-chain and moves no ' +
        'funds; the chain stays the source of truth either way.',
      inputSchema: {
        market: marketInput,
        tx_hash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 0x-prefixed 32-byte transaction hash.')
          .describe('Hash of the confirmed transaction.'),
        wallet: addressSchema.optional().describe('The wallet that sent it, if any (0x...).'),
      },
    },
    async (args) =>
      runTool(async () => {
        const address = await requireBopsterMarket(args.market)
        const block = await transactionBlock(args.tx_hash as Hash)

        await sendJson('PUT', `/market/${address.toLowerCase()}`, syncBody(args.tx_hash, args.wallet, block))
        return jsonResult({ market: address, queued: true })
      }),
  )
}
