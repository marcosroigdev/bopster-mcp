import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { SERVER_NAME, SERVER_VERSION } from './config.js'
import { registerListMarkets } from './tools/listMarkets.js'
import { registerGetMarket } from './tools/getMarket.js'
import { registerGetLeaderboard } from './tools/getLeaderboard.js'
import { registerGetPortfolio } from './tools/getPortfolio.js'
import { registerGetUserProfile } from './tools/getUserProfile.js'
import { registerGetCreatorProfile } from './tools/getCreatorProfile.js'
import { registerGetFees } from './tools/getFees.js'
import { registerPingHealth } from './tools/pingHealth.js'
import { registerQuotePosition } from './tools/quotePosition.js'
import { registerPreparePosition } from './tools/preparePosition.js'
import { registerPrepareClaim } from './tools/prepareClaim.js'
import { registerPrepareFinalize } from './tools/prepareFinalize.js'
import { registerSyncMarket } from './tools/syncMarket.js'
import {
  registerGetLoginMessage,
  registerPrepareMarketLaunch,
  registerPrepareMarketQuestion,
  registerRegisterMarket,
} from './tools/createMarket.js'

/**
 * Builds the Bopster MCP server: the read tools, plus the prepare_* tools that
 * return unsigned transactions for the agent's own wallet to sign. Nothing here holds keys.
 * A fresh instance is created per stdio process and per stateless HTTP request.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  })

  registerListMarkets(server)
  registerGetMarket(server)
  registerGetLeaderboard(server)
  registerGetPortfolio(server)
  registerGetUserProfile(server)
  registerGetCreatorProfile(server)
  registerGetFees(server)
  registerPingHealth(server)
  registerQuotePosition(server)
  registerPreparePosition(server)
  registerPrepareClaim(server)
  registerPrepareFinalize(server)
  registerSyncMarket(server)
  registerGetLoginMessage(server)
  registerPrepareMarketQuestion(server)
  registerPrepareMarketLaunch(server)
  registerRegisterMarket(server)

  return server
}
