/**
 * The startup check that BOPSTER_RPC_URL returns transaction receipts: market launches,
 * register_market and sync_market read them, and an RPC that refuses them (publicnode's free tier)
 * breaks market creation while every other tool works. Run against a real viem client over a
 * stubbed fetch, so the errors are the ones viem actually raises.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

process.env.BOPSTER_RPC_URL = 'https://rpc.base.test'

const { checkReceipts, describeRpcStatus, rpcHost } = await import('../src/chain/rpcCheck.js')

// An RPC URL with an API key in it, as Alchemy's are: the key must never reach a log or /health.
const RPC_URL = 'https://base.rpc.test/v2/secret-api-key'
const TX = `0x${'ab'.repeat(32)}`
const client = createPublicClient({ chain: base, transport: http(RPC_URL, { retryCount: 0 }) })

let blockTransactions: string[] = [TX]
let receiptReply: () => Response | Promise<Response>
const realFetch = globalThis.fetch

const block = () => ({
  number: '0x10',
  hash: `0x${'12'.repeat(32)}`,
  parentHash: `0x${'13'.repeat(32)}`,
  timestamp: '0x1',
  transactions: blockTransactions,
})
const receipt = {
  blockHash: `0x${'11'.repeat(32)}`,
  blockNumber: '0x10',
  contractAddress: null,
  cumulativeGasUsed: '0x1',
  effectiveGasPrice: '0x1',
  from: `0x${'22'.repeat(20)}`,
  gasUsed: '0x1',
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status: '0x1',
  to: `0x${'33'.repeat(20)}`,
  transactionHash: TX,
  transactionIndex: '0x0',
  type: '0x2',
}
const rpcError = (code: number, message: string) => () => new Response(JSON.stringify({ error: { code, message } }))

before(() => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string }
    const reply = method === 'eth_getBlockByNumber' ? new Response(JSON.stringify({ result: block() })) : await receiptReply()
    if (!reply.ok) return reply
    const body = (await reply.json()) as Record<string, unknown>
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }))
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

describe('checkReceipts', () => {
  it('is ok when the RPC returns the receipt of a transaction in its latest block', async () => {
    blockTransactions = [TX]
    receiptReply = () => new Response(JSON.stringify({ result: receipt }))

    assert.deepEqual(await checkReceipts(client, RPC_URL), { host: 'base.rpc.test', receipts: 'ok' })
  })

  it("is refused when the RPC turns receipts down, as publicnode's free tier does", async () => {
    blockTransactions = [TX]
    receiptReply = rpcError(-32602, 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode')

    const status = await checkReceipts(client, RPC_URL)
    assert.equal(status.receipts, 'refused')
    assert.match('detail' in status ? status.detail : '', /Archive requests require a personal token/)
    assert.match(describeRpcStatus(status), /prepare_market_launch and register_market will fail/)
  })

  it("is unchecked, not refused, when the RPC is only rate-limiting, down, or hasn't the receipt yet", async () => {
    blockTransactions = [TX]
    for (const reply of [
      () => new Response('too many requests', { status: 429 }),
      rpcError(-32016, 'over rate limit'),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response(JSON.stringify({ result: null })),
    ]) {
      receiptReply = reply
      assert.equal((await checkReceipts(client, RPC_URL)).receipts, 'unchecked')
    }
  })

  it('is unchecked when the latest block has no transaction to try', async () => {
    blockTransactions = []

    assert.equal((await checkReceipts(client, RPC_URL)).receipts, 'unchecked')
  })

  it('never shows the RPC URL past its host', async () => {
    blockTransactions = [TX]
    for (const reply of [rpcError(-32602, 'Archive requests require a personal token.'), () => new Response('down', { status: 503 })]) {
      receiptReply = reply
      const status = await checkReceipts(client, RPC_URL)
      assert.doesNotMatch(JSON.stringify(status), /secret-api-key/)
      assert.doesNotMatch(describeRpcStatus(status), /secret-api-key/)
    }
  })
})

describe('rpcHost', () => {
  it('keeps only the host', () => {
    assert.equal(rpcHost('https://base-mainnet.g.alchemy.com/v2/abc123'), 'base-mainnet.g.alchemy.com')
    assert.equal(rpcHost('not a url'), 'the configured RPC')
  })
})
