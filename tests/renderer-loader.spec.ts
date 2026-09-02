/**
 * L4 renderer-bundle test: evaluates the BUILT lib/renderer.js through the
 * real browser loader path (loadRenderer + its require shim — react modules
 * and the node:* stubs) and exercises the exports. This is the regression
 * net for the "no highlighting + load-error hint" failure mode: the shell's
 * module table has NO node:* words and its require throws, so the bundle's
 * vfile-driven node:path/process/url requires used to kill the evaluation.
 *
 * The artifact must exist (pnpm build) — without it the suite skips, which
 * is exactly the publish order (build → test).
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadRenderer } from '../src/client/renderer-loader.ts'

const BUNDLE = resolve('lib', 'renderer.js')

describe('renderer bundle (built artifact)', () => {
  it.skipIf(!existsSync(BUNDLE))('evaluates through the browser require shim and renders', async () => {
    const renderer = await loadRenderer(async () => readFileSync(BUNDLE, 'utf8'))
    expect(renderer.getHighlighter).toBeTypeOf('function')
    expect(renderer.HighlightedCode).toBeTypeOf('function')
    expect(renderer.MarkdownView).toBeTypeOf('function')

    // Shiki: cpp tokens with line spans (the plain surface has neither).
    const html = await renderer.getHighlighter().then(highlighter => highlighter.codeToHtml(
      'int main() { return 0; }', { lang: 'cpp', theme: 'github-dark' },
    ))
    expect(html).toContain('<span class="line">')
    expect(html).toContain('style="')

    // Markdown: GFM table renders — this path exercises vfile, whose
    // node:path/process/url requires are served by the loader's stubs.
    const md = renderToStaticMarkup(React.createElement(
      renderer.MarkdownView, { content: '# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
    ))
    expect(md).toContain('<h1>')
    expect(md).toContain('<table>')

    // ```mermaid fences WITHOUT the injected fence renderer degrade to the
    // default code block (the source survives — nothing silently vanishes).
    const fenced = renderToStaticMarkup(React.createElement(
      renderer.MarkdownView,
      { content: '# T\n\n```mermaid\ngraph TD\nA --> B\n```\n' },
    ))
    expect(fenced).toContain('language-mermaid')
    expect(fenced).toContain('graph TD')

    // WITH the injected fence renderer the fence goes to it (a fake marks
    // the slot); inline code and other fences keep their default shapes.
    const Fence = (props: { source: string; dark: boolean }): React.JSX.Element =>
      React.createElement('div', { 'data-fence': '1' }, `FENCED:${props.source}:${props.dark}`)
    const fenced2 = renderToStaticMarkup(React.createElement(
      renderer.MarkdownView,
      {
        content: '# T\n\n```mermaid\ngraph LR\nA --> B\n```\n\n`inline`',
        dark: true,
        mermaidFence: Fence,
      },
    ))
    expect(fenced2).toContain('data-fence')
    expect(fenced2).toContain('FENCED:graph LR')
    // dark rides through to the fence (the trailing newline of the mdast
    // code value sits between source and the dark marker).
    expect(fenced2).toContain(':true')
  })

  it.skipIf(!existsSync(BUNDLE))('rejects unknown requires loudly (build-drift net)', async () => {
    // A bundle whose requires outgrow the shim must fail the load — never
    // silently degrade. Inject a bundle that requires something else. A
    // FRESH loader instance is needed: the module-level cache already holds
    // the real bundle from the test above.
    vi.resetModules()
    const fresh = await import('../src/client/renderer-loader.ts')
    await expect(fresh.loadRenderer(async () => 'module.exports = {}; require("node:crypto");'))
      .rejects.toThrow(/unexpected module node:crypto/)
  })
})
