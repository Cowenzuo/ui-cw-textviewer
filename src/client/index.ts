/**
 * ui-cw-textviewer browser half: registers the text viewer dock into the
 * official `shell.overlay` slot (root-level list slot, zero official source
 * changes).
 *
 * The dock sits directly LEFT of the ui-cw-fileexplorer dock (it reads that
 * plugin's width variable) and pushes the official UI left through a
 * `#root { margin-right }` stylesheet — the same validated technique, with
 * the combined width so both docks yield the conversation area together.
 * The occupant follows the currently selected session through the global
 * session hooks: clicking any conversation in the sidebar switches the dock
 * to that session's workspace, and with no session selected the dock shows
 * an empty-state hint.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout) and the
// ctx.locale / ctx.slots Context merges must be in the program for the
// register calls to type; the ui-renderer package now owns the `ctx.slots`
// Context merge. LocaleDict/LocaleId are used below, which also forces the
// locale package's declaration file (and its ctx.locale merge) to load.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
// The ui-session package declares the useSessions standard-prop merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import { createTextviewerClient } from './service.ts'
import { TextviewerDock, type TextviewerInjected } from './TextViewerDock.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the slot registry, the locale service, and the wire client. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Browser plugin body: register the text viewer dock into the overlay
 * layer. The registration rides the slot service's effect wrapper, so plugin
 * unload removes the dock.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en } satisfies Record<LocaleId, LocaleDict>), 'textviewer: dictionaries')
  const client = createTextviewerClient(ctx)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'textviewer',
    locale: NS,
    // Last in the overlay layer's DOM order (the fileexplorer dock uses the
    // same order; the two docks never overlap — they stack side by side).
    order: 1000,
    inject: (): TextviewerInjected => ({
      list: client.list,
      readText: client.readText,
      rendererBundle: async () => {
        const result = await client.renderer(new AbortController().signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.code
      },
    }),
  }, TextviewerDock))
}
