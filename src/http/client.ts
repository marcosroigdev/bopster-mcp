import { config } from '../config.js'

export class BackendUnavailableError extends Error {
  constructor(message = 'The Bopster backend is currently unavailable.') {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

export class NotFoundError extends Error {
  constructor(message = 'The requested resource was not found.') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class BackendHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The parsed error body, when the backend sent JSON. */
    public readonly body: unknown = null,
  ) {
    super(message)
    this.name = 'BackendHttpError'
  }
}

/** One entry of the backend's error body, `{ "errors": [{ code, message, context }] }`. */
export type BackendErrorEntry = { code?: string; message?: string; context?: Record<string, unknown> }

/** The error entries the backend sent with a failure, or none when the body had no `errors`. */
export function backendErrors(error: BackendHttpError): BackendErrorEntry[] {
  const errors = (error.body as { errors?: unknown } | null)?.errors
  return Array.isArray(errors) ? errors.filter((e): e is BackendErrorEntry => !!e && typeof e === 'object') : []
}

export type QueryValue = string | number | boolean | undefined | null

/** Header the backend reads the shared secret from. */
export const MCP_SECRET_HEADER = 'X-Bopster-Mcp-Secret'

/**
 * Headers for a request to the Bopster API. Every request built here goes to config.apiUrl, so
 * this is the only place the shared secret is added, and nothing else in this server sends it.
 */
export function apiHeaders(base: Record<string, string>, secret: string | null = config.mcpSecret): Record<string, string> {
  return secret ? { ...base, [MCP_SECRET_HEADER]: secret } : base
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = `${config.apiUrl}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return base
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * One request to the Bopster API, returning the parsed JSON body (null when there is none).
 * Failures carry what the backend said: its `errors` entries ride along on BackendHttpError.body.
 */
async function request(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { query?: Record<string, QueryValue>; body?: Record<string, unknown>; token?: string } = {},
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs)
  const base: Record<string, string> = { accept: 'application/json' }
  if (options.body) base['content-type'] = 'application/json'
  if (options.token) base.authorization = `Bearer ${options.token}`

  let response: Response
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers: apiHeaders(base),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new BackendUnavailableError(`Could not reach the Bopster backend: ${reason}`)
  } finally {
    clearTimeout(timeout)
  }

  const text = await response.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }

  if (response.status === 404) throw new NotFoundError()
  if (response.status >= 500) throw new BackendUnavailableError(`Backend returned ${response.status}.`)
  if (!response.ok) {
    throw new BackendHttpError(response.status, `Backend error ${response.status}: ${text.slice(0, 200)}`, parsed)
  }
  return parsed
}

/**
 * Performs a GET against the Bopster read API and returns the unwrapped body.
 * The backend wraps successful responses in an `{ "data": ... }` envelope. `token` is a wallet
 * session, for the few reads that need one (a wallet's own portfolio).
 */
export async function getJson<T = unknown>(
  path: string,
  query?: Record<string, QueryValue>,
  token?: string,
): Promise<T> {
  return (await getJsonWithMetadata<T>(path, query, token)).data
}

/**
 * Sends JSON to the Bopster API and returns the unwrapped `data`. `token` is a wallet session
 * from /auth/wallet/login, for the few endpoints that need one.
 */
export async function sendJson<T = unknown>(
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const parsed = await request(method, path, { body, token })
  if (parsed && typeof parsed === 'object' && 'data' in parsed) return (parsed as { data: T }).data
  return parsed as T
}

/**
 * Like `getJson`, but also returns the `metadata` the backend sends next to `data` on paginated
 * lists (e.g. `{ pagination: { page, size, total, pages } }`), which `getJson` drops.
 */
export async function getJsonWithMetadata<T = unknown>(
  path: string,
  query?: Record<string, QueryValue>,
  token?: string,
): Promise<{ data: T; metadata: unknown }> {
  const body = (await request('GET', path, { query, token })) as { data?: T } | T | null
  if (body === null) return { data: null as T, metadata: null }
  if (typeof body === 'object' && body !== null && 'data' in body) {
    const envelope = body as { data: T; metadata?: unknown }
    return { data: envelope.data, metadata: envelope.metadata ?? null }
  }
  return { data: body as T, metadata: null }
}
