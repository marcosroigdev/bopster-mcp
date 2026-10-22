import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAddress } from 'viem'

import { openSession } from '../http/auth.js'
import { getJson } from '../http/client.js'
import { jsonResult, runTool } from './shared.js'

const inputSchema = {
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a 0x-prefixed EVM wallet address.')
    .describe('The wallet whose portfolio to fetch (0x...). It must be the wallet that signed the login message.'),
  nonce: z.string().min(1).describe('The nonce get_login_message returned for this wallet.'),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'A 0x-prefixed hex signature.')
    .describe('The personal_sign signature of that login message, from this wallet.'),
}

/**
 * The backend shows a portfolio only to its own wallet, signed in. So this opens a session from a
 * fresh login signature, reads the portfolio with it and drops it, as the market pin does. Never
 * kept: a session remembered per wallet would show that portfolio to anyone who named the wallet.
 */
export async function readOwnPortfolio(wallet: string, nonce: string, signature: string): Promise<unknown> {
  const address = getAddress(wallet)
  const session = await openSession(address, nonce, signature)

  return getJson<unknown>(`/portfolio-view/${address.toLowerCase()}`, undefined, session)
}

export function registerGetPortfolio(server: McpServer): void {
  server.registerTool(
    'get_portfolio',
    {
      title: 'Get a wallet portfolio',
      description:
        "Fetch the Bopster portfolio of a wallet you control: its open positions across markets, claimable rewards " +
        'and refunds. Amounts are USDC base units (6 decimals). The backend shows a portfolio only to its own wallet, ' +
        'so this needs a login: call get_login_message for the wallet, sign the message with personal_sign, then pass ' +
        "wallet, nonce and signature here. Each signature works once. The session can't move funds and isn't kept.",
      inputSchema,
    },
    async (args) =>
      runTool(async () => jsonResult(await readOwnPortfolio(args.wallet, args.nonce, args.signature))),
  )
}
