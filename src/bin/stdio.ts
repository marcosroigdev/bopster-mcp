#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { checkRpcAtStartup } from '../chain/rpcCheck.js'
import { createServer } from '../index.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Logs go to stderr: stdout is the MCP protocol channel.
  console.error('bopster-mcp: stdio transport ready')
  void checkRpcAtStartup()
}

main().catch((error) => {
  console.error('bopster-mcp: fatal error', error)
  process.exit(1)
})
