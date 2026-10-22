import type { IsomorphicHeaders } from '@modelcontextprotocol/sdk/types.js'

/**
 * Login messages one client can ask for per minute. A login can pin metadata to IPFS before any
 * transaction and wallets are free, so without a limit one caller could use up the backend's
 * limit for this whole server and lock every other agent out. Each message works once, and an
 * agent only needs one at a time.
 */
export const LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE = 3
const WINDOW_MS = 60_000

const windows = new Map<string, { count: number; resetsAt: number }>()

/**
 * Who is calling. CF-Connecting-IP first, then X-Real-IP. Both are only trustworthy when nginx sets
 * them from the verified client address, as the vhost in resources/ does; a client talking to the
 * server directly could send anything. Over stdio there is one client.
 */
export function clientKey(headers?: IsomorphicHeaders): string {
  const first = (name: string): string | null => {
    const value = headers?.[name]
    const raw = Array.isArray(value) ? value[0] : value
    return raw?.split(',')[0]?.trim() || null
  }
  return first('cf-connecting-ip') ?? first('x-real-ip') ?? (headers ? 'unknown' : 'local')
}

export function takeLoginMessage(
  key: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  for (const [k, window] of windows) {
    if (window.resetsAt <= now) windows.delete(k)
  }

  const window = windows.get(key)
  if (!window) {
    windows.set(key, { count: 1, resetsAt: now + WINDOW_MS })
    return { allowed: true }
  }
  if (window.count < LOGIN_MESSAGES_PER_CLIENT_PER_MINUTE) {
    window.count++
    return { allowed: true }
  }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetsAt - now) / 1000)) }
}

/** Forgets every client. Tests only. */
export function clearLoginLimits(): void {
  windows.clear()
}
