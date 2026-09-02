/**
 * Diagram renderer loader: fetches the lazy DIAGRAM bundle (the mermaid
 * engine) through the injected RPC fetch, evaluates it with the shell-seeded
 * React modules and minimal node-builtin stubs, and caches the exports —
 * the same pattern as renderer-loader.ts, for the separate
 * lib/renderer-diagram.js artifact. Fetched ONLY when a diagram actually
 * renders (.mmd files, ```mermaid fences): the boot client never carries it,
 * and the highlight worker never fetches it (mermaid is DOM-only).
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import type { DiagramRendererExports } from './renderer-contract.ts'

let cached: DiagramRendererExports | null = null
let inflight: Promise<DiagramRendererExports> | null = null

/**
 * Minimal browser stubs for the node builtins a bundled dependency might
 * pull in (mirrors renderer-loader's vfile stubs; the mermaid engine should
 * not need them — kept so a build drift surfaces loudly instead of silently
 * degrading, exactly like the renderer loader's).
 */
function interop<T extends object>(stub: T): T & { default: T } {
  return { ...stub, default: stub }
}

const pathStub = interop({
  sep: '/',
  join: (...parts: string[]): string => parts.filter(part => part !== '').join('/').replace(/\/+/g, '/'),
  basename: (path: string, ext?: string): string => {
    const base = path.split('/').pop() ?? ''
    return ext !== undefined && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  },
  dirname: (path: string): string => {
    const parts = path.split('/')
    parts.pop()
    return parts.join('/') || '.'
  },
  extname: (path: string): string => {
    const base = path.split('/').pop() ?? ''
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(dot) : ''
  },
})

const processStub = interop({ cwd: (): string => '' })

const urlStub = {
  fileURLToPath: (url: string): string => {
    let rest = url.startsWith('file://') ? url.slice('file://'.length) : url
    if (rest.startsWith('/') && /^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1)
    return decodeURIComponent(rest)
  },
  default: null as unknown,
}
urlStub.default = urlStub

/**
 * Get the diagram renderer exports, fetching + evaluating the bundle at most
 * once per page.
 * @param fetchCode - RPC-backed fetch of the diagram bundle source.
 */
export function loadDiagramRenderer(fetchCode: () => Promise<string>): Promise<DiagramRendererExports> {
  if (cached !== null) return Promise.resolve(cached)
  inflight ??= fetchCode().then(code => {
    const run = new Function('module', 'exports', 'require', `${code}\n;return module.exports;`) as (
      module: { exports: unknown },
      exports: unknown,
      require: (name: string) => unknown,
    ) => unknown
    const moduleBox = { exports: {} as unknown }
    const requireShim = (name: string): unknown => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return ReactJsxRuntime
      if (name === 'node:path') return pathStub
      if (name === 'node:process') return processStub
      if (name === 'node:url') return urlStub
      throw new Error(`diagram renderer bundle requires unexpected module ${name}`)
    }
    const result = run(moduleBox, moduleBox.exports, requireShim)
    const exports = (result ?? moduleBox.exports) as { diagramExports?: DiagramRendererExports }
    if (exports.diagramExports === undefined) {
      throw new Error('diagram renderer bundle did not export diagramExports')
    }
    cached = exports.diagramExports
    return cached
  })
  return inflight
}
