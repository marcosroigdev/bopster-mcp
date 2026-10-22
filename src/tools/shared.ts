import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  BackendHttpError,
  BackendUnavailableError,
  NotFoundError,
} from '../http/client.js'
import { ChainReadError } from '../chain/client.js'

/** A request the agent can fix: the message says what's wrong and what to do instead. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/** Serializes a value as a pretty JSON text tool result. */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

/** Returns an error tool result with a readable message. */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

/** Detects whether a handle is an EVM wallet address (0x + 40 hex chars). */
export function isWalletHandle(handle: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(handle.trim())
}

/** An alias as a URL path segment. "." and ".." would resolve to another path, so they're refused. */
export function aliasSegment(handle: string): string {
  const alias = handle.replace(/^@/, '')
  if (alias === '' || alias === '.' || alias === '..') throw new ToolInputError('Give a wallet address or a Bopster alias.')
  return encodeURIComponent(alias)
}

/**
 * Wraps a tool handler, turning backend errors into friendly tool results
 * instead of throwing raw exceptions at the agent.
 */
export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof NotFoundError) {
      return errorResult('Not found: no Bopster record matches the given parameters.')
    }
    if (error instanceof BackendUnavailableError) {
      return errorResult(`Bopster backend unavailable: ${error.message}`)
    }
    if (error instanceof BackendHttpError) {
      return errorResult(error.message)
    }
    if (error instanceof ChainReadError) {
      return errorResult(`Could not read the Bopster contracts on Base: ${error.message}`)
    }
    if (error instanceof ToolInputError) {
      return errorResult(error.message)
    }
    const reason = error instanceof Error ? error.message : String(error)
    return errorResult(`Unexpected error: ${reason}`)
  }
}
