import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getJson } from '../http/client.js'
import { aliasSegment, isWalletHandle, jsonResult, runTool } from './shared.js'

const inputSchema = {
  handle: z
    .string()
    .min(1)
    .describe('A wallet address (0x...) or a creator alias. The tool auto-detects which one it is.'),
}

export function registerGetUserProfile(server: McpServer): void {
  server.registerTool(
    'get_user_profile',
    {
      title: 'Get a Bopster user profile',
      description:
        'Fetch a public Bopster user profile plus aggregate activity (as creator, predictor and ' +
        'oracle participant). Accepts either a wallet address or an alias.',
      inputSchema,
    },
    async (args) =>
      runTool(async () => {
        const handle = args.handle.trim()
        const path = isWalletHandle(handle)
          ? `/user-view/${handle.toLowerCase()}`
          : `/user-view/alias/${aliasSegment(handle)}`
        const data = await getJson<unknown>(path)
        return jsonResult(data)
      }),
  )
}
