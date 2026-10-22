import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { config } from '../config.js'
import { getJson } from '../http/client.js'
import { jsonResult, runTool } from './shared.js'

export function registerPingHealth(server: McpServer): void {
  server.registerTool(
    'ping_health',
    {
      title: 'Check Bopster backend health',
      description:
        'Verify that the Bopster read API is reachable and responding. Useful before running other tools.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        const data = await getJson<unknown>('/health')
        return jsonResult({ ok: true, apiUrl: config.apiUrl, health: data })
      }),
  )
}
