import { USDC_DECIMALS, USDC_SYMBOL } from './config.js'

/**
 * Formats a raw base-unit amount (e.g. USDC with 6 decimals) into a
 * human-readable string like "1.50 USDC". Accepts string | number | bigint.
 */
export function formatTokenAmount(
  raw: string | number | bigint | null | undefined,
  decimals = USDC_DECIMALS,
  symbol = USDC_SYMBOL,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  let value: bigint
  try {
    if (typeof raw === 'number') {
      // Reject values that already lost precision as a JS number.
      if (!Number.isSafeInteger(raw)) return null
      value = BigInt(raw)
    } else {
      value = BigInt(raw)
    }
  } catch {
    return null
  }
  const negative = value < 0n
  const abs = negative ? -value : value
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const fraction = abs % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  const number = fractionStr ? `${whole}.${fractionStr}` : whole.toString()
  return `${negative ? '-' : ''}${number} ${symbol}`
}

/** Converts a unix timestamp (seconds) into an ISO-8601 UTC string. */
export function unixToIsoUtc(seconds: string | number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds === '') return null
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const date = new Date(n * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/**
 * Returns a shallow copy of a market-like record with readable versions of known
 * amount and time fields next to them. Only adds a field when its source is
 * present, and never throws on unexpected shapes.
 */
export function enrichMarket(record: Record<string, unknown>): Record<string, unknown> {
  if (record === null || typeof record !== 'object') return record
  const out: Record<string, unknown> = { ...record }

  const amountFields = ['total_yes', 'total_no', 'total_volume', 'total_pool']
  for (const field of amountFields) {
    if (field in out) {
      const formatted = formatTokenAmount(out[field] as string)
      if (formatted !== null) out[`${field}_formatted`] = formatted
    }
  }

  const timeFields = ['end_time', 'resolve_time']
  for (const field of timeFields) {
    if (field in out) {
      const iso = unixToIsoUtc(out[field] as number)
      if (iso !== null) out[`${field}_iso`] = iso
    }
  }

  return out
}
