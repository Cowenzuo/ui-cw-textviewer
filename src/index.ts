/**
 * ui-cw-textviewer node half: serves the /textviewer RPC channel.
 *
 * The channel is mounted by `registerRpcChannel` (./channel.ts) as a
 * webServer prefix route from this plugin's own context — deliberately NOT
 * via `ctx.connection.rpc.handle`, whose internal webServer access cannot
 * resolve for out-of-tree plugins under the current cordis inject model.
 * The wire protocol (envelopes + browser-trust fence) is identical to the
 * harness channel contract, and the browser half calls through
 * `ctx.connection.rpc.call` unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: HostConnectionService lives in rpc-host.ts, the same module that
// declares the ctx.connection Context merge — referencing it forces that
// declaration file into the program, so `ctx.connection` typechecks.
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createTextviewerHandler } from './handler.ts'
import { registerRpcChannel } from './channel.ts'

/** Services required before activation: Connection (fence) and the webServer the channel mounts onto. */
export const inject = ['connection', 'webServer']

/** Node half body. */
export function apply(ctx: Context): void {
  ctx.effect(() => registerRpcChannel(
    ctx,
    '/textviewer',
    createTextviewerHandler(),
  ), 'ui-cw-textviewer: /textviewer channel')
}
