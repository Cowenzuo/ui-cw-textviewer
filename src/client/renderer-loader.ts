/**
 * Renderer loader: fetches the heavy renderer bundle once (through the
 * injected RPC fetch), evaluates it with the shell-seeded React modules and
 * minimal node-builtin stubs, and caches the exports. The bundle is
 * plugin-served same-origin code, evaluated once per page — the boot client
 * bundle never carries it.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import type { RendererExports } from './renderer-contract.ts'

let cached: RendererExports | null = null
let inflight: Promise<RendererExports> | null = null

/**
 * Minimal browser stubs for the node builtins the renderer bundle pulls in
 * through vfile (react-markdown's VFile class). The shell's module table has
 * NO node:* words and its require THROWS on unknown specifiers, so without
 * these the bundle evaluation dies and the viewer degrades to plain text
 * with the load-error hint. The members mirror vfile's own browser shims
 * (minpath.browser) — only what the bundle actually calls is implemented:
 * path basename/join/dirname/extname/sep, process cwd, url fileURLToPath.
 * The interop shape (`{ ...stub, default: stub }`) satisfies both rolldown's
 * `.default` access and direct member access.
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

const processStub = interop({
  cwd: (): string => '',
})

const urlStub = {
  fileURLToPath: (url: string): string => {
    // file:///C:/a/b → C:/a/b ; file:///a/b → /a/b (vfile accepts both)
    let rest = url.startsWith('file://') ? url.slice('file://'.length) : url
    if (rest.startsWith('/') && /^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1)
    return decodeURIComponent(rest)
  },
  default: null as unknown,
}
urlStub.default = urlStub

/**
 * Get the renderer exports, fetching + evaluating the bundle at most once.
 * @param fetchCode - RPC-backed fetch of the renderer bundle source.
 */
export function loadRenderer(fetchCode: () => Promise<string>): Promise<RendererExports> {
  if (cached !== null) return Promise.resolve(cached)
  inflight ??= fetchCode().then(code => {
    // The bundle is a standard CJS module; wrap it in a Function whose
    // parameters provide module/exports plus a require shim that routes the
    // two React modules to the shell-seeded ones and the node builtins to
    // the stubs above. The shim is complete — the shell's own module table
    // would throw for node:* words (it has none), which is exactly the
    // failure this loader prevents.
    const run = new Function('module', 'exports', 'require', `${code}\n;return module.exports;`) as (
      module: { exports: unknown },
      exports: unknown,
      require: (name: string) => unknown,
    ) => unknown
    const moduleBox = { exports: {} as unknown }
    // Every require the bundle emits is covered above (react ×2 + node ×3,
    // verified against the artifact); anything else is a build drift and
    // must fail loudly instead of quietly degrading the viewer.
    const requireShim = (name: string): unknown => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return ReactJsxRuntime
      if (name === 'node:path') return pathStub
      if (name === 'node:process') return processStub
      if (name === 'node:url') return urlStub
      throw new Error(`renderer bundle requires unexpected module ${name}`)
    }
    const result = run(moduleBox, moduleBox.exports, requireShim)
    const exports = (result ?? moduleBox.exports) as RendererExports
    cached = exports
    return exports
  })
  return inflight
}
