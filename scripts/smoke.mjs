import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8788/mcp')
const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(new StreamableHTTPClientTransport(url))

const tools = await client.listTools()
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '))

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.[0]?.text ?? ''
  console.log(`\n--- ${name} (isError=${res.isError ?? false}) ---`)
  console.log(text.slice(0, 500))
}

await call('ping_health')
await call('get_fees')
await call('list_markets', { size: 1, sort_field: 'total_volume', sort_order: 'desc' })

await client.close()
process.exit(0)
