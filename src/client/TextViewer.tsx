/**
 * TextViewer: the dock's preview region — a per-extension renderer registry
 * over one lazily chunked text stream.
 *
 * v1 registry:
 * - `.md/.markdown/.mdx` → markdown view (GFM), provided by the LAZY renderer
 *   bundle (react-markdown)
 * - code extensions (cpp/hpp, yaml, ts, py, …) → Shiki (TextMate grammars,
 *   VS Code-quality tokens, line numbers via a CSS counter), also from the
 *   lazy renderer bundle
 * - everything else → plain pre (wrap-free, horizontal scroll)
 *
 * The renderer bundle (lib/renderer.js) is served by the host through the
 * `renderer` endpoint and evaluated on first use — the boot bundle stays
 * light. Until it loads, the region shows the loading state; a bundle
 * failure degrades code/markdown files to plain text with an error line.
 *
 * The stream: read-text serves byte chunks (host-aligned, encoding-detected
 * BOM/UTF-8/GBK); the region appends chunks as the user scrolls toward the
 * end of the loaded content, capped at a preview bound.
 *
 * BIG-FILE STRATEGY (append-only, no teleporting):
 * - The scroll position is NEVER force-pinned for a mere near-bottom scroll:
 *   appending below the viewport keeps the visible lines in place, and the
 *   chain stops on its own once the new bottom is out of reach — scrolling
 *   resumes it. Only a user PINNED at the exact bottom edge rides a
 *   continuous stream (log-viewer style) and can leave it any time by
 *   scrolling up.
 * - Plain text appends through an imperative text node (one pre, its old
 *   text never rewritten — React cannot touch what it did not render).
 * - Code renders ONE highlighted block PER CHUNK: each chunk highlights only
 *   itself (linear total cost instead of re-highlighting everything per
 *   append), the CSS line counter lives on the shared container so numbers
 *   stay continuous across chunks; a chunk boundary may split a multi-line
 *   construct (documented limitation).
 * - Markdown re-parses the whole accumulated text per append (GFM structure
 *   needs the full document; md files are rarely huge).
 *
 * Binary files (NUL sniff on the first chunk) get a message instead of
 * garbage. The active theme is projected onto Shiki's light/dark themes by
 * re-rendering on `body[data-ds-dark-theme]` changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { TextviewerEncoding, TextviewerSnapshot } from '../contract.ts'
import { loadRenderer } from './renderer-loader.ts'
import { highlightInWorker, warmUpWorker } from './renderer-worker.ts'
import type { RendererExports } from './renderer-contract.ts'
import css from './TextViewer.module.css'

/** Distance from the bottom that counts as "at the end" (auto-load region). */
const NEAR_BOTTOM_PX = 120
/** Distance from the very bottom that counts as "pinned" (streaming only for
 * users glued to the edge — a mere near-bottom scroll must NOT ride along). */
const PINNED_PX = 2

/** Extension → Shiki language id (the v1 curated set; more formats extend here). */
const EXT_LANGS: Record<string, string> = {
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'cpp', h: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  json: 'json', jsonc: 'json', json5: 'json',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  py: 'python', pyw: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell',
  sql: 'sql',
  xml: 'xml', svg: 'xml', xhtml: 'xml', xsl: 'xml',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  ini: 'ini', cfg: 'ini',
  toml: 'toml',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  rb: 'ruby',
  diff: 'diff',
  log: 'log',
}

/** Extension-less names (matched case-insensitively against the base name). */
const BASENAME_LANGS: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

/** Shiki language id for a file name, or undefined for plain text. */
export function langFor(name: string): string | undefined {
  const lower = name.toLowerCase()
  const base = BASENAME_LANGS[lower]
  if (base !== undefined) return base
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXT_LANGS[lower.slice(dot + 1)]
}

/** Which renderer a file name gets: markdown, code (highlighted), or plain. */
export type RendererKind = 'markdown' | 'code' | 'plain'
export function rendererFor(name: string): RendererKind {
  const lower = name.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown'
  return langFor(lower) !== undefined ? 'code' : 'plain'
}

/** Compact byte size for the header meta. */
function formatSize(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * One code chunk, highlighted in the WORKER — zero main-thread jank (the
 * first use of a language compiles its grammar synchronously, and a 200KB
 * chunk tokenizes in ~1.7s; both would freeze the UI). The plain surface
 * shows until the HTML arrives; on worker failure the main-thread
 * highlighter (the lazy bundle) takes over.
 */
function HighlightedChunk(props: {
  content: string
  lang: string
  dark: boolean
  fallback: RendererExports | null
}): React.JSX.Element {
  const { content, lang, dark, fallback } = props
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    highlightInWorker(content, lang, dark)
      .then(out => { if (!cancelled) setHtml(out) })
      .catch(() => {
        if (cancelled || fallback === null) return
        void fallback.getHighlighter().then(highlighter => {
          if (cancelled) return
          try {
            setHtml(highlighter.codeToHtml(content, { lang, theme: dark ? 'github-dark' : 'github-light' }))
          } catch {
            // keep the plain surface
          }
        })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, lang, dark, fallback])
  if (html === null) return <pre className={css.plain}>{content}</pre>
  return <div className={css.code} dangerouslySetInnerHTML={{ __html: html }} />
}

export function TextViewer(props: {
  root: string
  file: { name: string; path: string } | null
  dark: boolean
  t: TranslateNS<typeof NS>
  readText: (root: string, path: string, offset: number, limit: number | undefined, encoding: TextviewerEncoding | undefined, signal: AbortSignal) => Promise<RpcResult<TextviewerSnapshot>>
  /** RPC-backed fetch of the lazy renderer bundle source. */
  rendererBundle: () => Promise<string>
}): React.JSX.Element {
  const { file, t } = props
  if (file === null) return <div className={css.state}>{t('viewer.empty')}</div>
  // KEYED BY PATH: switching files unmounts the old stream wholesale (its
  // accumulated chunks die with it) and mounts a fresh one — the stale
  // "previous file's content rendered into the new file's branch" instant
  // can never happen. That instant parsed 4.3MB of a previous file as
  // markdown (the post-huge → README.md switch freeze), while code files
  // only re-posted old chunks to the worker (hence no visible freeze).
  return <TextStream key={file.path} {...props} file={file} />
}

/**
 * One file's text stream: chunk state, streaming logic, and the renderer
 * branches. Keyed by the file path in the parent — every file gets a fresh
 * mount, so none of this state ever leaks across files.
 */
function TextStream(props: {
  root: string
  file: { name: string; path: string }
  dark: boolean
  t: TranslateNS<typeof NS>
  readText: (root: string, path: string, offset: number, limit: number | undefined, encoding: TextviewerEncoding | undefined, signal: AbortSignal) => Promise<RpcResult<TextviewerSnapshot>>
  /** RPC-backed fetch of the lazy renderer bundle source. */
  rendererBundle: () => Promise<string>
}): React.JSX.Element {
  const { root, file, dark, t, readText, rendererBundle } = props
  // Chunked text: each appended chunk is its own entry so plain/code render
  // append-only (the markdown view joins them for full-document parsing).
  const [chunks, setChunks] = useState<string[]>([])
  const [meta, setMeta] = useState<{ size: number; encoding: string; truncated: boolean; binary: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renderer, setRenderer] = useState<RendererExports | null>(null)
  const [rendererFailed, setRendererFailed] = useState(false)
  // Markdown view mode: false = rendered (default), true = raw source text.
  const [rawMode, setRawMode] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The plain surface's pre: appends happen imperatively so the browser
  // never rewrites already-inserted text (see the append-only strategy).
  const plainRef = useRef<HTMLPreElement>(null)
  const lastAppendedRef = useRef(0)
  // Bytes appended so far (the next chunk's offset); a ref keeps it out of
  // render cycles and immune to stale closures in the scroll handler.
  const bytesRef = useRef(0)
  const loadingRef = useRef(false)
  // Whether the viewport sits near the bottom (auto-load region) and
  // whether it is PINNED at the very bottom edge (continuous streaming).
  const atBottomRef = useRef(false)
  const pinnedRef = useRef(false)
  // The first chunk's detected encoding, carried forward to later chunks so
  // they decode stably (a GBK chunk that happens to be valid UTF-8 must not
  // flip back mid-file).
  const encodingRef = useRef<TextviewerEncoding | undefined>(undefined)

  /** Full document text for the markdown renderer (rarely huge). */
  const mdContent = useMemo(() => chunks.join(''), [chunks])

  // Load the heavy renderer bundle once, on first mount.
  useEffect(() => {
    let cancelled = false
    void loadRenderer(rendererBundle)
      .then(exports => { if (!cancelled) setRenderer(exports) })
      .catch(() => { if (!cancelled) setRendererFailed(true) })
    // Warm the worker's highlighter + the common languages in the
    // background (off the main thread) so the first code open feels
    // instant; the theme only affects token colors, so the mount theme is
    // fine for the warm-up.
    warmUpWorker(dark)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererBundle])

  const append = (snapshot: TextviewerSnapshot): void => {
    bytesRef.current = snapshot.offset + snapshot.bytes
    encodingRef.current = snapshot.encoding
    setMeta({
      size: snapshot.size,
      encoding: snapshot.encoding,
      truncated: snapshot.truncated,
      binary: snapshot.binary,
    })
    // Binary files render nothing — the message replaces the surface.
    setChunks(snapshot.binary ? [] : prev => [...prev, snapshot.content])
  }

  /** Fetch and append the next chunk (single-flight). */
  const loadMore = (): void => {
    if (meta === null || meta.binary || loadingRef.current) return
    if (!meta.truncated) return
    const target = file.path
    loadingRef.current = true
    setLoading(true)
    void readText(root, target, bytesRef.current, undefined, encodingRef.current, new AbortController().signal).then(result => {
      loadingRef.current = false
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      append(result.value)
    })
  }

  // Load the first chunk on mount (the parent keys this stream by the file
  // path, so mount == file open; in-flight responses of a REMOUNTED stream
  // are cancelled by the cleanup and cannot touch the new instance).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadingRef.current = true
    void readText(root, file.path, 0, undefined, undefined, new AbortController().signal).then(result => {
      loadingRef.current = false
      if (cancelled) return
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      append(result.value)
    })
    return () => { cancelled = true }
    // append reads only refs; the mount condition is the path itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, file.path, readText])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < PINNED_PX
    atBottomRef.current = distance < NEAR_BOTTOM_PX
    if (atBottomRef.current) loadMore()
  }

  // After every append: NEVER teleport a mere near-bottom scroll — appending
  // below the viewport keeps the visible lines where they are, and the chain
  // stops on its own once the new bottom is out of reach (scrolling resumes
  // it). Only a user PINNED at the exact bottom edge rides a continuous
  // stream (re-pinned to the new bottom) and can leave it by scrolling up.
  // Short content (smaller than the viewport) counts as pinned: it chains
  // until the file is complete — the scroll handler alone would stall there.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < PINNED_PX) {
      pinnedRef.current = true
      atBottomRef.current = true
      el.scrollTop = el.scrollHeight
      loadMore()
      return
    }
    pinnedRef.current = false
    atBottomRef.current = distance < NEAR_BOTTOM_PX
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadMore reads live refs.
  }, [chunks])

  // Append-only plain surface: insert each new chunk's text node into the
  // pre; the browser keeps the old text untouched (React never rewrites it).
  // A chunk-count reset (file switch) clears the pre first.
  useLayoutEffect(() => {
    const el = plainRef.current
    if (el === null) return
    let from = lastAppendedRef.current
    if (from > chunks.length) {
      el.textContent = ''
      from = 0
    }
    for (let i = from; i < chunks.length; i += 1) {
      el.append(document.createTextNode(chunks[i]!))
    }
    lastAppendedRef.current = chunks.length
  }, [chunks])

  const kind = rendererFor(file.name)
  const lang = langFor(file.name)

  // Code/markdown need the renderer bundle; until it loads (or on failure)
  // they degrade to the plain surface — never a blank panel.
  const rendererReady = renderer !== null
  const rendererDown = rendererFailed && (kind === 'code' || kind === 'markdown')

  return (
    <>
      {error !== null ? (
        <div className={css.state}>{t('error.load')}：{error}</div>
      ) : meta === null ? (
        <div className={css.state}>{loading ? t('viewer.loading') : ''}</div>
      ) : meta.binary ? (
        <div className={css.state}>{t('viewer.binary')}</div>
      ) : (
        <div ref={scrollRef} className={css.scroll} onScroll={onScroll}>
          {kind === 'markdown' && rendererReady && !rawMode ? (
            <renderer.MarkdownView content={mdContent} />
          ) : kind === 'code' && lang !== undefined && rendererReady ? (
            <div className={css.chunks}>
              {chunks.map((chunk, index) => (
                <HighlightedChunk key={index} content={chunk} lang={lang} dark={dark} fallback={renderer} />
              ))}
            </div>
          ) : (
            <pre ref={plainRef} className={css.plain} />
          )}
          {rendererDown && <div className={css.moreHint}>{t('error.load')}</div>}
          {meta.truncated && <div className={css.moreHint}>{t('viewer.more')}</div>}
        </div>
      )}
      {/* Bottom status bar: the markdown render/source toggle (md only) and
          the file format meta, right-aligned. */}
      {meta !== null && (
        <div className={css.statusBar}>
          {kind === 'markdown' && (
            <button
              type="button"
              className={css.toggleButton}
              aria-pressed={rawMode}
              onClick={() => { setRawMode(current => !current) }}
            >
              {rawMode ? t('viewer.render') : t('viewer.source')}
            </button>
          )}
          <span className={css.statusText}>
            {`${meta.encoding} · ${formatSize(meta.size)}${meta.truncated ? ' · 部分' : ''}`}
          </span>
        </div>
      )}
    </>
  )
}
