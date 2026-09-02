/**
 * Lazy DIAGRAM renderer bundle: the mermaid engine + one async view. Built
 * as its OWN CJS entry (lib/renderer-diagram.js), served through the
 * `renderer-diagram` endpoint, and fetched only when a diagram actually
 * renders — .mmd files or a ```mermaid fence inside markdown.
 *
 * WHY a separate bundle: mermaid is DOM-ONLY. The highlight WORKER evaluates
 * lib/renderer.js with react stubs and no DOM, so the mermaid engine must
 * never ride inside it; keeping it out also spares every non-diagram open
 * from downloading ~2MB.
 *
 * The factory receives `React` from the caller (shell-seeded module table);
 * everything else — the whole mermaid engine — is bundled in here. Evaluated
 * on the MAIN thread only (the loader throws for unknown requires).
 */
import { useEffect, useState } from 'react'
import mermaid from 'mermaid'
import type { DiagramRenderResult } from './renderer-contract.ts'
import css from './TextViewer.module.css'

/** Theme the engine last initialized with (re-initialize only on flip). */
let initializedTheme: 'dark' | 'default' | null = null
/**
 * mermaid.render is not parallel-safe and keeps temp elements per call —
 * every call rides one serial chain, and each call gets a UNIQUE id (a
 * repeated id across sequential renders breaks internal svg references).
 */
let renderChain: Promise<unknown> = Promise.resolve()
let renderCounter = 0

/** The UI font the dsh theme resolves (labels blend with the session). */
function resolvedFontFamily(): string {
  try {
    for (const el of [document.body, document.documentElement]) {
      const font = getComputedStyle(el).getPropertyValue('--ds-font-family').trim()
      if (font !== '') return font
    }
  } catch {
    // No DOM (never on the worker path — the worker never fetches this bundle).
  }
  return 'sans-serif'
}

function initialize(theme: 'dark' | 'default'): void {
  if (initializedTheme === theme) return
  mermaid.initialize({
    startOnLoad: false,
    // strict: diagram labels with HTML/links stay inert — the viewer never
    // binds mermaid's click handlers, so nothing can navigate from a node.
    securityLevel: 'strict',
    theme,
    themeVariables: {
      // Paint NO box of its own: the SVG sits directly on the container's
      // chat-paper surface (bg-base), consistent with the rest of the viewer.
      background: 'transparent',
      fontFamily: resolvedFontFamily(),
    },
  })
  initializedTheme = theme
}

/**
 * Render one mermaid document to an SVG string. Serialized: concurrent
 * renders would interleave inside the engine (each caller drops stale
 * results with its own cancellation flag).
 */
export async function renderDiagram(source: string, dark: boolean): Promise<DiagramRenderResult> {
  const run = async (): Promise<DiagramRenderResult> => {
    try {
      initialize(dark ? 'dark' : 'default')
      const id = `dsh-mmd-${Date.now().toString(36)}-${renderCounter++}`
      const { svg } = await mermaid.render(id, source)
      return { ok: true, svg }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const result = renderChain.then(run, run)
  // The chain never rejects: every link resolves to a DiagramRenderResult.
  renderChain = result.then(() => undefined, () => undefined)
  return result
}

/**
 * The async diagram view: loading placeholder → SVG (the PREVIOUS diagram
 * stays on screen while a re-render runs — no flash on theme flips or chunk
 * appends); a syntax error swaps in an error box with the raw source below
 * (content never disappears).
 *
 * The last successful render is ALSO cached at MODULE level: react-markdown
 * remounts its custom components on re-parse (a fence remount would reset
 * this component's state and flash the loading label), so a remount with an
 * unchanged source+dark starts from the cached SVG instead of a blank
 * loading state.
 */
let lastGood: { source: string; dark: boolean; html: string } | null = null

export function MermaidView(props: {
  source: string
  dark: boolean
  labels?: { loading?: string; error?: string }
}): React.JSX.Element {
  const { source, dark, labels } = props
  const [html, setHtml] = useState<string | null>(() => (
    lastGood !== null && lastGood.source === source && lastGood.dark === dark ? lastGood.html : null
  ))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (source.trim() === '') {
      setHtml(null)
      setError(null)
      setPending(false)
      return
    }
    let cancelled = false
    setPending(true)
    void renderDiagram(source, dark).then(result => {
      if (cancelled) return
      setPending(false)
      if (result.ok) {
        lastGood = { source, dark, html: result.svg }
        setHtml(result.svg)
        setError(null)
      } else {
        setError(result.error)
        setHtml(null)
      }
    })
    return () => { cancelled = true }
  }, [source, dark])

  if (error !== null) {
    return (
      <div className={css.diagramError}>
        <div>{labels?.error ?? 'Mermaid'}: {error}</div>
        <pre className={css.diagramErrorSource}>{source}</pre>
      </div>
    )
  }
  if (html === null) {
    return <div className={css.diagramLoading}>{pending ? (labels?.loading ?? '') : ''}</div>
  }
  return <div className={css.diagram} dangerouslySetInnerHTML={{ __html: html }} />
}

/** The bundle's public face (what the loader reads off module.exports). */
export const diagramExports = { renderDiagram, MermaidView }
