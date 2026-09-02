/**
 * Heavy renderer bundle (lazy): the Shiki highlighter and the markdown view.
 * Built as a SEPARATE CJS entry (lib/renderer.js) and served by the host
 * through the `renderer` endpoint; the main client bundle evaluates it on
 * first use, so the boot bundle stays light (dock chrome + tree + RPC only).
 *
 * The factory receives `React` and `ReactJsxRuntime` from the caller (the
 * shell-seeded module table owns them); everything else is bundled here.
 */
import { useEffect, useState } from 'react'
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

/** GFM markdown view (tables, strikethrough, autolinks, task lists…). */
export function MarkdownView(props: {
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
          // code covers BOTH block fences and inline code — react-markdown
          // does not say which (the `node` prop only exists with passNode),
          // so block-ness is inferred: a language class or a newline means a
          // fenced block (mdast inline code is single-line by construction).
          code: (codeProps) => {
            const className = String(codeProps.className ?? '')
            const text = String(codeProps.children ?? '')
            const isBlock = className !== '' || text.includes('\n')
            // ```mermaid fences go to the INJECTED renderer (the main
            // bundle's lazy DiagramHost); the mermaid engine never rides
            // inside this bundle. Absent (standalone use, tests, worker) →
            // the fence renders as its default code block.
            if (isBlock && className.split(/\s+/).includes('language-mermaid')) {
              if (Fence === undefined) {
                return <pre><code className={codeProps.className}>{codeProps.children}</code></pre>
              }
              return (
                <Fence
                  source={text}
                  dark={dark}
                  fallback={<pre className={css.mdFenceFallback}><code className={codeProps.className}>{codeProps.children}</code></pre>}
                />
              )
            }
            if (isBlock) return <pre><code className={codeProps.className}>{codeProps.children}</code></pre>
            return <code className={codeProps.className}>{codeProps.children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** The bundle's public face (what the loader's factory must return). */
export const rendererExports: RendererExports = { getHighlighter, HighlightedCode, MarkdownView }
