import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getJson, type QueryValue } from '../http/client.js'
import { jsonResult, runTool } from './shared.js'

const inputSchema = {
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x-prefixed EVM market contract address.')
    .describe('The on-chain market contract address (0x...).'),
  user_address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x-prefixed EVM wallet address.')
    .optional()
    .describe('Optional wallet address to include that user’s positions and claimable state.'),
}

export function registerGetMarket(server: McpServer): void {
  server.registerTool(
    'get_market',
    {
      title: 'Get a Bopster market',
      description:
        'Fetch the full detail of a single Bopster prediction market by its on-chain address: ' +
        'question, category, source, YES/NO pools, market phase, oracle state and (optionally) a ' +
        'given wallet’s positions. Amounts are USDC base units (6 decimals); times are unix seconds (UTC).',
      inputSchema,
    },
    async (args) =>
      runTool(async () => {
        const query: Record<string, QueryValue> = args.user_address
          ? { user_address: args.user_address }
          : {}
        const data = await getJson<unknown>(`/market-view/${args.address}`, query)
        return jsonResult(data)
      }),
  )
}
