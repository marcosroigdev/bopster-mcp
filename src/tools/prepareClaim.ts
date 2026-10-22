import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAddress } from 'viem'

import { readMarketState, readToken } from '../chain/marketState.js'
import { planClaim, STATUS_NAMES } from '../planner/market.js'
import {
  marketCalls,
  marketInput,
  money,
  requireBopsterMarket,
  signingInstructions,
  time,
  walletInput,
} from './transactions.js'
import { jsonResult, runTool } from './shared.js'

const OUTCOME_SUMMARIES = {
  claim: 'This wallet backed the winning side and can claim its payout.',
  refund: 'The market pays everyone back their full stake: nobody won, the answer was invalid, or it never settled.',
  already_claimed: 'This wallet has already been paid out from this market.',
  no_position: 'This wallet holds no position in this market.',
  lost: 'This wallet only backed the losing side; there is nothing to claim.',
  rounds_to_zero: "This wallet backed the winning side, but its share of the pool rounds down to zero, which the contract won't pay out.",
  not_ready: 'Nothing can be claimed yet.',
} as const

export function registerPrepareClaim(server: McpServer): void {
  server.registerTool(
    'prepare_claim',
    {
      title: 'Prepare a Bopster claim',
      description:
        "Work out what a wallet can take out of a Bopster market on Base and build the unsigned transactions to do it, in order: settling the market first when it's ready but nobody has (finalize, or the emergency refund path), then claim() or claimRefund(). " +
        "Says why when there's nothing to claim. Non-custodial: this server never holds keys or sends anything.",
      inputSchema: { market: marketInput, wallet: walletInput },
    },
    async (args) =>
      runTool(async () => {
        const address = await requireBopsterMarket(args.market)
        const wallet = getAddress(args.wallet)
        const { market, position } = await readMarketState(address, wallet)
        const token = await readToken()
        const plan = planClaim(market, position!, market.blockTime)

        return jsonResult({
          market: address,
          wallet,
          marketStatus: STATUS_NAMES[market.status] ?? String(market.status),
          outcome: plan.outcome,
          summary: plan.outcome === 'not_ready' ? `${OUTCOME_SUMMARIES.not_ready} ${plan.reason}` : OUTCOME_SUMMARIES[plan.outcome],
          readyAt: plan.outcome === 'not_ready' ? time(plan.until) : null,
          amount: plan.amount > 0n ? money(plan.amount, token) : null,
          position: { yes: money(position!.yes, token), no: money(position!.no, token) },
          transactions: marketCalls(address, plan.calls),
          instructions: plan.calls.length > 0 ? signingInstructions(wallet) : null,
        })
      }),
  )
}
