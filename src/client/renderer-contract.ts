/**
 * Renderer bundle contract: the lazy-loaded heavy renderer (Shiki +
 * react-markdown) exposes exactly this face. Type-only for the main bundle —
 * it never imports the renderer's runtime code.
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
  }): React.JSX.Element
}
