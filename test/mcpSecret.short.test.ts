/** A BOPSTER_MCP_SECRET under 32 bytes is dropped, said once at startup, and never printed. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const SHORT = 'too-short-secret'
process.env.BOPSTER_MCP_SECRET = SHORT
process.env.BOPSTER_API_URL = 'https://api.bopster.test'

const warnings: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
const { config, resolveMcpSecret } = await import('../src/config.js')
const { getJson } = await import('../src/http/client.js')
console.error = realError

describe('a BOPSTER_MCP_SECRET that is too short', () => {
  it('is not used', () => {
    assert.equal(config.mcpSecret, null)
  })

  it('is warned about once, without the value', () => {
    assert.equal(warnings.filter((w) => w.includes('BOPSTER_MCP_SECRET')).length, 1)
    assert.ok(warnings.every((w) => !w.includes(SHORT)))
  })

  it('is not sent', async () => {
    let sent: string | null = 'unset'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers).get('X-Bopster-Mcp-Secret')
      return new Response(JSON.stringify({ data: [] }))
    }) as typeof fetch
    await getJson('/markets')
    globalThis.fetch = realFetch

    assert.equal(sent, null)
  })

  it('counts bytes, like the backend', () => {
    // 31 ASCII bytes fall short; 16 two-byte characters reach 32 bytes in 16 characters.
    assert.equal(resolveMcpSecret('a'.repeat(31)), null)
    assert.equal(resolveMcpSecret('a'.repeat(32)), 'a'.repeat(32))
    assert.equal(resolveMcpSecret('ñ'.repeat(16)), 'ñ'.repeat(16))
  })
})
