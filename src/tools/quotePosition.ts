import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { readMarket, readToken, type TokenInfo } from '../chain/marketState.js'
import { positionBlocker, quotePosition, type PositionQuote } from '../planner/market.js'
import {
  amountInput,
  marketInput,
  money,
  parseAmount,
  requireBopsterMarket,
  sideInput,
  time,
} from './transactions.js'
import { jsonResult, runTool, ToolInputError } from './shared.js'

/** The quote as an agent reads it, with the caveats that decide whether it means anything. */
export function describeQuote(quote: PositionQuote, token: TokenInfo) {
  const warnings: string[] = []
  if (quote.otherSide === 0n) {
    warnings.push(
      `Nobody holds the ${quote.side === 'YES' ? 'NO' : 'YES'} side yet. If it stays that way and ${quote.side} wins, ` +
        `the payout is your stake minus ${quote.totalFeeBps / 100}% in fees; if ${quote.side} loses, everyone is refunded in full.`,
    )
  }
  return {
    side: quote.side,
    amount: money(quote.amount, token),
    payoutIfWins: money(quote.payoutIfWins, token),
    multiplierIfWins: quote.amount === 0n ? null : Number((quote.payoutIfWins * 10_000n) / quote.amount) / 10_000,
    poolAfter: money(quote.poolAfter, token),
    sideAfter: money(quote.sideAfter, token),
    otherSide: money(quote.otherSide, token),
    totalFeePercent: quote.totalFeeBps / 100,
    basis:
      'Parimutuel: winners split the whole pool, after fees, in proportion to stake. This assumes the pools stay as ' +
      'they are until close; every later position on either side changes the payout.',
    warnings,
  }
}

export function registerQuotePosition(server: McpServer): void {
  server.registerTool(
    'quote_position',
    {
      title: 'Quote a Bopster position',
      description:
        'Estimate what a YES or NO position of a given size would pay on a Bopster market if its side wins, read from ' +
        'the market contract on Base. Read-only: builds no transaction. Payouts are parimutuel, so the estimate moves ' +
        'with every later position.',
      inputSchema: { market: marketInput, side: sideInput, amount: amountInput },
    },
    async (args) =>
      runTool(async () => {
        const address = await requireBopsterMarket(args.market)
        const market = await readMarket(address)
        const token = await readToken()
        const amount = parseAmount(args.amount, token)

        const blocker = positionBlocker(market, market.blockTime)
        if (blocker) throw new ToolInputError(blocker)

        return jsonResult({
          market: address,
          closesAt: time(market.endTime),
          ...describeQuote(quotePosition(market, args.side, amount), token),
        })
      }),
  )
}
