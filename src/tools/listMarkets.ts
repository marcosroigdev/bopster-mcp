import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getJsonWithMetadata, type QueryValue } from '../http/client.js'
import { enrichMarket } from '../format.js'
import { isWalletHandle, jsonResult, runTool } from './shared.js'

const inputSchema = {
  status: z
    .enum(['open', 'locked', 'resolved'])
    .optional()
    .describe('Filter by high-level market status.'),
  category: z
    .string()
    .optional()
    .describe('Filter by category, e.g. Crypto, Tech, AI, Sports, Gaming, Politics, Memes, Culture.'),
  title: z.string().optional().describe('Case-insensitive search within the market title.'),
  question: z.string().optional().describe('Case-insensitive search within the market question.'),
  creator: z
    .string()
    .optional()
    .describe("Filter by creator: their wallet address, or the exact creator name shown on the market."),
  sort_field: z
    .enum([
      'total_volume',
      'participants_count',
      'created_at',
      'end_time',
      'quality_tier',
      'status',
      'total_yes',
    ])
    .optional()
    .describe('Field to sort by. Defaults to the backend default.'),
  sort_order: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
  page: z.number().int().min(1).optional().describe('1-based page number.'),
  size: z.number().int().min(1).max(100).optional().describe('Page size (max 100).'),
}

type ListMarketsArgs = z.infer<z.ZodObject<typeof inputSchema>>

/**
 * The backend query for these arguments. A creator given as a wallet goes out as market_creator,
 * the on-chain creator, like the site does. The backend's `creator` only matches the name pinned
 * in the metadata.
 */
export function marketsQuery(args: ListMarketsArgs): Record<string, QueryValue> {
  const { creator, ...rest } = args
  if (creator === undefined) return { ...rest }

  return isWalletHandle(creator) ? { ...rest, market_creator: creator.trim().toLowerCase() } : { ...rest, creator }
}

/**
 * Shapes the backend's market list for the agent: enriched items plus the pagination block, so
 * the agent can tell whether more pages exist instead of assuming the first page is everything.
 */
export function toMarketList(data: unknown, metadata: unknown): unknown {
  if (!Array.isArray(data)) return data
  const pagination =
    metadata && typeof metadata === 'object' && 'pagination' in metadata
      ? (metadata as { pagination: unknown }).pagination
      : null
  return {
    items: data.map((m) => enrichMarket(m as Record<string, unknown>)),
    pagination,
  }
}

export function registerListMarkets(server: McpServer): void {
  server.registerTool(
    'list_markets',
    {
      title: 'List Bopster markets',
      description:
        'Search and list prediction markets on Bopster (a non-custodial prediction market on Base). ' +
        'Supports filtering by status, category and text, plus sorting and pagination. ' +
        'Returns each market with YES/NO pools, total volume and end/resolve times, and a ' +
        '`pagination` block (page, size, total, pages). ' +
        'Amounts are USDC (6 decimals); *_formatted and *_iso fields are added for readability.',
      inputSchema,
    },
    async (args) =>
      runTool(async () => {
        const { data, metadata } = await getJsonWithMetadata<unknown>('/markets', marketsQuery(args))
        return jsonResult(toMarketList(data, metadata))
      }),
  )
}
