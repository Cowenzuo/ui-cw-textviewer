/**
 * Renderer loader: fetches the heavy renderer bundle once (through the
 * injected RPC fetch), evaluates its factory with the shell-seeded React
 * modules, and caches the exports. The bundle is plugin-served same-origin
 * code, evaluated once per page — the boot client bundle never carries it.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import type { RendererExports } from './renderer-contract.ts'

let cached: RendererExports | null = null
let inflight: Promise<RendererExports> | null = null

/**
 * Get the renderer exports, fetching + evaluating the bundle at most once.
 * @param fetchCode - RPC-backed fetch of the renderer bundle source.
 */
export function loadRenderer(fetchCode: () => Promise<string>): Promise<RendererExports> {
  if (cached !== null) return Promise.resolve(cached)
  inflight ??= fetchCode().then(code => {
    // The bundle is a standard CJS module; wrap it in a Function whose
    // parameters provide module/exports plus a require shim that routes the
    // two React modules to the shell-seeded ones (the only true externals).
    // Anything else (e.g. node:process, which some bundled libs reference)
    // falls through to the main bundle's own require — the module table the
    // shell seeded (the same one that satisfies the boot client's requires).
    const run = new Function('module', 'exports', 'require', `${code}\n;return module.exports;`) as (
      module: { exports: unknown },
      exports: unknown,
      require: (name: string) => unknown,
    ) => unknown
    const moduleBox = { exports: {} as unknown }
    const outerRequire = require as (name: string) => unknown
    const requireShim = (name: string): unknown => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return ReactJsxRuntime
      return outerRequire(name)
    }
    const result = run(moduleBox, moduleBox.exports, requireShim)
    const exports = (result ?? moduleBox.exports) as RendererExports
    cached = exports
    return exports
  })
  return inflight
}
