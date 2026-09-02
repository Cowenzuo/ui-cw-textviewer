/**
 * ui-cw-textviewer browser half: registers the text viewer dock into the
 * official `shell.overlay` slot (root-level list slot, zero official source
 * changes).
 *
 * The dock is a PURE VIEWER: it implements no file listing of its own. The
 * ui-cw-fileexplorer plugin broadcasts open-file events (cordis event
 * `ui-cw/fileexplorer/file-open`, payload { name, path, root }) when a file
 * row is clicked; this plugin subscribes on the ROOT context (plugin fibers
 * are sibling scopes, and cordis context filtering only matches ancestors of
 * the emitter, so a plain `ctx.on` on this scope would never fire) and feeds
 * the dock through a subscribe handle on the inject face.
 *
 * The dock sits directly LEFT of the ui-cw-fileexplorer dock (it reads that
 * plugin's width variable) and pushes the official UI left through a
 * `#root { margin-right }` stylesheet — the same validated technique, with
 * the combined width so both docks yield the conversation area together.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout) and the
// ctx.locale / ctx.slots Context merges must be in the program for the
// register calls to type; the ui-renderer package now owns the `ctx.slots`
// Context merge. LocaleDict/LocaleId are used below, which also forces the
// locale package's declaration file (and its ctx.locale merge) to load.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import { createTextviewerClient } from './service.ts'
import { TextviewerDock, type TextviewerInjected } from './TextViewerDock.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the slot registry, the locale service, and the wire client. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Cross-plugin open-file protocol: the event name ui-cw-fileexplorer
 * broadcasts when a file row is clicked. Consumers subscribe on the ROOT
 * context — see the module doc for the cordis context-filter reasoning.
 */
export const FILE_OPEN_EVENT = 'ui-cw/fileexplorer/file-open'

/**
 * Reverse-direction sync event: the viewer asks the fileexplorer to SELECT
 * (highlight) a row — used when a history entry is opened. The fileexplorer
 * only honors it when the file is inside ITS current workspace.
 */
export const SELECT_FILE_EVENT = 'ui-cw/textviewer/select-file'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Broadcast by ui-cw-fileexplorer when a file row is clicked. */
    [FILE_OPEN_EVENT]: (file: import('../contract.ts').TextviewerOpenEvent) => void
    /** Broadcast by ui-cw-textviewer to sync the explorer's selection. */
    [SELECT_FILE_EVENT]: (file: { name: string; path: string }) => void
  }
}

/**
 * Browser plugin body: register the text viewer dock into the overlay
 * layer. The registration rides the slot service's effect wrapper, so plugin
 * unload removes the dock; the event subscription lives on the root context
 * and is fiber-owned (auto-disposed on unload).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en } satisfies Record<LocaleId, LocaleDict>), 'textviewer: dictionaries')
  const client = createTextviewerClient(ctx)
  // Listeners waiting for an open-file event; the dock subscribes through
  // the inject face (components never touch ctx).
  const openListeners = new Set<(file: import('../contract.ts').TextviewerOpenEvent) => void>()
  ctx.root.on(FILE_OPEN_EVENT, (file: import('../contract.ts').TextviewerOpenEvent) => {
    for (const listener of openListeners) listener(file)
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'textviewer',
    locale: NS,
    // Last in the overlay layer's DOM order (the fileexplorer dock uses the
    // same order; the two docks never overlap — they stack side by side).
    order: 1000,
    inject: (): TextviewerInjected => ({
      readText: client.readText,
      rendererBundle: async () => {
        const result = await client.renderer(new AbortController().signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.code
      },
      subscribeOpen: (listener) => {
        openListeners.add(listener)
        return () => { openListeners.delete(listener) }
      },
      // Markdown links to LOCAL files re-enter the same open-file protocol
      // the fileexplorer broadcasts (the dock's own subscription picks it up
      // and switches the viewer — no navigation ever leaves the app).
      openFile: (file) => { ctx.emit(FILE_OPEN_EVENT, file) },
      // Selection sync for history opens: the fileexplorer honors it only
      // when the file lies inside its own workspace.
      selectFile: (file) => { ctx.emit(SELECT_FILE_EVENT, file) },
    }),
  }, TextviewerDock))
}
