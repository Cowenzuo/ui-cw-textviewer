/**
 * /textviewer RPC handler: read-only directory listing + text chunk reading.
 *
 * Pure module with no ctx dependency: `apply` wires the factory result into
 * the connection channel, tests call the factory directly. Read-only by
 * design (v1): `list` navigates the workspace, `read-text` serves decoded
 * text chunks (BOM-detected UTF-8/UTF-16, GBK fallback for legacy Chinese
 * files, NUL-based binary sniff, clamped byte paging).
 *
 * Error codes come from the core RpcErrorDetailsMap (a closed union): the
 * directory picker's `directory-unreadable` covers every unusable target,
 * `cancelled` reports caller aborts, `bad-request` rejects unknown
 * endpoints, `internal` folds unexpected failures.
 */
import { spawn } from 'node:child_process'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as iconv from 'iconv-lite'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {
  TextviewerEncoding, TextviewerEntry, TextviewerListing, TextviewerListRequest,
  TextviewerReadRequest, TextviewerRendererResult, TextviewerSnapshot,
} from './contract.ts'

export type {
  TextviewerEncoding, TextviewerEntry, TextviewerListing, TextviewerListRequest,
  TextviewerReadRequest, TextviewerRendererResult, TextviewerSnapshot,
} from './contract.ts'

/** One attrib(1) output line: attribute letters then the quoted-or-plain path. */
const ATTRIB_LINE = /^([ASHR ]+)\s+(.+)$/

/** Complete-result bound for one listed level (name-sorted head kept). */
const DEFAULT_MAX_ENTRIES = 200
/** Default read chunk size in bytes. */
export const READ_DEFAULT_LIMIT = 256 * 1024
/** Hard ceiling for a submitted read `limit` (protects the host from huge pages). */
export const READ_MAX_LIMIT = 1024 * 1024
/** NUL probe window for the binary sniff (first chunk only). */
const BINARY_PROBE_BYTES = 8192

export interface TextviewerHandlerOptions {
  /** Complete-result bound; a cut level keeps the name-sorted head (mirrors the directory picker's maxEntries). */
  maxEntries?: number
  /**
   * Windows hidden-attribute reader for one listed directory; defaults to an
   * `attrib` spawn (Node dirents expose no FILE_ATTRIBUTE_HIDDEN). Tests
   * inject a fake; a reader that fails yields no hidden entries (the caller
   * falls back to the POSIX dot-prefix convention).
   */
  readHidden?: (root: string) => Promise<ReadonlySet<string>>
  /**
   * Lazy renderer bundle reader; defaults to the built lib/renderer.js next
   * to this module. Tests inject a fake so the endpoint is exercisable
   * without a build.
   */
  readRenderer?: () => Promise<string>
}

/** Default renderer-bundle reader: the built lib/renderer.js beside lib/index.js. */
const defaultReadRenderer = async (): Promise<string> => {
  return readFile(fileURLToPath(new URL('./renderer.js', import.meta.url)), 'utf8')
}

/** Clamp a client-submitted read size into [1, READ_MAX_LIMIT]. */
export function clampReadLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return READ_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), READ_MAX_LIMIT)
}

/** Windows drive-rooted or full-UNC absolute form; rejects relative and rooted drive-less forms. */
function isQualifiedAbsolutePath(path: string): boolean {
  if (!isAbsolute(path)) return false
  if (process.platform !== 'win32') return true
  // 'C:\foo' has a 3-char root; '\foo' and '/' have shorter ones; a full UNC
  // root ('\\server\share') is longer. Same fence as the directory picker.
  return parse(path).root.length >= 3
}

/** Strip trailing separators so containment comparisons stay exact. */
function trimTrailingSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/**
 * Whether `candidate` equals `root` or descends from it. Case-insensitive on
 * Windows (the filesystem is), exact elsewhere; always compares on the
 * platform separator so `D:\work` never matches `D:\workx`.
 */
export function isWithin(root: string, candidate: string): boolean {
  const a = trimTrailingSeparators(process.platform === 'win32' ? root.toLowerCase() : root)
  const b = trimTrailingSeparators(process.platform === 'win32' ? candidate.toLowerCase() : candidate)
  if (b === a) return true
  const separator = process.platform === 'win32' ? '\\' : '/'
  return b.startsWith(`${a}${separator}`)
}

/** POSIX dot-prefix convention; on Windows only the real attribute decides. */
function isDotHidden(name: string): boolean {
  return process.platform !== 'win32' && name.startsWith('.')
}

/**
 * Parse `attrib <dir>\*` output into the set of hidden absolute paths
 * (lowercased). Lines look like `A  H          D:\dir\.git` — attribute
 * letters, then the path (quoted when it contains spaces).
 */
export function parseAttribOutput(output: string): Set<string> {
  const hidden = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = ATTRIB_LINE.exec(line.trimEnd())
    if (match === null) continue
    if (!match[1]!.includes('H')) continue
    const path = match[2]!.trim().replace(/^"(.*)"$/, '$1')
    if (path !== '') hidden.add(path.toLowerCase())
  }
  return hidden
}

/**
 * Batch-read the Windows hidden attribute for every entry of `root` through
 * one `attrib /d <root>\*` call. Failures (missing binary, sandbox fences)
 * resolve to an empty set so listing never fails because of the probe.
 */
export async function readWindowsHidden(root: string): Promise<ReadonlySet<string>> {
  return new Promise((resolve) => {
    const child = spawn('attrib', ['/d', join(root, '*')], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', () => { resolve(new Set()) })
    child.on('close', (code) => {
      if (code !== 0) { resolve(new Set()); return }
      resolve(parseAttribOutput(output))
    })
  })
}

/**
 * Encoding from the file's head bytes: BOMs decide UTF-8/16 explicitly; a
 * BOM-less head is provisionally UTF-8 and falls back to GBK at decode time
 * (decodeChunk) when strict UTF-8 fails.
 */
export function detectEncoding(head: Buffer): TextviewerEncoding {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'UTF-8'
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'UTF-16LE'
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'UTF-16BE'
  return 'UTF-8'
}

/**
 * Decode one chunk, reporting the encoding it actually decoded as. UTF-8 is
 * decoded strictly (fatal): on failure the chunk is legacy GBK (the common
 * non-UTF-8 Chinese encoding). UTF-16 is decoded through the WHATWG
 * decoders, which strip a leading BOM automatically.
 */
export function decodeChunk(buffer: Buffer, provisional: TextviewerEncoding): { text: string; encoding: TextviewerEncoding } {
  if (provisional === 'UTF-16LE' || provisional === 'UTF-16BE') {
    return {
      text: new TextDecoder(provisional === 'UTF-16LE' ? 'utf-16le' : 'utf-16be').decode(buffer),
      encoding: provisional,
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'UTF-8' }
  } catch {
    return { text: iconv.decode(buffer, 'gbk'), encoding: 'GBK' }
  }
}

/** Align a byte offset to a code-unit boundary for multi-byte encodings. */
function alignOffset(offset: number, encoding: TextviewerEncoding): number {
  return encoding === 'UTF-16LE' || encoding === 'UTF-16BE' ? offset - (offset % 2) : offset
}

/** Human line count: a trailing newline closes the last line, it does not open a new one. */
function countLines(text: string): number {
  if (text === '') return 0
  let newlines = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1
  }
  return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1
}

/**
 * Read one decoded chunk of a file. The encoding is re-detected from the
 * head on every call (a 4–8 byte peek — negligible), so chunked reads after
 * the first stay deterministic. UTF-16 offsets are aligned down to an even
 * byte; the first chunk carries the binary sniff.
 */
export async function readTextChunk(path: string, offset: number, limit: number, signal: AbortSignal): Promise<TextviewerSnapshot> {
  if (signal.aborted) throw new Error('read-text was aborted')
  const st = await stat(path)
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`)
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    const headRead = await handle.read(head, 0, head.length, 0)
    const encoding = detectEncoding(head.subarray(0, headRead.bytesRead))
    const start = Math.min(alignOffset(offset, encoding), st.size)
    const want = Math.min(limit, st.size - start)
    const buffer = Buffer.alloc(want)
    const chunkRead = await handle.read(buffer, 0, want, start)
    const bytes = chunkRead.bytesRead
    const { text, encoding: actual } = decodeChunk(buffer.subarray(0, bytes), encoding)
    const binary = start === 0 && bytes > 0 && buffer.subarray(0, Math.min(BINARY_PROBE_BYTES, bytes)).includes(0)
    const lineCount = countLines(text)
    return {
      path,
      size: st.size,
      offset: start,
      bytes,
      content: text,
      encoding: actual,
      lineCount,
      truncated: start + bytes < st.size,
      binary,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Create the channel handler.
 * @param options - tunables (test seams).
 * @returns handler satisfying the ConnectionRpcHandler contract.
 */
export function createTextviewerHandler(options: TextviewerHandlerOptions = {}): ConnectionRpcHandler {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const readHidden = options.readHidden ?? (process.platform === 'win32' ? readWindowsHidden : undefined)
  const readRenderer = options.readRenderer ?? defaultReadRenderer
  return async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    if (endpoint !== 'list' && endpoint !== 'read-text' && endpoint !== 'renderer') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `unknown textviewer endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      }
    }
    if (endpoint === 'renderer') {
      // Serves the lazy renderer bundle source; no path inputs, so there is
      // nothing to scope — a build-less deployment surfaces the failure.
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'textviewer renderer was aborted', details: {} } }
      }
      try {
        const code = await readRenderer()
        return { ok: true, value: { code } satisfies TextviewerRendererResult }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'internal', message: `renderer bundle unavailable: ${error instanceof Error ? error.message : String(error)}`, details: {} },
        }
      }
    }
    if (endpoint === 'list') {
      const requested = (payload as TextviewerListRequest | null)?.path
      const lockedRoot = (payload as TextviewerListRequest | null)?.root
      if (requested !== undefined && !isQualifiedAbsolutePath(requested)) {
        return {
          ok: false,
          error: { code: 'directory-unreadable', message: 'path is not fully qualified', details: { path: String(requested) } },
        }
      }
      if (lockedRoot !== undefined && !isQualifiedAbsolutePath(lockedRoot)) {
        return {
          ok: false,
          error: { code: 'directory-unreadable', message: 'root is not fully qualified', details: { path: String(lockedRoot) } },
        }
      }
      const root = requested ?? lockedRoot ?? process.cwd()
      // Workspace lock: with a locked root the target must stay inside it —
      // enforced host-side so a client bug cannot escape the workspace.
      if (lockedRoot !== undefined && !isWithin(lockedRoot, root)) {
        return {
          ok: false,
          error: { code: 'directory-unreadable', message: 'path escapes the locked workspace root', details: { path: root } },
        }
      }
      let dirents
      try {
        dirents = await readdir(root, { withFileTypes: true })
      } catch (error) {
        if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'textviewer listing was aborted', details: {} } }
        return {
          ok: false,
          error: { code: 'directory-unreadable', message: error instanceof Error ? error.message : String(error), details: { path: root } },
        }
      }
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'textviewer listing was aborted', details: {} } }
      // On Windows the real FILE_ATTRIBUTE_HIDDEN decides (a dot prefix alone
      // does not); the reader failure fallback keeps dot-prefix hiding intact.
      let hiddenPaths: ReadonlySet<string> = new Set()
      if (readHidden !== undefined) {
        try {
          hiddenPaths = await readHidden(root)
        } catch {
          hiddenPaths = new Set()
        }
      }
      // Directories first, name-sorted within each kind.
      const rows = dirents
        .map(dirent => ({ dirent, path: join(root, dirent.name) }))
        .sort((left, right) => {
          const leftDir = left.dirent.isDirectory()
          const rightDir = right.dirent.isDirectory()
          if (leftDir !== rightDir) return leftDir ? -1 : 1
          return left.dirent.name < right.dirent.name ? -1 : left.dirent.name > right.dirent.name ? 1 : 0
        })
      const truncated = rows.length > maxEntries
      const kept = truncated ? rows.slice(0, maxEntries) : rows
      const entries: TextviewerEntry[] = []
      for (const row of kept) {
        if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'textviewer listing was aborted', details: {} } }
        const { dirent } = row
        let kind: 'file' | 'dir' | undefined
        let size: number | undefined
        let mtimeMs: number | undefined
        if (dirent.isDirectory()) {
          kind = 'dir'
        } else if (dirent.isFile()) {
          kind = 'file'
        } else {
          // Symlink or special: one probe decides the row (broken/cyclic links are skipped).
          try {
            const st = await stat(row.path)
            kind = st.isDirectory() ? 'dir' : 'file'
            size = st.size
            mtimeMs = st.mtimeMs
          } catch {
            continue
          }
        }
        if (kind === 'file' && size === undefined) {
          try {
            const st = await stat(row.path)
            size = st.size
            mtimeMs = st.mtimeMs
          } catch {
            // Vanished between readdir and stat: skip the row entirely.
            continue
          }
        }
        entries.push({
          name: dirent.name,
          path: row.path,
          kind,
          size,
          mtimeMs,
          hidden: isDotHidden(dirent.name) || hiddenPaths.has(row.path.toLowerCase()),
        })
      }
      return { ok: true, value: { path: root, entries, truncated } satisfies TextviewerListing }
    }
    // read-text
    const readPayload = payload as TextviewerReadRequest | null
    const readRoot = readPayload?.root
    const readPath = readPayload?.path
    if (typeof readRoot !== 'string' || typeof readPath !== 'string'
      || !isQualifiedAbsolutePath(readRoot) || !isQualifiedAbsolutePath(readPath)) {
      return {
        ok: false,
        error: {
          code: 'directory-unreadable',
          message: 'read-text root/path must be fully qualified absolute paths',
          details: { path: String(readPath) },
        },
      }
    }
    // The file must stay inside the locked workspace root.
    if (!isWithin(readRoot, readPath)) {
      return {
        ok: false,
        error: { code: 'directory-unreadable', message: 'read-text path escapes the locked workspace root', details: { path: readPath } },
      }
    }
    if (signal.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'textviewer read was aborted', details: {} } }
    }
    const offsetRaw = readPayload?.offset
    const offset = typeof offsetRaw === 'number' && Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0
    const limit = clampReadLimit(readPayload?.limit)
    try {
      const snapshot = await readTextChunk(readPath, offset, limit, signal)
      return { ok: true, value: snapshot }
    } catch (error) {
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'textviewer read was aborted', details: {} } }
      return {
        ok: false,
        error: { code: 'directory-unreadable', message: error instanceof Error ? error.message : String(error), details: { path: readPath } },
      }
    }
  }
}
