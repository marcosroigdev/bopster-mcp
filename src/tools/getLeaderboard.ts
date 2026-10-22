import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getJson } from '../http/client.js'
import { jsonResult, runTool } from './shared.js'

const inputSchema = {
  type: z
    .enum(['creators', 'predictors', 'oracles'])
    .describe('Which leaderboard: market creators, position takers (predictors), or oracle answerers.'),
  period: z
    .enum(['all', 'day', 'week', 'month'])
    .default('all')
    .describe('Time window for ranking.'),
  page: z.number().int().min(1).default(1).describe('1-based page number.'),
  limit: z.number().int().min(1).max(100).default(25).describe('Results per page (max 100).'),
}

export function registerGetLeaderboard(server: McpServer): void {
  server.registerTool(
    'get_leaderboard',
    {
      title: 'Get a Bopster leaderboard',
      description:
        'Return a ranked leaderboard of Bopster participants (top market creators, predictors, i.e. ' +
        'position takers, or oracle answerers) over a given time period, with pagination.',
      inputSchema,
    },
    async (args) =>
      runTool(async () => {
        const data = await getJson<unknown>(`/leaderboard/${args.type}`, {
          period: args.period,
          page: args.page,
          limit: args.limit,
        })
        return jsonResult(data)
      }),
  )
}
