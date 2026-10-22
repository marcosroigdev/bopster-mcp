/**
 * get_portfolio against a stand-in backend that, like the real one, shows a portfolio only to its
 * own wallet, signed in. Config is read at import, so the environment is set before the modules load.
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOPSTER_API_URL = 'https://api.bopster.test'

const { readOwnPortfolio } = await import('../src/tools/getPortfolio.js')
const { ToolInputError } = await import('../src/tools/shared.js')

const WALLET = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01'
const NONCE = '5b7c2f0e-1d7a-4b5e-9f3c-2a1b0c9d8e7f'
const SIGNATURE = `0x${'ab'.repeat(65)}`

type Seen = { method: string; path: string; body: unknown; authorization: string | null }
const seen: Seen[] = []
let loginReply: Response
const realFetch = globalThis.fetch

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers)
    seen.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.get('authorization'),
    })
    if (url.pathname === '/auth/wallet/login') return loginReply.clone()
    if (url.pathname === `/portfolio-view/${WALLET.toLowerCase()}`) {
      return headers.get('authorization') === 'Bearer session-abc'
        ? new Response(JSON.stringify({ data: { positions: [{ market: '0xe11d', yes: '800000', no: '400000' }] } }))
        : new Response(JSON.stringify({ errors: [{ code: 'unknown', message: 'Access Denied.' }] }), { status: 403 })
    }
    return new Response(JSON.stringify({ errors: [{ code: 'not_found' }] }), { status: 404 })
  }) as typeof fetch
})

beforeEach(() => {
  seen.length = 0
  loginReply = new Response(JSON.stringify({ data: { access_token: 'session-abc', expires_in: 3600 } }))
})

after(() => {
  globalThis.fetch = realFetch
})

describe('get_portfolio', () => {
  it('logs in with the signature, then reads the portfolio with that session', async () => {
    const portfolio = await readOwnPortfolio(WALLET, NONCE, SIGNATURE)

    assert.deepEqual(portfolio, { positions: [{ market: '0xe11d', yes: '800000', no: '400000' }] })
    assert.deepEqual(
      seen.map((s) => [s.method, s.path, s.authorization]),
      [
        ['POST', '/auth/wallet/login', null],
        ['GET', `/portfolio-view/${WALLET.toLowerCase()}`, 'Bearer session-abc'],
      ],
    )
    assert.deepEqual(seen[0].body, { address: WALLET.toLowerCase(), signature: SIGNATURE, nonce: NONCE })
  })

  it('never reaches the portfolio when the backend refuses the signature, and says how to sign', async () => {
    loginReply = new Response(
      JSON.stringify({ errors: [{ code: 'invalid_signature', message: 'Signature does not match', context: {} }] }),
      { status: 401 },
    )

    await assert.rejects(readOwnPortfolio(WALLET, NONCE, SIGNATURE), (error: unknown) => {
      assert.ok(error instanceof ToolInputError)
      assert.match(error.message, /doesn't match the login message/)
      return true
    })
    assert.deepEqual(seen.map((s) => s.path), ['/auth/wallet/login'])
  })

  it('keeps no session: every read logs in again', async () => {
    await readOwnPortfolio(WALLET, NONCE, SIGNATURE)
    await readOwnPortfolio(WALLET, NONCE, SIGNATURE)

    assert.equal(seen.filter((s) => s.path === '/auth/wallet/login').length, 2)
  })
})
