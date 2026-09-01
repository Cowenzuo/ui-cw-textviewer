/**
 * Textviewer wire client: one thin wrapper over the generic connection RPC
 * channel. Lives in the apply world (constructed with ctx); the view receives
 * the callbacks through the register inject face.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the browser ConnectionHandle face (no Context merge exists on the
// client side — every plugin reaches the handle through ctx.get, this one too).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  TextviewerListing, TextviewerListRequest, TextviewerReadRequest, TextviewerRendererResult, TextviewerSnapshot,
} from '../contract.ts'

/** Callback face the view consumes; plain data and callbacks only. */
export interface TextviewerClient {
  /** List one level of the tree (root when `path` is absent). */
  list(root: string | undefined, path: string | undefined, signal: AbortSignal): Promise<RpcResult<TextviewerListing>>
  /** Read one decoded chunk of a file (`offset` in bytes, host-aligned). */
  readText(root: string, path: string, offset: number, limit: number | undefined, signal: AbortSignal): Promise<RpcResult<TextviewerSnapshot>>
  /** Fetch the lazy renderer bundle source (evaluated once, then cached). */
  renderer(signal: AbortSignal): Promise<RpcResult<TextviewerRendererResult>>
}

/**
 * Build the client over the current connection transport.
 * @param ctx - client root context (apply world only).
 */
export function createTextviewerClient(ctx: Context): TextviewerClient {
  // The single tsconfig hosts both halves, so the node half's Context merge
  // (HostConnectionHandle) shapes ctx.get here; the runtime handle is the
  // browser ConnectionHandle (same service, client-side face).
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  return {
    list: async (root, path, signal) => {
      const payload: TextviewerListRequest = {
        ...(root === undefined ? {} : { root }),
        ...(path === undefined ? {} : { path }),
      }
      const result = await connection.rpc.call('/textviewer', 'list', payload, signal)
      return result as RpcResult<TextviewerListing>
    },
    readText: async (root, path, offset, limit, signal) => {
      const payload: TextviewerReadRequest = {
        root,
        path,
        ...(offset > 0 ? { offset } : {}),
        ...(limit === undefined ? {} : { limit }),
      }
      const result = await connection.rpc.call('/textviewer', 'read-text', payload, signal)
      return result as RpcResult<TextviewerSnapshot>
    },
    renderer: async (signal) => {
      const result = await connection.rpc.call('/textviewer', 'renderer', {}, signal)
      return result as RpcResult<TextviewerRendererResult>
    },
  }
}
