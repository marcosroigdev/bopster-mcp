import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { marketsQuery, toMarketList } from '../src/tools/listMarkets.js'

describe('marketsQuery', () => {
  // The backend's `creator` matches the creator name in the metadata; the wallet is market_creator.
  // Sent as `creator`, a wallet found nothing, even for a wallet with markets.
  it('sends a creator wallet as market_creator, lowercased, the way the site filters', () => {
    const query = marketsQuery({ creator: ' 0xABCDEF0123456789ABCDEF0123456789ABCDEF01 ', status: 'resolved' })

    assert.deepEqual(query, { status: 'resolved', market_creator: '0xabcdef0123456789abcdef0123456789abcdef01' })
  })

  it('sends a creator name as creator, untouched', () => {
    assert.deepEqual(marketsQuery({ creator: 'MCP Tester' }), { creator: 'MCP Tester' })
  })

  it('passes the other filters through and adds no creator when none is asked for', () => {
    const query = marketsQuery({ category: 'Crypto', sort_field: 'total_volume', sort_order: 'desc', page: 2, size: 5 })

    assert.deepEqual(query, { category: 'Crypto', sort_field: 'total_volume', sort_order: 'desc', page: 2, size: 5 })
  })
})

describe('toMarketList', () => {
  const pagination = { page: 1, size: 2, total: 27, pages: 14 }

  it('keeps the pagination the backend sends next to the list', () => {
    const list = toMarketList([{ total_volume: '15000000' }], { pagination }) as {
      items: Record<string, unknown>[]
      pagination: unknown
    }

    assert.deepEqual(list.pagination, pagination)
  })

  it('enriches each market with readable amounts and times', () => {
    const list = toMarketList([{ total_volume: '15000000', end_time: 1785081600 }], { pagination }) as {
      items: Record<string, unknown>[]
    }

    assert.equal(list.items[0].total_volume_formatted, '15 USDC')
    assert.equal(list.items[0].end_time_iso, '2026-07-26T16:00:00.000Z')
  })

  it('reports no pagination rather than inventing one', () => {
    const list = toMarketList([], null) as { pagination: unknown }

    assert.equal(list.pagination, null)
  })

  it('passes an unexpected shape through untouched', () => {
    assert.deepEqual(toMarketList({ message: 'odd' }, null), { message: 'odd' })
  })
})
