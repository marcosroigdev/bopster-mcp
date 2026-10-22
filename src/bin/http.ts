#!/usr/bin/env node
import express, { type NextFunction, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { checkRpcAtStartup, rpcStatus } from '../chain/rpcCheck.js'
import { config, SERVER_NAME, SERVER_VERSION } from '../config.js'
import { createServer } from '../index.js'

const app = express()
app.use(express.json({ limit: '256kb' }))

// Liveness/readiness probe for Docker and the host reverse proxy. `rpc.receipts` is "refused" when
// BOPSTER_RPC_URL can't serve market creation; it stays a 200 so Docker doesn't restart the server
// over a setting a restart can't fix.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, apiUrl: config.apiUrl, rpc: rpcStatus() })
})

// Stateless Streamable HTTP: a fresh server + transport per request.
// No sessions to track, which scales trivially behind a reverse proxy.
app.post('/mcp', async (req: Request, res: Response) => {
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    transport.close()
    server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    console.error('bopster-mcp: request error', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      })
    }
  }
})

// GET/DELETE on /mcp are only meaningful for stateful sessions, which we don't use.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST /mcp.' },
    id: null,
  })
}
app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

// Turn body-parser / oversized-payload errors into a JSON-RPC error shape
// instead of Express's default HTML page. Must be the last middleware.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err)
  const status = (err as { status?: number }).status ?? 400
  const message =
    (err as { type?: string }).type === 'entity.too.large'
      ? 'Request body too large.'
      : 'Invalid JSON-RPC request body.'
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32700, message },
    id: null,
  })
})

const httpServer = app.listen(config.mcpPort, '0.0.0.0', () => {
  console.error(`bopster-mcp: HTTP transport listening on :${config.mcpPort} (POST /mcp), backend ${config.apiUrl}`)
  void checkRpcAtStartup()
})

function shutdown(signal: string): void {
  console.error(`bopster-mcp: received ${signal}, shutting down`)
  httpServer.close(() => process.exit(0))
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
