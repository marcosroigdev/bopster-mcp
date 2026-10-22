import { BackendHttpError, backendErrors, getJson, NotFoundError, sendJson } from './client.js'
import { ToolInputError } from '../tools/shared.js'

/**
 * Wallet sessions with the Bopster backend. A session only unlocks the metadata pin a new market
 * needs and the wallet's own portfolio; it can't move funds or touch the chain. This server never
 * stores one: each session is opened from a fresh signature and used for the one request that
 * needed it.
 */

export async function getLoginNonce(wallet: string): Promise<{ nonce: string; expiresAt: number | null }> {
  let data: { nonce?: unknown; expiresAt?: unknown }
  try {
    data = await getJson<{ nonce?: unknown; expiresAt?: unknown }>('/auth/wallet/nonce', { address: wallet.toLowerCase() })
  } catch (error) {
    // The backend limits nonces per wallet. Past that, the agent should wait, not retry at once.
    throw explainLoginFailure(error, wallet)
  }
  if (!data || typeof data.nonce !== 'string') throw new Error('The backend returned no login nonce.')
  return { nonce: data.nonce, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null }
}

export async function openSession(wallet: string, nonce: string, signature: string): Promise<string> {
  try {
    const data = await sendJson<{ access_token?: unknown }>('POST', '/auth/wallet/login', {
      address: wallet.toLowerCase(),
      signature,
      nonce,
    })
    if (!data || typeof data.access_token !== 'string') throw new Error('The backend returned no session token.')
    return data.access_token
  } catch (error) {
    throw explainLoginFailure(error, wallet)
  }
}

/** Seconds the backend asks to wait after a 429, from the top of its body or the error's context. */
export function retryAfterSeconds(error: BackendHttpError): number | null {
  const top = (error.body as { retry_after_seconds?: unknown } | null)?.retry_after_seconds
  const inner = backendErrors(error)[0]?.context?.retry_after_seconds
  const seconds = typeof top === 'number' ? top : typeof inner === 'number' ? inner : null
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/**
 * What to do about a failed nonce or login, from the backend's error code. Only a refused
 * signature is worth signing again. A busy backend or an expired nonce needs something else.
 */
export function explainLoginFailure(error: unknown, wallet: string): unknown {
  if (!(error instanceof BackendHttpError)) return error
  const errors = backendErrors(error)
  const code = errors[0]?.code

  if (error.status === 429 || code === 'rate_limit_exceeded') {
    const wait = retryAfterSeconds(error)
    return new ToolInputError(
      `The backend is rate-limiting logins for this wallet. Wait ${wait !== null ? `${wait} seconds` : 'a minute'}, ` +
        'then call get_login_message again and sign the new message.',
    )
  }
  switch (code) {
    case 'invalid_payload': {
      const problems = errors
        .filter((e) => e.code === 'invalid_payload')
        .map((e) => `${String(e.context?.field ?? 'request')}: ${e.message ?? 'malformed'}`)
      return new ToolInputError(
        `The login request was malformed (${problems.join('; ')}). Pass the nonce exactly as get_login_message returned it, ` +
          'and the 0x-prefixed signature personal_sign produced.',
      )
    }
    case 'nonce_not_found':
      return new ToolInputError(
        `That nonce wasn't issued for ${wallet}. Call get_login_message with this same wallet and sign the message it returns.`,
      )
    case 'nonce_expired_or_used':
      return new ToolInputError(
        'That login message has expired or was already used: each nonce works once, until the expiresAt ' +
          'get_login_message returned with it. Call get_login_message for a new one and sign it.',
      )
    case 'invalid_signature':
      return new ToolInputError(
        `The signature doesn't match the login message for ${wallet}. Sign exactly the message get_login_message ` +
          'returned, with personal_sign (EIP-191), from that wallet. Smart wallets must already be deployed ' +
          "(ERC-1271); undeployed ones (ERC-6492) aren't accepted yet.",
      )
  }
  if ([400, 401, 403, 422].includes(error.status)) {
    return new ToolInputError(
      `The backend refused the login (HTTP ${error.status}). Call get_login_message again and sign that exact message ` +
        `with personal_sign (EIP-191) from ${wallet}, before it expires. Each nonce works once.`,
    )
  }
  return error
}

/** The wallet's Bopster profile alias, or null when it has never set one up. */
export async function readProfileAlias(wallet: string): Promise<string | null> {
  try {
    const data = await getJson<{ profile?: { alias?: unknown } | null }>(`/user-view/${wallet.toLowerCase()}`)
    const alias = data?.profile?.alias
    return typeof alias === 'string' && alias.trim() ? alias.trim() : null
  } catch (error) {
    if (error instanceof NotFoundError) return null
    throw error
  }
}
