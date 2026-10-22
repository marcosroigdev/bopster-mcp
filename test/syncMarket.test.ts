/**
 * sync_market tells the backend which block the transaction is in, as the site does, so a sync that
 * arrives before that block is safe waits for it instead of scanning without it. Config is read at
 * import, so the environment is set before the modules load.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.BOPSTER_RPC_URL = 'https://rpc.base.test'

const { syncBody, transactionBlock } = await import('../src/tools/syncMarket.js')

const TX = `0x${'ab'.repeat(32)}` as const
let receiptReply: () => Response
const realFetch = globalThis.fetch

before(() => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number }
    const reply = receiptReply()
    if (!reply.ok) return reply
    const { result } = (await reply.json()) as { result: unknown }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

const receipt = (blockNumber: string) => ({
  blockHash: `0x${'11'.repeat(32)}`,
  blockNumber,
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
})

describe('transactionBlock', () => {
  it('reads the block from the receipt', async () => {
    receiptReply = () => new Response(JSON.stringify({ result: receipt('0x2dcac80') }))

    assert.equal(await transactionBlock(TX), 48016512)
  })

  it('is null when the node has no receipt yet', async () => {
    receiptReply = () => new Response(JSON.stringify({ result: null }))

    assert.equal(await transactionBlock(TX), null)
  })

  it('is null when the RPC fails', async () => {
    receiptReply = () => new Response('bad gateway', { status: 502 })

    assert.equal(await transactionBlock(TX), null)
  })
})

describe('syncBody', () => {
  it('sends the block as from_block, next to the hash and the lowercased wallet', () => {
    assert.deepEqual(syncBody(TX, '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', 48016512), {
      tx_hash: TX,
      from_block: 48016512,
      user_address: '0xabcdef0123456789abcdef0123456789abcdef01',
    })
  })

  it('leaves from_block out when the block is unknown', () => {
    assert.deepEqual(syncBody(TX, undefined, null), { tx_hash: TX })
  })
})
