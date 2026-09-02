/**
 * L4 diagram-bundle test: evaluates the BUILT lib/renderer-diagram.js
 * through the real browser loader path (loadDiagramRenderer + its require
 * shim — react routed to the shell-seeded modules). This is the regression
 * net for the mermaid architecture: the engine must stay OUT of
 * lib/renderer.js (the highlight worker evaluates that one with react stubs
 * and no DOM) and evaluate cleanly as its own served artifact.
 *
 * The mermaid engine imports fine without a DOM (verified: only RENDER calls
 * need one), so the bundle evaluation itself is testable in node; calling
 * renderDiagram would need real DOM APIs and stays a browser-only manual
 * check.
 *
 * The artifact must exist (pnpm build) — without it the suite skips, which
 * is exactly the publish order (build → test).
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadDiagramRenderer } from '../src/client/renderer-diagram-loader.ts'

const BUNDLE = resolve('lib', 'renderer-diagram.js')

describe('diagram renderer bundle (built artifact)', () => {
  it.skipIf(!existsSync(BUNDLE))('evaluates through the browser require shim and exposes the engine', async () => {
    const exports = await loadDiagramRenderer(async () => readFileSync(BUNDLE, 'utf8'))
    expect(exports.renderDiagram).toBeTypeOf('function')
    expect(exports.MermaidView).toBeTypeOf('function')
  })

  it.skipIf(!existsSync(BUNDLE))('rejects unknown requires loudly (build-drift net)', async () => {
    // A diagram bundle whose requires outgrow the shim must fail the load —
    // never silently degrade (a fresh loader instance: the module-level cache
    // already holds the real bundle from the test above).
    vi.resetModules()
    const fresh = await import('../src/client/renderer-diagram-loader.ts')
    await expect(fresh.loadDiagramRenderer(async () => 'module.exports = {}; require("node:crypto");'))
      .rejects.toThrow(/unexpected module node:crypto/)
  })
})
