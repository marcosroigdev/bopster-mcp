import { z } from 'zod'

/**
 * The five question templates of the create form on bopster.fun, and the only way this server
 * builds a question. The wording, the UTC date label and the metadata params are the site's own,
 * character for character, so a market made here scores like one made there.
 *
 * The backend only marks a market high_trust when the templateParams pass its rules,
 * metadata.question is exactly the canonical text, deadlineUtc equals the market's resolveTime, and
 * the Reality.eth question has the same text, template 0, the backend's arbitrator and answer window,
 * and opening_ts equal to resolveTime. The backend publishes its template rules on
 * GET /market-templates, and test/templateContract.test.ts holds this file to them.
 */

/** The ticker rule every asset field shares. */
export const TICKER = /^[A-Z0-9]{1,4}$/

/** Length limits of the free-text fields, in UTF-16 code units of the trimmed text. */
export const TEXT_LIMITS = {
  event: { min: 8, max: 180 },
  subject: { min: 8, max: 90 },
  action: { min: 8, max: 90 },
} as const

export const MAX_PERCENTAGE = 100
/** The longest a price may be once written the way the form writes it. */
export const MAX_PRICE_LENGTH = 12

/** What each template's direction reads as in the question. */
export const DIRECTIONS = {
  price_threshold: ['above', 'below'],
  price_change: ['up', 'down'],
  compare_assets: ['higher', 'lower'],
} as const

/** The comparison a price threshold stores in its params, for the word the question uses. */
export const PRICE_OPERATORS = { above: '>=', below: '<=' } as const

export const PRICE_CURRENCY = 'USD'

/** The template already opens the question with "Will" and closes it with "?". */
export const FORBIDDEN_EVENT_PREFIX = /^will\s/i
export const FORBIDDEN_EVENT_SUFFIX = '?'

export const templateInput = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('price_threshold'),
      asset: z.string().describe('Ticker, up to 4 letters: BTC, ETH, AAPL.'),
      direction: z.enum(DIRECTIONS.price_threshold),
      price: z.string().describe('USD price as digits, up to 12 characters: "90000", "0.85".'),
    }),
    z.object({
      type: z.literal('event_outcome'),
      event: z
        .string()
        .describe('What happens, 8 to 180 characters, verb in base form, no leading "Will" and no "?": "Real Madrid beat Barcelona".'),
    }),
    z.object({
      type: z.literal('before_date'),
      subject: z.string().describe('8 to 90 characters: "A spot Solana ETF".'),
      action: z.string().describe('8 to 90 characters, verb in base form: "be approved by the SEC".'),
    }),
    z.object({
      type: z.literal('price_change'),
      asset: z.string().describe('Ticker, up to 4 letters.'),
      direction: z.enum(DIRECTIONS.price_change),
      percentage: z.string().describe('Percent move from the price at market creation, above 0 and at most 100: "10", "2.5".'),
    }),
    z.object({
      type: z.literal('compare_assets'),
      asset_a: z.string().describe('Ticker, up to 4 letters.'),
      direction: z.enum(DIRECTIONS.compare_assets),
      asset_b: z.string().describe('Ticker, up to 4 letters, different from asset_a.'),
    }),
  ])
  .describe('The question, as one of the five Bopster templates. Free-text questions are not accepted.')

export type TemplateInput = z.infer<typeof templateInput>

export type RenderedTemplate = {
  question: string
  templateId: string
  templateVersion: 1
  templateParams: Record<string, unknown>
}

/** "2026-10-12 18:30 UTC", the label the site puts in every template question. */
export function utcLabel(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

const NUMBER = /^\d+(\.\d+)?$/

/**
 * Characters the site's single-line inputs can't produce: line breaks and other control
 * characters, and U+241F, which Reality.eth's template 0 reads as the separator between a
 * question's title, category and language. In the question, it would make the oracle show a
 * different question than the market card.
 */
export const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u241f]/

/** True when the form would write `value` as plain digits, not as 1e-7 or 1e+21. */
const isPlainNumeral = (value: string) => !/e/i.test(String(Number(value.trim())))

/** Every reason the template fields don't pass the create form's checks. Empty when they do. */
export function templateErrors(input: TemplateInput): string[] {
  const errors: string[] = []
  const ticker = (value: string, field: string) => {
    if (!TICKER.test(value.trim().toUpperCase())) errors.push(`${field} must be a ticker of 1 to 4 letters or digits.`)
  }
  const span = (value: string, field: string, min: number, max: number) => {
    const length = value.trim().length
    if (length < min || length > max) errors.push(`${field} must be ${min} to ${max} characters (${length}).`)
    if (FORBIDDEN_TEXT.test(value)) errors.push(`${field} must be a single line of plain text, without line breaks, control characters or "\u241f".`)
  }

  switch (input.type) {
    case 'price_threshold':
      ticker(input.asset, 'asset')
      if (!NUMBER.test(input.price.trim()) || Number(input.price) <= 0) errors.push('price must be a positive number written as digits, e.g. "90000".')
      else if (!isPlainNumeral(input.price)) errors.push('price is too small or too large to write as plain digits.')
      else if (String(Number(input.price.trim())).length > MAX_PRICE_LENGTH) errors.push(`price must be ${MAX_PRICE_LENGTH} characters or fewer.`)
      break
    case 'event_outcome': {
      const event = input.event.trim()
      span(event, 'event', TEXT_LIMITS.event.min, TEXT_LIMITS.event.max)
      if (FORBIDDEN_EVENT_PREFIX.test(event)) errors.push('event must not start with "Will": the template already starts the question.')
      if (event.endsWith(FORBIDDEN_EVENT_SUFFIX)) errors.push('event must not end with "?": the template already closes the question.')
      break
    }
    case 'before_date':
      span(input.subject, 'subject', TEXT_LIMITS.subject.min, TEXT_LIMITS.subject.max)
      span(input.action, 'action', TEXT_LIMITS.action.min, TEXT_LIMITS.action.max)
      break
    case 'price_change': {
      ticker(input.asset, 'asset')
      const pct = Number(input.percentage)
      if (!NUMBER.test(input.percentage.trim()) || pct <= 0) errors.push('percentage must be a positive number, e.g. "10" or "2.5".')
      else if (!isPlainNumeral(input.percentage)) errors.push('percentage is too small to write as plain digits.')
      else if (pct > MAX_PERCENTAGE) errors.push(`percentage must be ${MAX_PERCENTAGE} or less.`)
      break
    }
    case 'compare_assets':
      ticker(input.asset_a, 'asset_a')
      ticker(input.asset_b, 'asset_b')
      if (input.asset_a.trim().toUpperCase() === input.asset_b.trim().toUpperCase()) {
        errors.push('asset_a and asset_b must be different: an asset cannot be compared against itself.')
      }
      break
  }
  return errors
}

/**
 * The question and metadata the site would produce for these fields. `deadline` is when answers
 * open (close time plus the resolution delay), the moment every template question names.
 */
export function renderTemplate(input: TemplateInput, deadline: bigint): RenderedTemplate {
  const label = utcLabel(deadline)
  // The form's price and percentage inputs are type="number", which Vue hands over as numbers:
  // "90000.0" reaches the question as 90000. Same here.
  const numeral = (value: string) => String(Number(value.trim()))
  const deadlineUtc = new Date(Number(deadline) * 1000).toISOString()
  const upper = (value: string) => value.trim().toUpperCase()

  switch (input.type) {
    case 'price_threshold':
      return {
        question: `Will ${upper(input.asset)} be ${input.direction} $${numeral(input.price)} at ${label}?`,
        templateId: 'price_threshold_v1',
        templateVersion: 1,
        templateParams: {
          asset: upper(input.asset),
          operator: PRICE_OPERATORS[input.direction],
          target: Number(input.price),
          currency: PRICE_CURRENCY,
          deadlineUtc,
        },
      }
    case 'event_outcome':
      return {
        question: `Will ${input.event.trim()} before ${label}?`,
        templateId: 'event_outcome_v1',
        templateVersion: 1,
        templateParams: { event: input.event.trim(), deadlineUtc },
      }
    case 'before_date':
      return {
        question: `Will ${input.subject.trim()} ${input.action.trim()} before ${label}?`,
        templateId: 'before_date_v1',
        templateVersion: 1,
        templateParams: { subject: input.subject.trim(), action: input.action.trim(), deadlineUtc },
      }
    case 'price_change':
      return {
        question: `Will ${upper(input.asset)} go ${input.direction} by ${numeral(input.percentage)}% from its market creation before ${label}?`,
        templateId: 'price_change_v1',
        templateVersion: 1,
        templateParams: {
          asset: upper(input.asset),
          direction: input.direction,
          percentage: Number(input.percentage),
          deadlineUtc,
        },
      }
    case 'compare_assets':
      return {
        question: `Will ${upper(input.asset_a)} be ${input.direction} than ${upper(input.asset_b)} at ${label}?`,
        templateId: 'compare_assets_v1',
        templateVersion: 1,
        templateParams: {
          assetA: upper(input.asset_a),
          assetB: upper(input.asset_b),
          direction: input.direction,
          deadlineUtc,
        },
      }
  }
}

/**
 * Sports matches, as the site's match mode handles them: positions close at kick-off and answers
 * open after the final whistle, so the sport sets the resolution delay. Minutes.
 */
export const MATCH_SPORT_DELAYS = {
  football: 180,
  'football-knockout': 240,
  basketball: 180,
  'ice-hockey': 210,
  rugby: 180,
  'american-football-baseball': 240,
  'formula-1': 240,
} as const

export type MatchSport = keyof typeof MATCH_SPORT_DELAYS

export const sportsMatchInput = z
  .enum([...(Object.keys(MATCH_SPORT_DELAYS) as [MatchSport, ...MatchSport[]]), 'other', 'not_a_match'])
  .describe(
    'Required when category is Sports. For a single match, the sport (end_time is then the kick-off, and the sport sets ' +
      'the resolution delay: football 180 min, knockout 240, basketball 180, ice hockey 210, rugby 180, American ' +
      'football/baseball 240, Formula 1 240); "other" for a sport not listed (set the delay yourself); "not_a_match" for ' +
      'transfers, tournaments and the like.',
  )

export type SportsMatch = z.infer<typeof sportsMatchInput>

/** Below this, a match delay is shorter than almost any match with breaks in it. Minutes. */
export const SHORT_MATCH_DELAY_MINUTES = 120
