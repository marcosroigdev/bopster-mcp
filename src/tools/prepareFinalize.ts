import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { readMarket, readToken } from '../chain/marketState.js'
import { settlementPath, STATUS_NAMES } from '../planner/market.js'
import { marketCalls, marketInput, money, requireBopsterMarket, signingInstructions, time } from './transactions.js'
import { jsonResult, runTool } from './shared.js'

export function registerPrepareFinalize(server: McpServer): void {
  server.registerTool(
    'prepare_finalize',
    {
      title: 'Prepare to settle a Bopster market',
      description:
        'Check whether a Bopster market on Base can be settled now and build the unsigned transaction(s) to do it. ' +
        'Anyone can settle a market once its Reality.eth answer is final; the sender earns the resolver reward when ' +
        'the market has winners. Also covers the emergency refund path for markets whose answer never became final. ' +
        'Non-custodial: this server never holds keys or sends anything.',
      inputSchema: { market: marketInput },
    },
    async (args) =>
      runTool(async () => {
        const address = await requireBopsterMarket(args.market)
        const market = await readMarket(address)
        const token = await readToken()
        const path = settlementPath(market, market.blockTime)

        const base = { market: address, marketStatus: STATUS_NAMES[market.status] ?? String(market.status) }

        if (path.state === 'settled') {
          return jsonResult({ ...base, state: 'settled', summary: 'Already settled. Holders can claim with prepare_claim.', transactions: [] })
        }
        if (path.state === 'waiting') {
          return jsonResult({ ...base, state: 'waiting', summary: path.reason, readyAt: time(path.until), transactions: [] })
        }

        const reward = path.resolution.refund ? 0n : path.resolution.resolverReward
        return jsonResult({
          ...base,
          state: 'ready',
          summary: path.resolution.refund
            ? 'Ready to settle as a refund: everyone gets their stake back and no fees or reward are paid.'
            : `Ready to settle: ${path.resolution.outcomeYes ? 'YES' : 'NO'} won.`,
          resolverReward: money(reward, token),
          transactions: marketCalls(address, path.calls),
          instructions: signingInstructions(null),
        })
      }),
  )
}
