/**
 * Web Worker highlighting: Shiki's JS-regex engine compiles each language's
 * Oniguruma patterns on first use and tokenizes chunks SYNCHRONOUSLY — a
 * 200KB code chunk costs ~1.7s of main-thread jank, and the first use of a
 * language 100–600ms (the txt→code switch freeze). The worker keeps ALL of
 * it off the UI thread.
 *
 * The bootstrap (built here as a Blob) re-fetches the renderer bundle
 * through the same RPC envelope (same-origin: the page cookies ride along)
 * and evaluates it with stubs for react (the components are never rendered
 * in the worker — only getHighlighter runs) and the node builtins vfile
 * needs (the same stubs renderer-loader.ts provides; duplicated here
 * because the bootstrap is a string and cannot import).
 *
 * Failure is graceful: a worker that cannot be created or errors out falls
 * back to the main-thread highlighter in the caller.
 */
let worker: Worker | null = null
let workerError: unknown = null
let nextId = 0
const pending = new Map<number, { resolve: (html: string) => void; reject: (error: unknown) => void }>()

const BOOTSTRAP = `
(() => {
  // vfile's node-builtin needs (mirrors renderer-loader's stubs).
  const pathStub = {
    sep: '/',
    join: (...parts) => parts.filter(p => p !== '').join('/').replace(/\\/+/g, '/'),
    basename: (path, ext) => { const b = path.split('/').pop() ?? ''; return ext !== undefined && b.endsWith(ext) ? b.slice(0, -ext.length) : b },
    dirname: (path) => { const a = path.split('/'); a.pop(); return a.join('/') || '.' },
    extname: (path) => { const b = path.split('/').pop() ?? ''; const d = b.lastIndexOf('.'); return d > 0 ? b.slice(d) : '' },
  }
  const processStub = { cwd: () => '' }
  const urlStub = {
    fileURLToPath: (url) => {
      let rest = url.startsWith('file://') ? url.slice('file://'.length) : url
      if (rest.startsWith('/') && /^\\/[A-Za-z]:/.test(rest)) rest = rest.slice(1)
      return decodeURIComponent(rest)
    },
    default: null,
  }
  urlStub.default = urlStub
  const requireShim = (name) => {
    if (name === 'react') return {}
    if (name === 'react/jsx-runtime') return { jsx: () => { throw new Error('react jsx used inside the worker') } }
    if (name === 'node:path') return { ...pathStub, default: pathStub }
    if (name === 'node:process') return { ...processStub, default: processStub }
    if (name === 'node:url') return urlStub
    throw new Error('renderer worker requires unexpected module ' + name)
  }
  let ready = null
  const load = () => {
    if (ready !== null) return ready
    ready = (async () => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'worker-renderer-' + Math.random().toString(36).slice(2),
        method: 'renderer',
        payload: {},
      })
      const res = await fetch('/textviewer/renderer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('renderer bundle fetch failed: HTTP ' + res.status)
      const envelope = await res.json()
      if (!envelope.result || !envelope.result.ok) throw new Error('renderer bundle rpc failed')
      const moduleBox = { exports: {} }
      const run = new Function('module', 'exports', 'require', envelope.result.value.code + '\\n;return module.exports;')
      const exports = run(moduleBox, moduleBox.exports, requireShim) ?? moduleBox.exports
      return exports.getHighlighter()
    })()
    ready.catch(() => { ready = null })
    return ready
  }
  self.onmessage = async (event) => {
    const msg = event.data
    if (msg === null || typeof msg !== 'object' || msg.type !== 'highlight') return
    const { id, code, lang, theme } = msg
    try {
      const highlighter = await load()
      const html = highlighter.codeToHtml(code, { lang, theme })
      self.postMessage({ type: 'result', id, html })
    } catch (error) {
      self.postMessage({ type: 'result', id, error: error instanceof Error ? error.message : String(error) })
    }
  }
})()
`

/** Lazily create the worker; a failed creation is remembered (permanent fallback). */
function getWorker(): Worker {
  if (worker !== null) return worker
  if (workerError !== null) throw workerError
  try {
    const blob = new Blob([BOOTSTRAP], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    const created = new Worker(url)
    created.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; id: number; html?: string; error?: string }
      if (msg === null || typeof msg !== 'object' || msg.type !== 'result') return
      const entry = pending.get(msg.id)
      if (entry === undefined) return
      pending.delete(msg.id)
      if (msg.error !== undefined) entry.reject(new Error(msg.error))
      else entry.resolve(msg.html ?? '')
    }
    created.onerror = (event) => {
      workerError = new Error(event.message ?? 'renderer worker failed')
      worker = null
      for (const [, entry] of pending) entry.reject(workerError)
      pending.clear()
    }
    worker = created
    return created
  } catch (error) {
    workerError = error
    throw error
  }
}

/**
 * Highlight one chunk in the worker. Rejects when the worker is unavailable
 * — the caller falls back to the main-thread highlighter.
 */
export function highlightInWorker(code: string, lang: string, dark: boolean): Promise<string> {
  const id = nextId++
  const theme = dark ? 'github-dark' : 'github-light'
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      getWorker().postMessage({ type: 'highlight', id, code, lang, theme })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

/** Background warm-up: the common languages compile in the worker while the
 * user browses, so the first open of these formats appears instant. */
export function warmUpWorker(dark: boolean): void {
  for (const lang of ['javascript', 'cpp', 'typescript', 'yaml', 'json', 'markdown']) {
    void highlightInWorker('', lang, dark).catch(() => { /* ignore: fallback path exists */ })
  }
}
