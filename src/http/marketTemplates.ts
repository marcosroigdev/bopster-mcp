import { BackendUnavailableError, getJson, NotFoundError } from './client.js'
import { ToolInputError } from '../tools/shared.js'

/**
 * The backend's own description of what makes a market's question trustworthy, from
 * GET /market-templates. This server builds questions by itself; this is how it finds out, before
 * creating anything, whether the backend would still trust what it builds.
 */

/** The Reality.eth question the backend expects every template market to be built on. */
export type BackendReality = { template_id: number; arbitrator: string; timeout: number }

export type BackendTemplates = {
  contract_version: number
  templates: unknown[]
  rules: unknown
  reality: BackendReality
}

/** The backend serves the contract with Cache-Control: max-age=300, so it's read that often. */
const TTL_MS = 5 * 60_000

let cached: { value: BackendTemplates | null; expiresAt: number } | null = null

/**
 * The backend's template contract, or null when the backend predates /market-templates (404).
 * Both answers are kept for five minutes.
 */
export async function readMarketTemplates(now: number = Date.now()): Promise<BackendTemplates | null> {
  if (cached && cached.expiresAt > now) return cached.value
  let value: BackendTemplates | null
  try {
    value = await getJson<BackendTemplates>('/market-templates')
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    value = null
  }
  cached = { value, expiresAt: now + TTL_MS }
  return value
}

/** Clears the cached contract. Tests only. */
export function clearMarketTemplatesCache(): void {
  cached = null
}

/** How this server's Reality.eth settings differ from the backend's, one line per setting. */
export function realityMismatches(
  backend: BackendReality,
  ours: { templateId: number; arbitrator: string; timeoutSeconds: number },
): string[] {
  const mismatches: string[] = []
  if (backend.template_id !== ours.templateId) {
    mismatches.push(`Reality template: backend expects ${backend.template_id}, this server asks with ${ours.templateId}`)
  }
  if (String(backend.arbitrator).toLowerCase() !== ours.arbitrator.toLowerCase()) {
    mismatches.push(`arbitrator: backend expects ${backend.arbitrator}, BOPSTER_REALITY_ARBITRATOR is ${ours.arbitrator}`)
  }
  if (backend.timeout !== ours.timeoutSeconds) {
    mismatches.push(`answer window: backend expects ${backend.timeout}s, BOPSTER_REALITY_TIMEOUT_SECONDS is ${ours.timeoutSeconds}s`)
  }
  return mismatches
}

/**
 * Refuses to create anything the backend would score low_trust because this server asks its
 * Reality.eth questions differently. Skipped, with nothing to compare against, on a backend
 * older than /market-templates.
 *
 * `optional` is for the launch step: by then the question was checked when it was drafted, and
 * the chain doesn't need the backend, so a backend that's down costs a warning rather than the
 * launch.
 */
export async function checkRealityAgainstBackend(
  ours: { templateId: number; arbitrator: string; timeoutSeconds: number },
  options: { optional?: boolean } = {},
): Promise<{ warning: string | null }> {
  let contract: BackendTemplates | null
  try {
    contract = await readMarketTemplates()
  } catch (error) {
    if (options.optional && error instanceof BackendUnavailableError) {
      return { warning: "Couldn't reach the backend to recheck its Reality.eth settings; they were checked when this market was drafted." }
    }
    throw error
  }
  if (!contract?.reality) return { warning: null }

  const mismatches = realityMismatches(contract.reality, ours)
  if (mismatches.length > 0) {
    throw new ToolInputError(
      `This server asks Reality.eth questions differently from what the Bopster backend expects (${mismatches.join('; ')}). ` +
        'Markets created like this would be scored low_trust and kept off the site, so nothing was created. ' +
        "This is the server's configuration, not your input: BOPSTER_REALITY_ARBITRATOR and BOPSTER_REALITY_TIMEOUT_SECONDS " +
        'have to be aligned with the backend before markets can be created here.',
    )
  }
  return { warning: null }
}
