/**
 * Channel mount helper: host a Connection RPC channel as a webServer prefix
 * route registered from this plugin's OWN context.
 *
 * Why not `ctx.connection.rpc.handle`? That harness API's internal
 * `register()` reads `webServer` off the connection service's own context.
 * Under cordis 4.x traceable-proxy semantics, service methods run with their
 * `this.ctx` rebound to the service origin (a shadow) — so that read can
 * never see services the CALLING plugin injected. Out-of-tree plugins
 * therefore hit `cannot get property "webServer" without inject` at boot no
 * matter what their `inject` declares. Mounting the same prefix route from
 * this fiber (which injects `webServer`) keeps the browser wire protocol
 * identical while staying fully plugin-side.
 *
 * The handler mirrors the harness server channel contract (dsh-client-
 * connection `rpc-host`): only POST + application/json, a `client-request`
 * envelope whose `method` equals the URL endpoint, a `server-response`
 * envelope in reply, and the browser-trust fence via
 * `connection.requestRejection`. Only types are imported from the harness —
 * no runtime coupling to `@deepseek-ai/*` packages, so this resolves in any
 * profile without extra peer installs.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'

/** RpcId used when a request envelope carries no usable correlation id. */
const INVALID_REQUEST_RPC_ID = 'invalid-request'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
/** Buffered-body ceiling; channel payloads are small JSON envelopes. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

const TOO_LARGE = Symbol('rpc-body-too-large')

interface RpcEnvelope {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** Structural shape of the host webServer register surface (kept local so no @deepseek-ai/dsh-host-webserver package dependency is needed). */
interface ChannelWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Mount one RPC channel as a webServer prefix route.
 * @param ctx - plugin context; must inject `webServer` and `connection`.
 * @param channel - absolute channel path such as `/textviewer`.
 * @param handler - endpoint handler following the ConnectionRpcHandler contract.
 * @returns the route disposer (removes the prefix route on teardown).
 */
export function registerRpcChannel(
  ctx: Context,
  channel: string,
  handler: ConnectionRpcHandler,
): () => void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`ui-cw: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
  // ctx.webServer is typed by the harness package we deliberately do not
  // depend on; this local structural cast keeps the call type-safe anyway.
  const webServer = (ctx as Context & { webServer: ChannelWebServer }).webServer
  return webServer.register({
    kind: 'prefix',
    path: channel,
    handler: (req, res) => serve(ctx, channel, handler, req, res),
  })
}

async function serve(
  ctx: Context,
  channel: string,
  handler: ConnectionRpcHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Browser-trust fence (Host/Origin checks + browser-session cookie).
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const endpoint = endpointFromPath(channel, pathname)
  if ((req.method ?? 'GET') !== 'POST' || endpoint === undefined) {
    notFound(res)
    return
  }
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    if (error === TOO_LARGE) {
      res.writeHead(413)
      res.end()
      return
    }
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }

  const message = parseEnvelope(body)
  if (!message) {
    writeEnvelope(res, errorEnvelope(rawRpcId(body), 'gateway/bad-request', 'invalid client-request message'))
    return
  }
  if (message.method !== endpoint) {
    writeEnvelope(res, errorEnvelope(
      message.rpcId,
      'gateway/bad-request',
      `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
    ))
    return
  }

  // Client-disconnect detection hangs off the response (see harness bridge).
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  let result: unknown
  try {
    result = await handler(endpoint, message.payload, abort.signal)
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
    return
  }
  writeEnvelope(res, { type: 'server-response', rpcId: message.rpcId, result })
}

function parseEnvelope(body: unknown): RpcEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as { type?: unknown; rpcId?: unknown; method?: unknown }
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') {
    return undefined
  }
  return {
    rpcId: record.rpcId,
    method: record.method,
    payload: (body as { payload?: unknown }).payload,
  }
}

function rawRpcId(body: unknown): string {
  const id = (body as { rpcId?: unknown } | null)?.rpcId
  return typeof id === 'string' ? id : INVALID_REQUEST_RPC_ID
}

function errorEnvelope(rpcId: string, code: string, message: string) {
  return {
    type: 'server-response' as const,
    rpcId,
    result: { ok: false as const, error: { code, message, details: {} } },
  }
}

function writeEnvelope(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse): void {
  res.writeHead(404)
  res.end('not found')
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > MAX_REQUEST_BODY_BYTES) throw TOO_LARGE
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
