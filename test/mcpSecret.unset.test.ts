/** Without BOPSTER_MCP_SECRET, requests go out with no secret header at all. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.BOPSTER_MCP_SECRET
process.env.BOPSTER_API_URL = 'https://api.bopster.test'

const { config } = await import('../src/config.js')
const { getJson, sendJson } = await import('../src/http/client.js')

describe('no BOPSTER_MCP_SECRET', () => {
  it('sends no secret header', async () => {
    assert.equal(config.mcpSecret, null)

    const sent: (string | null)[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('X-Bopster-Mcp-Secret'))
      return new Response(JSON.stringify({ data: {} }))
    }) as typeof fetch
    await getJson('/markets')
    await sendJson('POST', '/market', {})
    globalThis.fetch = realFetch

    assert.deepEqual(sent, [null, null])
  })
})
