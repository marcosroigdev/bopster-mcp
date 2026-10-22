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

export function registerGetCreatorProfile(server: McpServer): void {
  server.registerTool(
    'get_creator_profile',
    {
      title: 'Get a Bopster creator profile',
      description:
        'Fetch a public creator profile on Bopster: alias, avatar, verified badge and creator stats. ' +
        'Accepts either a wallet address or an alias.',
      inputSchema,
    },
    async (args) =>
      runTool(async () => {
        const handle = args.handle.trim()
        const path = isWalletHandle(handle)
          ? `/creator-profile-view/${handle.toLowerCase()}`
          : `/creator-profile-view/alias/${aliasSegment(handle)}`
        const data = await getJson<unknown>(path)
        return jsonResult(data)
      }),
  )
}
