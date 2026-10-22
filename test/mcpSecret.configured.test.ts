/**
 * With a valid BOPSTER_MCP_SECRET, every request to the Bopster API carries it, and nothing else
 * does. Config is read at import, so the environment is set before the modules load.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const SECRET = 's'.repeat(40)
process.env.BOPSTER_MCP_SECRET = SECRET
process.env.BOPSTER_API_URL = 'https://api.bopster.test'
process.env.BOPSTER_RPC_URL = 'https://rpc.base.test'

const { getJson, getJsonWithMetadata, sendJson } = await import('../src/http/client.js')
const { publicClient } = await import('../src/chain/client.js')

const seen: { url: string; headers: Headers }[] = []
const realFetch = globalThis.fetch

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    seen.push({ url, headers: new Headers(init?.headers) })
    if (url.startsWith('https://rpc.base.test')) {
      const { id } = JSON.parse(String(init?.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x10' }))
    }
    return new Response(JSON.stringify({ data: { ok: true } }))
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

describe('the MCP secret header, when configured', () => {
  it('goes with every kind of request to the Bopster API', async () => {
    seen.length = 0
    await getJson('/markets')
    await getJsonWithMetadata('/markets', { page: 1 })
    await sendJson('POST', '/market', { market_id: '0x1' })
    await sendJson('PUT', '/market/0x1', {}, 'session-token')

    assert.equal(seen.length, 4)
    for (const { url, headers } of seen) {
      assert.ok(url.startsWith('https://api.bopster.test/'), url)
      assert.equal(headers.get('X-Bopster-Mcp-Secret'), SECRET)
    }
  })

  it('never goes to the RPC', async () => {
    seen.length = 0
    await publicClient.getBlockNumber({ cacheTime: 0 })

    const rpc = seen.filter(({ url }) => url.startsWith('https://rpc.base.test'))
    assert.ok(rpc.length > 0)
    for (const { headers } of rpc) assert.equal(headers.get('X-Bopster-Mcp-Secret'), null)
  })

  it('never shows up in an error the agent reads', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ code: 'x', message: 'nope' }] }), { status: 400 })) as unknown as typeof fetch

    await assert.rejects(getJson('/markets'), (error: Error) => {
      assert.ok(!error.message.includes(SECRET))
      return true
    })
  })
})
