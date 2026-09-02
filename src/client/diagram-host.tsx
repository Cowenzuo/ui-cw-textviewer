/**
 * DiagramHost: the MAIN bundle's lazy host for the diagram engine (bundle B,
 * lib/renderer-diagram.js). Fetches + evaluates the mermaid bundle on first
 * mount — i.e. only when a diagram actually renders: an .mmd file pane or a
 * ```mermaid fence inside markdown (the markdown bundle cannot import the
 * DOM-only engine itself, so the fence renderer is injected from here).
 *
 * Failure is graceful: the caller's `fallback` (usually the plain code block
 * of the diagram source) replaces the pane, so content never disappears.
 */
import { useEffect, useState } from 'react'
import type { DiagramRendererExports, MermaidFenceProps } from './renderer-contract.ts'
import { loadDiagramRenderer } from './renderer-diagram-loader.ts'
import css from './TextViewer.module.css'

/** RPC-backed fetch of the diagram bundle source. */
export type DiagramBundleFetcher = () => Promise<string>

/** Props both hosts (the .mmd pane and the markdown fence) share. */
export interface DiagramHostProps {
  source: string
  dark: boolean
  /** Fetch the diagram bundle source (RPC). */
  fetchCode: DiagramBundleFetcher
  labels?: { loading?: string; error?: string }
  /** Rendered while the engine loads (keeps the layout stable). */
  loading?: React.ReactNode
  /** Rendered when the engine cannot load at all (content survives). */
  fallback: React.ReactNode
}

/**
 * Mount the diagram engine lazily and render the diagram. The engine fetch
 * itself is cached module-wide (renderer-diagram-loader); this component
 * only tracks the per-site state.
 */
export function DiagramHost(props: DiagramHostProps): React.JSX.Element {
  const { source, dark, fetchCode, labels, loading, fallback } = props
  const [exports, setExports] = useState<DiagramRendererExports | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadDiagramRenderer(fetchCode)
      .then(loaded => { if (!cancelled) setExports(loaded) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
    // The fetcher identity is stable (inject face); the engine is per-page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) return <>{fallback}</>
  if (exports === null) {
    return <div className={css.diagramLoading}>{loading}</div>
  }
  return <exports.MermaidView source={source} dark={dark} labels={labels} />
}

/**
 * The ```mermaid fence renderer handed to MarkdownView: a DiagramHost whose
 * fallback is the fence's plain code block (the markdown bundle supplies it,
 * so styles and content stay inside the markdown surface).
 */
export function MermaidFenceHost(props: MermaidFenceProps & { fetchCode: DiagramBundleFetcher; labels?: DiagramHostProps['labels'] }): React.JSX.Element {
  const { source, dark, fallback, fetchCode, labels } = props
  return (
    <DiagramHost
      source={source}
      dark={dark}
      fetchCode={fetchCode}
      labels={labels}
      fallback={fallback ?? <pre className={css.mdFenceFallback}><code>{source}</code></pre>}
    />
  )
}
