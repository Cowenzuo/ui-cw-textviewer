/**
 * L5 fence-stability test (jsdom): a ```mermaid fence must NOT remount when
 * the markdown host re-renders with unchanged props. react-markdown v10
 * re-parses whenever its plugin arrays change identity and each re-parse
 * REPLACES the tree, which remounts custom components — a fence remount
 * resets the diagram state and flashes its loading label (the drag-flicker
 * regression: width-drag re-renders re-fired the whole chain). MarkdownView
 * is memoized against exactly this; this test is the net.
 *
 * The artifact must exist (pnpm build) — otherwise the suite skips (publish
 * order is build → test).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { act } from 'react'
import * as ReactDOM from 'react-dom/client'
import { loadRenderer } from '../src/client/renderer-loader.ts'

const BUNDLE = resolve('lib', 'renderer.js')

function installDom(): void {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Node = dom.window.Node
  globalThis.getComputedStyle = dom.window.getComputedStyle
  globalThis.HTMLElement = dom.window.HTMLElement
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
}

describe('mermaid fence mount stability (built artifact)', () => {
  it.skipIf(!existsSync(BUNDLE))('stays mounted across unchanged-parent re-renders', async () => {
    installDom()
    const renderer = await loadRenderer(async () => readFileSync(BUNDLE, 'utf8'))

    let mounts = 0
    const Fence = React.memo((props: { source: string; dark: boolean }): React.JSX.Element => {
      React.useEffect(() => { mounts += 1 }, [])
      return React.createElement('div', { 'data-fence': '1' }, `len=${props.source.length}`)
    })

    const MD = '# T\n\n```mermaid\ngraph TD\nA --> B\n```\n\ninline text'
    function Host(): React.JSX.Element {
      return React.createElement(renderer.MarkdownView, { content: MD, dark: false, mermaidFence: Fence })
    }

    const container = document.getElementById('root')
    const root = ReactDOM.createRoot(container as HTMLElement)
    await act(async () => { root.render(React.createElement(Host)) })
    // let the async markdown parse settle (parse → setTree → final commit)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 60))
    await act(async () => {})
    expect(mounts).toBe(1)

    // 10 parent re-renders with IDENTICAL props: the memoized MarkdownView
    // must bail out — the fence must NOT remount (was 11 before the memo).
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { root.render(React.createElement(Host)) })
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 60))
    await act(async () => {})
    expect(mounts).toBe(1)

    // A REAL content change may legitimately re-parse (and remount) — but
    // only then: identical text with a fresh string identity must NOT count
    // as a content change for the memo (docContent is useMemo'd upstream).
    const changed = MD.replace('graph TD', 'graph LR')
    await act(async () => { root.render(React.createElement(Host, null)) })
    await act(async () => {
      root.render(React.createElement(
        () => React.createElement(renderer.MarkdownView, { content: changed, dark: false, mermaidFence: Fence }),
      ))
    })
    await new Promise(resolveDelay => setTimeout(resolveDelay, 60))
    await act(async () => {})
    expect(mounts).toBe(2)

    await act(async () => { root.unmount() })
  }, 20_000)
})
