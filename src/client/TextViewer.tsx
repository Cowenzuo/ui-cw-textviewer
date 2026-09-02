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
import type { TextviewerSnapshot } from '../contract.ts'
import { loadRenderer } from './renderer-loader.ts'
import type { RendererExports } from './renderer-contract.ts'
import css from './TextViewer.module.css'

/** Preview bound: chunked reads stop appending past this many bytes. */
const MAX_VIEW_BYTES = 2 * 1024 * 1024
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

export function TextViewer(props: {
  root: string
  file: { name: string; path: string } | null
  dark: boolean
  t: TranslateNS<typeof NS>
  readText: (root: string, path: string, offset: number, limit: number | undefined, signal: AbortSignal) => Promise<RpcResult<TextviewerSnapshot>>
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
  const [tooLarge, setTooLarge] = useState(false)
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
  // The file the current stream belongs to: in-flight chunks of a previous
  // file must not append into the next file's surface (switch race).
  const pathRef = useRef<string | null>(null)

  /** Full document text for the markdown renderer (rarely huge). */
  const mdContent = useMemo(() => chunks.join(''), [chunks])

  // Load the heavy renderer bundle once, on first mount.
  useEffect(() => {
    let cancelled = false
    void loadRenderer(rendererBundle)
      .then(exports => { if (!cancelled) setRenderer(exports) })
      .catch(() => { if (!cancelled) setRendererFailed(true) })
    return () => { cancelled = true }
  }, [rendererBundle])

  const append = (snapshot: TextviewerSnapshot): void => {
    bytesRef.current = snapshot.offset + snapshot.bytes
    setMeta({
      size: snapshot.size,
      encoding: snapshot.encoding,
      truncated: snapshot.truncated,
      binary: snapshot.binary,
    })
    // Binary files render nothing — the message replaces the surface.
    setChunks(snapshot.binary ? [] : prev => [...prev, snapshot.content])
  }

  /** Fetch and append the next chunk (single-flight, current-file-guarded). */
  const loadMore = (): void => {
    if (file === null || meta === null || meta.binary || loadingRef.current) return
    if (!meta.truncated) return
    if (bytesRef.current >= MAX_VIEW_BYTES) { setTooLarge(true); return }
    const target = file.path
    loadingRef.current = true
    setLoading(true)
    void readText(root, target, bytesRef.current, undefined, new AbortController().signal).then(result => {
      loadingRef.current = false
      setLoading(false)
      if (pathRef.current !== target) return // the user switched files meanwhile
      if (!result.ok) { setError(result.error.message); return }
      append(result.value)
    })
  }

  // Reset and load the first chunk when the FILE CHANGES. Keyed on the
  // PATH (not the file object's identity): parent re-renders — width drags,
  // sidebar measurements, theme flips — must never fabricate a "new file"
  // and reset the surface (the drag-flicker regression was exactly that).
  useEffect(() => {
    setChunks([])
    setMeta(null)
    setError(null)
    setTooLarge(false)
    setRawMode(false)
    bytesRef.current = 0
    loadingRef.current = false
    atBottomRef.current = false
    pinnedRef.current = false
    pathRef.current = file === null ? null : file.path
    if (file === null) return
    let cancelled = false
    setLoading(true)
    loadingRef.current = true
    const target = file.path
    void readText(root, target, 0, undefined, new AbortController().signal).then(result => {
      loadingRef.current = false
      if (cancelled) return
      if (pathRef.current !== target) return // switched again mid-flight
      setLoading(false)
      if (!result.ok) { setError(result.error.message); return }
      append(result.value)
    })
    return () => { cancelled = true }
    // append reads only refs; the reload condition is the path itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, file === null ? null : file.path, readText])

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

  const kind = file === null ? 'plain' : rendererFor(file.name)
  const lang = file === null ? undefined : langFor(file.name)

  // Code/markdown need the renderer bundle; until it loads (or on failure)
  // they degrade to the plain surface — never a blank panel.
  const rendererReady = renderer !== null
  const rendererDown = rendererFailed && (kind === 'code' || kind === 'markdown')

  return (
    <>
      {file === null ? (
        <div className={css.state}>{t('viewer.empty')}</div>
      ) : error !== null ? (
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
                <renderer.HighlightedCode key={index} content={chunk} lang={lang} dark={dark} />
              ))}
            </div>
          ) : (
            <pre ref={plainRef} className={css.plain} />
          )}
          {rendererDown && <div className={css.moreHint}>{t('error.load')}</div>}
          {meta.truncated && !tooLarge && <div className={css.moreHint}>{t('viewer.more')}</div>}
          {tooLarge && <div className={css.moreHint}>{t('viewer.too-large')}</div>}
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
