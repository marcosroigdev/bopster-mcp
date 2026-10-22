import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { config } from '../config.js'
import { bpsToPercent, readFactoryFees } from '../chain/factoryFees.js'
import { errorResult, jsonResult, runTool } from './shared.js'

export function registerGetFees(server: McpServer): void {
  server.registerTool(
    'get_fees',
    {
      title: 'Get Bopster market fees',
      description:
        'Return the Bopster market fee split (protocol, creator and resolver) as read live from the ' +
        'BopsterFactory contract on Base. Percentages are of the total market pool. No fees are ' +
        'charged when a market refunds (no positions, or nobody on the winning side).',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        if (!config.factoryAddress) {
          return errorResult(
            'Fees are unavailable: this server has no BopsterFactory address configured (BOPSTER_FACTORY_ADDRESS).',
          )
        }

        const fees = await readFactoryFees(config.factoryAddress)
        const totalFeeBps = fees.protocolFeeBps + fees.creatorFeeBps + fees.resolverRewardBps

        return jsonResult({
          protocolFeePercent: bpsToPercent(fees.protocolFeeBps),
          creatorFeePercent: bpsToPercent(fees.creatorFeeBps),
          resolverRewardPercent: bpsToPercent(fees.resolverRewardBps),
          totalFeePercent: bpsToPercent(totalFeeBps),
          ...fees,
          totalFeeBps,
          factoryAddress: config.factoryAddress,
          note:
            'Read from the BopsterFactory contract on Base. Percentages of the total market pool; ' +
            'not charged when a market refunds.',
        })
      }),
  )
}
