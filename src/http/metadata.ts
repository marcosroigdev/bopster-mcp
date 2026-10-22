import { BackendHttpError, backendErrors, sendJson } from './client.js'
import { retryAfterSeconds } from './auth.js'
import { ToolInputError } from '../tools/shared.js'

/** The codes the backend's metadata pin uses for metadata that isn't what its template produces. */
const TEMPLATE_DRIFT_CODES = new Set([
  'template_unknown',
  'template_params_invalid',
  'template_param_invalid',
  'template_question_mismatch',
])

/**
 * What to do when a metadata pin fails. This server checks every template before pinning, so a
 * template rejection here means the server and the backend have drifted apart. Say so, with what
 * the backend expected, instead of letting the agent sign in and pin the same thing again.
 */
export function explainPinFailure(error: unknown): unknown {
  if (!(error instanceof BackendHttpError)) return error

  if (error.status === 429) {
    const wait = retryAfterSeconds(error)
    return new ToolInputError(
      `This wallet has pinned too many markets recently. Wait ${wait !== null ? `${wait} seconds` : 'a while'}, ` +
        'then start again from get_login_message.',
    )
  }

  const drift = backendErrors(error).filter((e) => TEMPLATE_DRIFT_CODES.has(String(e.code)))
  if (error.status !== 422 || drift.length === 0) return error

  const details = drift.map((e) => {
    const field = typeof e.context?.field === 'string' ? e.context.field : 'metadata'
    const reason = typeof e.context?.reason === 'string' ? ` (${e.context.reason})` : ''
    const expected = typeof e.context?.expected === 'string' ? `; the backend expects the question "${e.context.expected}"` : ''
    return `${e.code}: ${field}${reason}: ${e.message ?? 'rejected'}${expected}`
  })
  return new ToolInputError(
    "The backend rejected this market's template metadata, which this server had already checked: its templates " +
      "have drifted from the backend's. This is the server's problem, not your input, so retrying or signing again " +
      `won't help. Nothing was created. Report it to the Bopster team. Details: ${details.join(' | ')}`,
  )
}

/** Pins a new market's metadata to IPFS through the backend, with a session from openSession. */
export async function pinMetadata(metadata: Record<string, unknown>, session: string): Promise<string> {
  let pinned: { cid?: unknown; metadataUri?: unknown } | null
  try {
    pinned = await sendJson<{ cid?: unknown; metadataUri?: unknown }>('POST', '/ipfs/metadata', metadata, session)
  } catch (error) {
    throw explainPinFailure(error)
  }
  if (!pinned || typeof pinned.metadataUri !== 'string') throw new Error('The backend pinned no metadata URI.')
  return pinned.metadataUri
}
