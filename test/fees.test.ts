import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toFunctionSelector } from 'viem'

import { ChainReadError } from '../src/chain/client.js'
import { bpsToPercent, clearFactoryFeesCache, readFactoryFees } from '../src/chain/factoryFees.js'

const FACTORY = '0x11a2a549286567f7427d990423e5a3560ea16750'

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`
}

describe('bpsToPercent', () => {
  it('keeps fractional percentages', () => {
    assert.equal(bpsToPercent(200), 2)
    assert.equal(bpsToPercent(100), 1)
    assert.equal(bpsToPercent(20), 0.2)
    assert.equal(bpsToPercent(320), 3.2)
  })
})

describe('readFactoryFees', () => {
  const realFetch = globalThis.fetch
  let calls: string[] = []

  // Mainnet values read on 2026-10-08: 2% protocol, 1% creator, 0.2% resolver.
  const onChain: Record<string, bigint> = {
    [toFunctionSelector('protocolFeeBps()')]: 200n,
    [toFunctionSelector('creatorFeeBps()')]: 100n,
    [toFunctionSelector('resolverRewardBps()')]: 20n,
  }

  function answerFromChain() {
    return (async (_url: string, init: RequestInit) => {
      const { id, params } = JSON.parse(String(init.body)) as { id: number; params: [{ data: string }] }
      calls.push(params[0].data)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: word(onChain[params[0].data]) }))
    }) as typeof fetch
  }

  beforeEach(() => {
    calls = []
    clearFactoryFeesCache()
    globalThis.fetch = answerFromChain()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('reads each fee from its own getter', async () => {
    const fees = await readFactoryFees(FACTORY)

    assert.deepEqual(fees, { protocolFeeBps: 200, creatorFeeBps: 100, resolverRewardBps: 20 })
    assert.deepEqual(calls.sort(), Object.keys(onChain).sort())
  })

  it('reads the factory once per process', async () => {
    await readFactoryFees(FACTORY)
    await readFactoryFees(FACTORY)

    assert.equal(calls.length, 3)
  })

  it('retries after a failed read instead of caching the failure', async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'over rate limit' } }))
    }) as typeof fetch

    await assert.rejects(readFactoryFees(FACTORY), ChainReadError)

    globalThis.fetch = answerFromChain()
    assert.equal((await readFactoryFees(FACTORY)).resolverRewardBps, 20)
  })
})
