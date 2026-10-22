import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { encodeFunctionData, getAddress, type Address } from 'viem'

import { erc20Abi, marketAbi } from '../chain/abis.js'
import { readFunding, readMarket, readToken, type TokenInfo } from '../chain/marketState.js'
import { positionBlocker, quotePosition, type Side } from '../planner/market.js'
import { describeQuote } from './quotePosition.js'
import {
  amountInput,
  gasFor,
  marketInput,
  money,
  parseAmount,
  requireBopsterMarket,
  sideInput,
  signingInstructions,
  time,
  walletInput,
  type UnsignedTransaction,
} from './transactions.js'
import { jsonResult, runTool, ToolInputError } from './shared.js'

/**
 * An approval for exactly this amount, then the position itself. Never an unlimited approval.
 *
 * Always both, never the position alone on the strength of an allowance read: behind a load-balanced
 * RPC the read can come from a node that hasn't seen the wallet's previous position spend its
 * approval, and a position built on it reverts. An exact approval sent right before the position
 * can't go stale that way, and the position spends all of it, so none is left behind.
 */
export function positionTransactions(options: {
  market: Address
  token: TokenInfo
  side: Side
  amount: bigint
}): UnsignedTransaction[] {
  const { market, token, side, amount } = options
  const position = side === 'YES' ? 'positionYes' : 'positionNo'

  return [
    {
      step: 1,
      action: 'approve',
      description: `Let the market take exactly ${money(amount, token)} from this wallet.`,
      to: token.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [market, amount] }),
      value: '0',
      gas: gasFor('approve'),
    },
    {
      step: 2,
      action: position,
      description: `Take a ${side} position of ${money(amount, token)}.`,
      to: market,
      data: encodeFunctionData({ abi: marketAbi, functionName: position, args: [amount] }),
      value: '0',
      gas: gasFor(position),
    },
  ]
}

export function registerPreparePosition(server: McpServer): void {
  server.registerTool(
    'prepare_position',
    {
      title: 'Prepare a Bopster position',
      description:
        'Build the unsigned transactions to take a YES or NO position on a Bopster market on Base: an exact-amount ' +
        'token approval, then the position. Checks the market is open, is a real Bopster ' +
        'market and that the wallet holds enough. Non-custodial: this server never holds keys or sends anything; the ' +
        "agent's wallet signs and sends the transactions in order.",
      inputSchema: { market: marketInput, side: sideInput, amount: amountInput, wallet: walletInput },
    },
    async (args) =>
      runTool(async () => {
        const address = await requireBopsterMarket(args.market)
        const wallet = getAddress(args.wallet)
        const market = await readMarket(address)
        const token = await readToken()
        const amount = parseAmount(args.amount, token)

        const blocker = positionBlocker(market, market.blockTime)
        if (blocker) throw new ToolInputError(blocker)

        const funding = await readFunding(token.address, wallet)
        if (funding.balance < amount) {
          throw new ToolInputError(
            `${wallet} holds ${money(funding.balance, token)}; this position needs ${money(amount, token)}. ` +
              `Fund the wallet with ${token.symbol} on Base first.`,
          )
        }

        const warnings: string[] = []
        if (funding.gas === 0n) {
          warnings.push('The wallet holds no ETH for gas. Fine if your wallet sponsors gas; otherwise send it a little ETH on Base first.')
        }
        const quote = describeQuote(quotePosition(market, args.side, amount), token)

        return jsonResult({
          market: address,
          wallet,
          closesAt: time(market.endTime),
          transactions: positionTransactions({ market: address, token, side: args.side, amount }),
          quote,
          warnings: [...warnings, ...quote.warnings],
          instructions: signingInstructions(wallet),
        })
      }),
  )
}
