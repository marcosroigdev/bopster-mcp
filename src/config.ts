function str(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`)
  }
  if (parsed < min) {
    throw new Error(`Environment variable ${name} must be >= ${min}, got: ${raw}`)
  }
  return parsed
}

/** Base mainnet and Base Sepolia, the two networks Bopster is deployed on. */
export const SUPPORTED_CHAIN_IDS = [8453, 84532] as const
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number]

function chainId(name: string, fallback: SupportedChainId): SupportedChainId {
  const value = int(name, fallback, 1)
  if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(value)) {
    throw new Error(`Environment variable ${name} must be one of ${SUPPORTED_CHAIN_IDS.join(', ')}, got: ${value}`)
  }
  return value as SupportedChainId
}

function address(name: string): string | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`Environment variable ${name} must be a 0x-prefixed EVM address, got: ${raw}`)
  }
  return raw
}

/** The backend's minimum secret length, in bytes. */
export const MIN_MCP_SECRET_BYTES = 32

/**
 * The shared secret the backend recognizes this server by, or null when it's missing or too short
 * for the backend to accept. A short one is dropped rather than sent, since the backend ignores it.
 */
export function resolveMcpSecret(raw: string | undefined): string | null {
  if (!raw) return null
  return Buffer.byteLength(raw, 'utf8') >= MIN_MCP_SECRET_BYTES ? raw : null
}

const rawMcpSecret = process.env.BOPSTER_MCP_SECRET

export const config = {
  apiUrl: str('BOPSTER_API_URL', 'https://api.bopster.fun').replace(/\/$/, ''),
  /**
   * Sent as X-Bopster-Mcp-Secret on every request to apiUrl, and never anywhere else. The backend
   * uses it to rate-limit this server apart from per-IP traffic.
   */
  mcpSecret: resolveMcpSecret(rawMcpSecret),
  httpTimeoutMs: int('BOPSTER_HTTP_TIMEOUT_MS', 10_000, 1),
  mcpPort: int('MCP_PORT', 8788, 1),
  chainId: chainId('BOPSTER_CHAIN_ID', 8453),
  rpcUrl: str('BOPSTER_RPC_URL', 'https://mainnet.base.org'),
  // Fees are read from this contract rather than mirrored in env, so they can't drift from
  // what the markets actually charge. Without it, get_fees reports itself unconfigured.
  factoryAddress: address('BOPSTER_FACTORY_ADDRESS'),
  // The Reality.eth question every Bopster market is built on. Same values the site uses, read off
  // existing mainnet questions: Bopster's arbitrator, a 12 h answer window, no bounty.
  reality: {
    arbitrator: address('BOPSTER_REALITY_ARBITRATOR'),
    timeoutSeconds: int('BOPSTER_REALITY_TIMEOUT_SECONDS', 43_200, 1),
    answerRewardWei: BigInt(int('BOPSTER_REALITY_ANSWER_REWARD_WEI', 0)),
  },
  /**
   * Signs market drafts between prepare_market_question and prepare_market_launch, so only a
   * question this server built from a template can be launched through it. Unset, a random key is
   * made per process: drafts then don't survive a restart.
   */
  draftSecret: process.env.BOPSTER_DRAFT_SECRET || null,
  /** Where market links in tool output point. */
  siteUrl: str('BOPSTER_SITE_URL', 'https://bopster.fun').replace(/\/$/, ''),
} as const

// Once, at startup, and without the values.
if (rawMcpSecret && !config.mcpSecret) {
  console.error(
    `bopster-mcp: BOPSTER_MCP_SECRET is shorter than ${MIN_MCP_SECRET_BYTES} bytes, so it isn't sent. ` +
      'It must match the secret configured on the Bopster API.',
  )
}

/** Below this, a draft secret could be guessed from the drafts every client sees. */
export const MIN_DRAFT_SECRET_BYTES = 32

if (config.draftSecret && Buffer.byteLength(config.draftSecret, 'utf8') < MIN_DRAFT_SECRET_BYTES) {
  console.error(
    `bopster-mcp: BOPSTER_DRAFT_SECRET is shorter than ${MIN_DRAFT_SECRET_BYTES} bytes. Anyone could guess it and ` +
      'launch markets this server never drafted. Generate one with: openssl rand -hex 32',
  )
}

export const USDC_DECIMALS = 6
export const USDC_SYMBOL = 'USDC'

export const SERVER_NAME = 'bopster-mcp'
export const SERVER_VERSION = '0.1.0'
