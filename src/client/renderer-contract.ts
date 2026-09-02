/**
 * Lazy renderer bundle contracts: the heavy lazy-loaded bundles expose
 * exactly these faces. Type-only for the main bundle — it never imports the
 * bundles' runtime code.
 */

/** What the renderer bundle factory returns. */
export interface RendererExports {
  /** Lazily-created singleton highlighter (both themes, all v1 langs). */
  getHighlighter(): Promise<import('shiki/core').HighlighterCore>
  /** Shiki output for one code chunk (keeps previous HTML while re-highlighting). */
  HighlightedCode(props: { content: string; lang: string; dark: boolean }): React.JSX.Element
  /** GFM markdown view. */
  MarkdownView(props: {
    content: string
    /**
     * Link-click interceptor: the MAIN bundle decides what a link means
     * (web → new tab, local file → open in the viewer) instead of letting
     * the browser navigate the app away. Called with the raw href and the
     * click event; a handler that does nothing lets the default happen.
     */
    onLinkClick?(href: string, event: React.MouseEvent<HTMLAnchorElement>): void
    /** Active theme (the diagram engine re-renders on flip). */
    dark?: boolean
    /**
     * Optional ```mermaid fence renderer, INJECTED BY THE MAIN BUNDLE (the
     * markdown bundle cannot import the DOM-only mermaid engine). Lazy:
     * the injected component fetches the diagram bundle only when a fence
     * actually exists. Absent → fences render as plain code blocks.
     */
    mermaidFence?: React.ComponentType<MermaidFenceProps>
  }): React.JSX.Element
}

/** One ```mermaid fence handed to the injected renderer. */
export interface MermaidFenceProps {
  /** The fence body (without the ```mermaid markers). */
  source: string
  dark: boolean
  /**
   * What to render when the DIAGRAM ENGINE cannot load at all (bundle
   * failure): the caller supplies the default code-block rendering so the
   * fence's content survives.
   */
  fallback?: React.ReactNode
}

/** Outcome of one mermaid render call. */
export type DiagramRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string }

/** The diagram bundle's public face (pure engine + one React view). */
export interface DiagramRendererExports {
  /** Render one mermaid document to an SVG string (theme-aware). */
  renderDiagram(source: string, dark: boolean): Promise<DiagramRenderResult>
  /** Async diagram view: loading → SVG (previous kept while re-rendering) →
   * error box + raw source. Owns nothing but its own surface. */
  MermaidView(props: {
    source: string
    dark: boolean
    labels?: { loading?: string; error?: string }
  }): React.JSX.Element
}
