/**
 * Heavy renderer bundle (lazy): the Shiki highlighter and the markdown view.
 * Built as a SEPARATE CJS entry (lib/renderer.js) and served by the host
 * through the `renderer` endpoint; the main client bundle evaluates it on
 * first use, so the boot bundle stays light (dock chrome + tree + RPC only).
 *
 * The factory receives `React` and `ReactJsxRuntime` from the caller (the
 * shell-seeded module table owns them); everything else is bundled here.
 */
import { createElement, isValidElement, memo, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import cpp from '@shikijs/langs/cpp'
import markdown from '@shikijs/langs/markdown'
import yaml from '@shikijs/langs/yaml'
import json from '@shikijs/langs/json'
import javascript from '@shikijs/langs/javascript'
import typescript from '@shikijs/langs/typescript'
import tsx from '@shikijs/langs/tsx'
import jsx from '@shikijs/langs/jsx'
import python from '@shikijs/langs/python'
import java from '@shikijs/langs/java'
import go from '@shikijs/langs/go'
import rust from '@shikijs/langs/rust'
import bash from '@shikijs/langs/bash'
import sql from '@shikijs/langs/sql'
import xml from '@shikijs/langs/xml'
import cssLang from '@shikijs/langs/css'
import html from '@shikijs/langs/html'
import ini from '@shikijs/langs/ini'
import toml from '@shikijs/langs/toml'
import dockerfile from '@shikijs/langs/dockerfile'
import kotlin from '@shikijs/langs/kotlin'
import swift from '@shikijs/langs/swift'
import php from '@shikijs/langs/php'
import ruby from '@shikijs/langs/ruby'
import powershell from '@shikijs/langs/powershell'
import makefile from '@shikijs/langs/makefile'
import diff from '@shikijs/langs/diff'
import log from '@shikijs/langs/log'
import mermaidLang from '@shikijs/langs/mermaid'
import githubLight from '@shikijs/themes/github-light'
import githubDark from '@shikijs/themes/github-dark'
import type { MermaidFenceProps, RendererExports } from './renderer-contract.ts'
import css from './TextViewer.module.css'

/** Lazily-created singleton highlighter (one core, both themes, all v1 langs). */
let highlighterPromise: Promise<HighlighterCore> | null = null
export function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [
      cpp, markdown, yaml, json, javascript, typescript, tsx, jsx, python, java, go, rust,
      bash, sql, xml, cssLang, html, ini, toml, dockerfile, kotlin, swift, php, ruby,
      powershell, makefile, diff, log, mermaidLang,
    ].flat(),
    engine: createJavaScriptRegexEngine(),
  })
  return highlighterPromise
}

/**
 * Shiki output: keeps the previous HTML while a re-highlight runs (content
 * grows chunk by chunk), so the surface never flashes raw text. Unknown
 * languages highlight as plain text by shiki's own fallback.
 */
export function HighlightedCode(props: { content: string; lang: string; dark: boolean }): React.JSX.Element {
  const { content, lang, dark } = props
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getHighlighter().then(highlighter => {
      if (cancelled) return
      let out: string | null = null
      try {
        out = highlighter.codeToHtml(content, { lang, theme: dark ? 'github-dark' : 'github-light' })
      } catch {
        out = null
      }
      if (!cancelled && out !== null) setHtml(out)
    })
    return () => { cancelled = true }
  }, [content, lang, dark])
  if (html === null) return <pre className={css.plain}>{content}</pre>
  return <div className={css.code} dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * Sentinel wrapper for a ```mermaid fence: the code override returns THIS
 * (never a <pre>), and the pre override unwraps it — react-markdown renders
 * its own <pre> around block-code component output, so returning a <pre>
 * from the code component would nest <pre><pre><code> (the double-frame
 * regression), and a bare fence div would sit inside the auto-<pre>. The
 * fence IS NOT a code block: it renders unwrapped on the markdown surface.
 */
function MermaidFenceSlot(props: {
  fence: React.ComponentType<MermaidFenceProps>
  source: string
  dark: boolean
  fallback?: React.ReactNode
}): React.JSX.Element {
  const { fence, source, dark, fallback } = props
  return createElement(fence, { source, dark, fallback })
}

/**
 * GFM markdown view (tables, strikethrough, autolinks, task lists…).
 *
 * MEMOIZED — and the memo is load-bearing: react-markdown v10 re-parses on
 * every render whose plugin arrays changed identity (the caller must keep
 * remarkPlugins' siblings stable: content, onLinkClick, mermaidFence) and
 * each re-parse REPLACES the tree, which REMOUNTS every custom component —
 * a mermaid fence remount resets its diagram state and flashes the loading
 * label (the drag-flicker: any parent re-render during a width drag re-fired
 * the whole chain). With equal props the memo bails out entirely and the
 * fence keeps its mounted state.
 */
export const MarkdownView = memo(function MarkdownView(props: {
  content: string
  onLinkClick?: (href: string, event: React.MouseEvent<HTMLAnchorElement>) => void
  dark?: boolean
  mermaidFence?: React.ComponentType<MermaidFenceProps>
}): React.JSX.Element {
  const { content, onLinkClick, dark = false, mermaidFence: Fence } = props
  return (
    <div className={css.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Identity transform: the default strips local file paths (absolute
        // Windows paths become href="") and percent-encodes the rest. The
        // click interceptor owns navigation (every click is preventDefaulted
        // and routed: web → new tab, local → viewer), so hrefs never reach
        // the browser's navigator.
        urlTransform={(url) => url}
        components={{
          a: (anchorProps) => (
            <a
              {...anchorProps}
              // Belt and braces: even without the interceptor, never
              // navigate the app away in the same tab.
              target="_blank"
              rel="noopener noreferrer"
              onClick={onLinkClick === undefined ? undefined : (event) => {
                onLinkClick(String(anchorProps.href ?? ''), event)
              }}
            />
          ),
          // pre: block code arrives here with the code component's output as
          // its child. A mermaid fence (the MermaidFenceSlot) must NOT be
          // boxed in a pre — everything else keeps the default wrapper.
          pre: (preProps) => {
            const kids = preProps.children
            const single = Array.isArray(kids) && kids.length === 1 ? kids[0] : kids
            if (isValidElement(single) && (single.type as unknown) === MermaidFenceSlot) {
              return <>{single}</>
            }
            return <pre>{kids}</pre>
          },
          // code covers BOTH block fences and inline code (react-markdown
          // renders the block <pre> wrapper itself around this output, so
          // ONLY a <code> element is ever returned here — a nested <pre>
          // produced the double-frame regression). Inline code has no
          // language class; fences with an info string carry `language-x`.
          code: (codeProps) => {
            const className = String(codeProps.className ?? '')
            // ```mermaid fences go to the INJECTED renderer (the main
            // bundle's lazy DiagramHost); the mermaid engine never rides
            // inside this bundle. Absent (standalone use, tests, worker) →
            // the fence renders as its default code block.
            if (className.split(/\s+/).includes('language-mermaid')) {
              if (Fence === undefined) {
                return <code className={className}>{codeProps.children}</code>
              }
              return (
                <MermaidFenceSlot
                  fence={Fence}
                  source={String(codeProps.children ?? '')}
                  dark={dark}
                  fallback={<pre className={css.mdFenceFallback}><code className={className}>{codeProps.children}</code></pre>}
                />
              )
            }
            return <code className={className}>{codeProps.children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

/** The bundle's public face (what the loader's factory must return). */
export const rendererExports: RendererExports = { getHighlighter, HighlightedCode, MarkdownView }
