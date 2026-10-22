import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkRealityAgainstBackend,
  clearMarketTemplatesCache,
  readMarketTemplates,
  realityMismatches,
} from '../src/http/marketTemplates.js'
import { BackendUnavailableError } from '../src/http/client.js'
import { ToolInputError } from '../src/tools/shared.js'

const MAINNET_ARBITRATOR = '0xcB4B48d2A7a44247A00048963F169d2b4Ab045a6'
const ours = { templateId: 0, arbitrator: MAINNET_ARBITRATOR, timeoutSeconds: 43_200 }

function contract(reality: Record<string, unknown>) {
  return { data: { contract_version: 1, templates: [], rules: {}, reality } }
}

describe('realityMismatches', () => {
  it('finds none when template, arbitrator (in any case) and timeout agree', () => {
    assert.deepEqual(realityMismatches({ template_id: 0, arbitrator: MAINNET_ARBITRATOR.toLowerCase(), timeout: 43_200 }, ours), [])
  })

  it('names every setting that differs', () => {
    const mismatches = realityMismatches({ template_id: 2, arbitrator: '0xfb0d534131a38a3be787ed143e1028b61bc3f7c9', timeout: 86_400 }, ours)
    assert.equal(mismatches.length, 3)
    assert.match(mismatches.join(' '), /BOPSTER_REALITY_ARBITRATOR/)
    assert.match(mismatches.join(' '), /BOPSTER_REALITY_TIMEOUT_SECONDS/)
  })
})

describe('checking against the backend', () => {
  const realFetch = globalThis.fetch
  let calls = 0
  let respond: () => Response

  beforeEach(() => {
    calls = 0
    clearMarketTemplatesCache()
    globalThis.fetch = (async () => {
      calls++
      return respond()
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('lets creation go ahead when the backend expects the same question', async () => {
    respond = () => new Response(JSON.stringify(contract({ template_id: 0, arbitrator: MAINNET_ARBITRATOR.toLowerCase(), timeout: 43_200 })))
    assert.deepEqual(await checkRealityAgainstBackend(ours), { warning: null })
  })

  it('refuses, saying the markets would be low_trust, when the backend expects another arbitrator', async () => {
    respond = () => new Response(JSON.stringify(contract({ template_id: 0, arbitrator: '0xfb0d534131a38a3be787ed143e1028b61bc3f7c9', timeout: 43_200 })))
    await assert.rejects(checkRealityAgainstBackend(ours), (error: Error) => {
      assert.ok(error instanceof ToolInputError)
      assert.match(error.message, /low_trust/)
      assert.match(error.message, /BOPSTER_REALITY_ARBITRATOR/)
      assert.match(error.message, /nothing was created/)
      return true
    })
  })

  it('skips the check on a backend that predates /market-templates', async () => {
    respond = () => new Response(JSON.stringify({ errors: [{ code: 'unknown', message: 'No route found' }] }), { status: 404 })
    assert.deepEqual(await checkRealityAgainstBackend(ours), { warning: null })
  })

  it('reads the contract once per five minutes, like the backend says to cache it', async () => {
    respond = () => new Response(JSON.stringify(contract({ template_id: 0, arbitrator: MAINNET_ARBITRATOR, timeout: 43_200 })))
    const start = Date.now()
    await readMarketTemplates(start)
    await readMarketTemplates(start + 4 * 60_000)
    assert.equal(calls, 1)
    await readMarketTemplates(start + 5 * 60_000 + 1)
    assert.equal(calls, 2)
  })

  it('still needs the backend when drafting', async () => {
    respond = () => new Response('', { status: 503 })
    await assert.rejects(checkRealityAgainstBackend(ours), BackendUnavailableError)
  })

  it('only warns at launch when the backend is down', async () => {
    respond = () => new Response('', { status: 503 })
    const result = await checkRealityAgainstBackend(ours, { optional: true })
    assert.match(result.warning ?? '', /checked when this market was drafted/)
  })
})
