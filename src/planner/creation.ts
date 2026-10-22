import {
  MATCH_SPORT_DELAYS,
  renderTemplate,
  SHORT_MATCH_DELAY_MINUTES,
  templateErrors,
  type SportsMatch,
  type TemplateInput,
} from './templates.js'

/**
 * The rules a new market has to pass, gathered from the three places that enforce them: the
 * create form on bopster.fun, the backend's metadata pin, and the BopsterFactory contract.
 * Checking them all here, before any signature or transaction, means an agent finds out what's
 * wrong up front instead of from a revert halfway through.
 */

/** BopsterFactory.MIN_MARKET_DURATION / MAX_MARKET_DURATION. */
export const MIN_DURATION_SECONDS = 15 * 60
export const MAX_DURATION_SECONDS = 10 * 24 * 60 * 60

/**
 * Asked-for close times must clear the factory's minimum by this much at the first step, because
 * the question and the market are two transactions apart and the minimum is checked at the second.
 */
export const CREATION_SLACK_SECONDS = 5 * 60

/** The resolution delays the site offers, in minutes: 15 min to 5 days. */
export const RESOLUTION_DELAY_MINUTES = [15, 30, 60, 120, 180, 210, 240, 300, 360, 720, 1440, 2880, 4320, 5760, 7200] as const
export const DEFAULT_RESOLUTION_DELAY_MINUTES = 30

/** The categories the site offers and filters by. Others are allowed, but can't be filtered for. */
export const MARKET_CATEGORIES = [
  'Crypto',
  'Tech',
  'Internet',
  'Business',
  'Entertainment',
  'Sports',
  'Culture',
  'Politics',
  'Science',
  'General',
] as const

export type MarketDraftInput = {
  title: string
  template: TemplateInput
  category: string
  sourceUrl: string
  /** ISO 8601 with an explicit offset, on a whole minute, e.g. "2026-10-12T18:00:00Z". */
  endTime: string
  /** Defaults to 30, or to the sport's delay for a match. */
  resolutionDelayMinutes?: number
  sportsMatch?: SportsMatch
}

export type MarketDraft = {
  title: string
  question: string
  category: string
  sourceUrl: string
  endTime: bigint
  resolveTime: bigint
  templateId: string
  templateVersion: 1
  templateParams: Record<string, unknown>
  warnings: string[]
}

const bytes = (value: string) => new TextEncoder().encode(value).length

function isPrivateHostname(hostname: string): boolean {
  const value = hostname.toLowerCase()
  if (value === 'localhost' || value.endsWith('.local')) return true
  if (value === '127.0.0.1' || value === '0.0.0.0') return true
  if (value.startsWith('10.') || value.startsWith('192.168.')) return true
  if (value.startsWith('172.')) {
    const second = Number(value.split('.')[1])
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true
  }
  return false
}

/** Every reason the draft can't become a market, or the normalized draft when there are none. */
export function validateDraft(input: MarketDraftInput, now: bigint): { errors: string[]; draft: MarketDraft | null } {
  const errors: string[] = [...templateErrors(input.template)]
  const warnings: string[] = []
  const title = input.title.trim()
  const sourceUrl = input.sourceUrl.trim()
  // A known category is stored the way the site spells it, so the category filter finds it.
  const typed = input.category.trim()
  const category = MARKET_CATEGORIES.find((c) => c.toLowerCase() === typed.toLowerCase()) ?? typed

  if (bytes(title) < 2 || bytes(title) > 120) errors.push('title must be 2 to 120 bytes.')
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title)) errors.push('title must be a single line, without line breaks or control characters.')
  if (category.length < 2 || category.length > 24) errors.push('category must be 2 to 24 characters.')

  try {
    const url = new URL(sourceUrl)
    if (!['http:', 'https:'].includes(url.protocol)) errors.push('source_url must start with http:// or https://.')
    else if (isPrivateHostname(url.hostname) || !url.hostname.includes('.')) errors.push('source_url must be a public URL.')
  } catch {
    errors.push('source_url must be a valid URL: the page that will settle the answer.')
  }

  // Match mode, as on the site: a match closes at kick-off and the sport decides the delay.
  let delay = input.resolutionDelayMinutes
  if (category === 'Sports') {
    const match = input.sportsMatch
    if (!match) {
      errors.push('sports_match is required for Sports: the sport for a single match, "other", or "not_a_match".')
    } else if (match !== 'not_a_match') {
      if (input.template.type !== 'event_outcome') errors.push('A match market uses the event_outcome template, e.g. "Real Madrid beat Barcelona".')
      if (match === 'other') {
        if (delay === undefined) errors.push('sports_match "other" needs resolution_delay_minutes: long enough for the match to end.')
        else if (delay < SHORT_MATCH_DELAY_MINUTES) warnings.push(`A ${delay}-minute delay is shorter than almost any match with breaks in it.`)
      } else {
        const sportDelay = MATCH_SPORT_DELAYS[match]
        if (delay !== undefined && delay !== sportDelay) {
          errors.push(`A ${match} match resolves ${sportDelay} minutes after kick-off; leave resolution_delay_minutes out or set it to ${sportDelay}.`)
        }
        delay = sportDelay
      }
    }
  } else if (input.sportsMatch && input.sportsMatch !== 'not_a_match') {
    errors.push('sports_match only applies to the Sports category.')
  }
  delay ??= DEFAULT_RESOLUTION_DELAY_MINUTES

  if (!(RESOLUTION_DELAY_MINUTES as readonly number[]).includes(delay)) {
    errors.push(`resolution_delay_minutes must be one of ${RESOLUTION_DELAY_MINUTES.join(', ')}.`)
  }

  let endTime: bigint | null = null
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(input.endTime.trim())) {
    errors.push('end_time needs an explicit timezone, e.g. "2026-10-12T18:00:00Z".')
  } else {
    const ms = Date.parse(input.endTime)
    if (!Number.isFinite(ms)) errors.push('end_time must be an ISO 8601 date and time.')
    else {
      // The question names the time to the minute, so the market can't close between minutes.
      if (ms % 60_000 !== 0) errors.push('end_time must be on a whole minute (seconds 00).')
      endTime = BigInt(Math.floor(ms / 1000))
    }
  }

  if (endTime !== null) {
    if (endTime < now + BigInt(MIN_DURATION_SECONDS + CREATION_SLACK_SECONDS)) {
      errors.push(
        `end_time must be at least ${(MIN_DURATION_SECONDS + CREATION_SLACK_SECONDS) / 60} minutes from now: the market ` +
          `needs ${MIN_DURATION_SECONDS / 60} minutes of trading, counted when it's launched, a step after this one.`,
      )
    }
    if (endTime > now + BigInt(MAX_DURATION_SECONDS)) errors.push('end_time must be within 10 days from now.')
  }

  if (errors.length > 0 || endTime === null) return { errors, draft: null }

  const resolveTime = endTime + BigInt(delay * 60)
  const rendered = renderTemplate(input.template, resolveTime)
  if (bytes(rendered.question) > 255) {
    return { errors: ['The question comes out over 255 bytes; shorten the template fields.'], draft: null }
  }

  return {
    errors,
    draft: {
      title,
      question: rendered.question,
      category,
      sourceUrl,
      endTime,
      resolveTime,
      templateId: rendered.templateId,
      templateVersion: rendered.templateVersion,
      templateParams: rendered.templateParams,
      warnings,
    },
  }
}

/** The display name rule the site applies when a wallet has no profile alias yet. */
export function creatorNameError(name: string): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9 _-]{2,29}$/.test(name.trim())) return null
  return 'creator_name must be 3 to 30 characters, start with a letter, and use only letters, numbers, spaces, _ or -.'
}

/** Why a draft can no longer be launched at `now`, or null if it still can. Mirrors createMarket(). */
export function launchTimingError(endTime: bigint, resolveTime: bigint, now: bigint): string | null {
  if (endTime >= resolveTime) return 'resolve_time must be after end_time.'
  if (endTime < now + BigInt(MIN_DURATION_SECONDS)) {
    return 'Too late: end_time is now less than 15 minutes away, so the factory would refuse the market. Start over with a later end_time.'
  }
  if (endTime > now + BigInt(MAX_DURATION_SECONDS)) return 'end_time is more than 10 days away.'
  if (resolveTime - endTime > 30n * 24n * 60n * 60n) return 'resolve_time can be at most 30 days after end_time.'
  return null
}

/** The message the backend expects signed (EIP-191 personal_sign) to open a wallet session. */
export function loginMessage(wallet: string, nonce: string): string {
  return `Bopster Fun login\naddress=${wallet.toLowerCase()}\nnonce=${nonce}`
}
