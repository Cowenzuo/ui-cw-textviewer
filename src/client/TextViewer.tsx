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
 * BOM/UTF-8/GBK); the region appends chunks as the user scrolls to the
 * bottom (pinned there it chains automatically), capped at a preview bound.
 * Binary files (NUL sniff on the first chunk) get a message instead of
 * garbage. The active theme is projected onto Shiki's light/dark themes by
 * re-rendering on `body[data-ds-dark-theme]` changes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const [content, setContent] = useState('')
  const [meta, setMeta] = useState<{ size: number; encoding: string; truncated: boolean; binary: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  const [renderer, setRenderer] = useState<RendererExports | null>(null)
  const [rendererFailed, setRendererFailed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Bytes appended so far (the next chunk's offset); a ref keeps it out of
  // render cycles and immune to stale closures in the scroll handler.
  const bytesRef = useRef(0)
  const loadingRef = useRef(false)
  // Whether the viewport sits at the bottom: pinned loads chain there.
  const atBottomRef = useRef(false)
  // The file the current stream belongs to: in-flight chunks of a previous
  // file must not append into the next file's surface (switch race).
  const pathRef = useRef<string | null>(null)

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
    setContent(snapshot.binary ? '' : snapshot.content)
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

  // Reset and load the first chunk on file change.
  useEffect(() => {
    setContent('')
    setMeta(null)
    setError(null)
    setTooLarge(false)
    bytesRef.current = 0
    loadingRef.current = false
    atBottomRef.current = false
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
    // append reads only refs; readText/root/file are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, file, readText])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    if (atBottomRef.current) loadMore()
  }

  // After every append: if the user sits at the bottom, re-pin and keep
  // streaming (the scroll handler alone would stall when content is shorter
  // than the viewport, since no new scroll event fires — treat a
  // non-scrollable viewport as "at the bottom" so short content chains too).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el !== null && el.scrollHeight <= el.clientHeight + 1) {
      atBottomRef.current = true
    }
    if (!atBottomRef.current) return
    if (el !== null) el.scrollTop = el.scrollHeight
    loadMore()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadMore reads live refs.
  }, [content])

  const kind = file === null ? 'plain' : rendererFor(file.name)
  const lang = file === null ? undefined : langFor(file.name)

  // Code/markdown need the renderer bundle; until it loads (or on failure)
  // they degrade to the plain surface — never a blank panel.
  const rendererReady = renderer !== null
  const rendererDown = rendererFailed && (kind === 'code' || kind === 'markdown')

  return (
    <>
      <div className={css.infoRow}>
        <span className={css.infoName} title={file?.path}>{file === null ? t('viewer.title') : file.name}</span>
        {meta !== null && (
          <span className={css.infoMeta}>
            {`${meta.encoding} · ${formatSize(meta.size)}${meta.truncated ? ' · 部分' : ''}`}
          </span>
        )}
      </div>
      {file === null ? (
        <div className={css.message}>{t('viewer.empty')}</div>
      ) : error !== null ? (
        <div className={css.message}>{t('error.load')}：{error}</div>
      ) : meta === null ? (
        <div className={css.message}>{loading ? t('viewer.loading') : ''}</div>
      ) : meta.binary ? (
        <div className={css.message}>{t('viewer.binary')}</div>
      ) : (
        <div ref={scrollRef} className={css.scroll} onScroll={onScroll}>
          {kind === 'markdown' && rendererReady ? (
            <renderer.MarkdownView content={content} />
          ) : kind === 'code' && lang !== undefined && rendererReady ? (
            <renderer.HighlightedCode content={content} lang={lang} dark={dark} />
          ) : (
            <pre className={css.plain}>{content}</pre>
          )}
          {rendererDown && <div className={css.moreHint}>{t('error.load')}</div>}
          {meta.truncated && !tooLarge && <div className={css.moreHint}>{t('viewer.more')}</div>}
          {tooLarge && <div className={css.moreHint}>{t('viewer.too-large')}</div>}
        </div>
      )}
    </>
  )
}
