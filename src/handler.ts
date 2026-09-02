/**
 * /textviewer RPC handler: text chunk reading + lazy renderer bundle serving.
 *
 * Pure module with no ctx dependency: `apply` wires the factory result into
 * the connection channel, tests call the factory directly. Read-only by
 * design: `read-text` serves decoded text chunks (BOM-detected UTF-8/UTF-16,
 * GBK fallback for legacy Chinese files, NUL-based binary sniff, clamped
 * byte paging), `renderer` serves the lazy renderer bundle source.
 *
 * NOTE: there is deliberately NO directory-listing endpoint here — the file
 * tree belongs to the ui-cw-fileexplorer plugin, which broadcasts open-file
 * events the viewer subscribes to (see src/client).
 *
 * Error codes come from the core RpcErrorDetailsMap (a closed union): the
 * directory picker's `directory-unreadable` covers every unusable target,
 * `cancelled` reports caller aborts, `bad-request` rejects unknown
 * endpoints, `internal` folds unexpected failures.
 */
import { open, readFile, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as iconv from 'iconv-lite'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {
  TextviewerEncoding, TextviewerReadRequest, TextviewerRendererResult, TextviewerSnapshot,
} from './contract.ts'

export type {
  TextviewerEncoding, TextviewerReadRequest, TextviewerRendererResult, TextviewerSnapshot,
} from './contract.ts'

/** Default read chunk size in bytes. */
export const READ_DEFAULT_LIMIT = 256 * 1024
/** Hard ceiling for a submitted read `limit` (protects the host from huge pages). */
export const READ_MAX_LIMIT = 1024 * 1024
/** NUL probe window for the binary sniff (first chunk only). */
const BINARY_PROBE_BYTES = 8192

export interface TextviewerHandlerOptions {
  /**
   * Lazy renderer bundle reader; defaults to the built lib/renderer.js next
   * to this module. Tests inject a fake so the endpoint is exercisable
   * without a build.
   */
  readRenderer?: () => Promise<string>
  /**
   * Lazy DIAGRAM renderer bundle reader (the mermaid engine — a separate
   * artifact so the highlight worker never fetches a DOM-only bundle).
   * Defaults to lib/renderer-diagram.js; tests inject a fake.
   */
  readRendererDiagram?: () => Promise<string>
}

/** Default renderer-bundle reader: the built lib/renderer.js beside lib/index.js. */
const defaultReadRenderer = async (): Promise<string> => {
  return readFile(fileURLToPath(new URL('./renderer.js', import.meta.url)), 'utf8')
}

/** Default diagram-bundle reader: the built lib/renderer-diagram.js. */
const defaultReadRendererDiagram = async (): Promise<string> => {
  return readFile(fileURLToPath(new URL('./renderer-diagram.js', import.meta.url)), 'utf8')
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

/** Reusable strict UTF-8 decoder (fatal: the GBK fallback depends on it). */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode the bytes of one chunk, returning the text and the ACTUAL encoding
 * plus the byte count to report (after boundary trimming). The trim must
 * use the REAL encoding — a GBK trail byte that looks like a UTF-8 lead
 * would be wrongly trimmed under the provisional UTF-8, and a split UTF-8
 * tail would fail the strict decode before the trim gets a chance. Order:
 * strict UTF-8 on the raw chunk → UTF-8-trimmed retry → GBK (trimmed with
 * the GBK rule for a clean seam). BOM-detected/hinted encodings are
 * authoritative: trim with them directly.
 */
function decodeChunkBytes(
  buffer: Buffer,
  rawBytes: number,
  provisional: TextviewerEncoding,
  atEof: boolean,
): { text: string; encoding: TextviewerEncoding; bytes: number } {
  if (provisional === 'UTF-16LE' || provisional === 'UTF-16BE' || provisional === 'GBK') {
    const bytes = atEof ? rawBytes : trimToBoundary(buffer, rawBytes, provisional)
    const out = decodeChunk(buffer.subarray(0, bytes), provisional)
    return { text: out.text, encoding: out.encoding, bytes }
  }
  // Provisional UTF-8.
  try {
    const text = UTF8_STRICT.decode(buffer.subarray(0, rawBytes))
    return { text, encoding: 'UTF-8', bytes: rawBytes }
  } catch {
    // A split tail fails the raw strict decode — trim and retry.
  }
  const utfTrimmed = atEof ? rawBytes : trimToBoundary(buffer, rawBytes, 'UTF-8')
  try {
    const text = UTF8_STRICT.decode(buffer.subarray(0, utfTrimmed))
    return { text, encoding: 'UTF-8', bytes: utfTrimmed }
  } catch {
    // Genuinely not UTF-8 → legacy GBK, trimmed with the GBK rule.
  }
  const gbkBytes = atEof ? rawBytes : trimToBoundary(buffer, rawBytes, 'GBK')
  const out = decodeChunk(buffer.subarray(0, gbkBytes), 'GBK')
  return { text: out.text, encoding: out.encoding, bytes: gbkBytes }
}
export function decodeChunk(buffer: Buffer, provisional: TextviewerEncoding): { text: string; encoding: TextviewerEncoding } {
  if (provisional === 'UTF-16LE' || provisional === 'UTF-16BE') {
    return {
      text: new TextDecoder(provisional === 'UTF-16LE' ? 'utf-16le' : 'utf-16be').decode(buffer),
      encoding: provisional,
    }
  }
  if (provisional === 'GBK') {
    // An explicit encoding hint (a later chunk of a GBK file) decodes
    // directly — never through the UTF-8 attempt.
    return { text: iconv.decode(buffer, 'gbk'), encoding: 'GBK' }
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

/**
 * Trim a chunk tail so it ends on a complete character. A boundary cutting
 * a multi-byte character mid-sequence would otherwise corrupt decoding: a
 * UTF-8 chunk ending mid-character fails the STRICT decode and the WHOLE
 * chunk falls back to GBK — intermittent full-chunk mojibake in big files.
 * The trimmed bytes are re-read as the head of the next chunk (the client
 * offsets by the returned `bytes`), so nothing is lost.
 */
export function trimToBoundary(buffer: Buffer, bytes: number, encoding: TextviewerEncoding): number {
  if (encoding === 'UTF-8') {
    let i = bytes
    // Walk back over continuation bytes to the lead byte of the last sequence.
    while (i > 0 && (buffer[i - 1]! & 0xc0) === 0x80) i -= 1
    if (i === 0) return bytes // no lead in sight — malformed tail, keep as-is
    const lead = buffer[i - 1]!
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    return bytes - (i - 1) < need ? i - 1 : bytes
  }
  if (encoding === 'GBK' && bytes > 0) {
    // A trailing HIGH byte is either the trail half of a COMPLETE pair
    // (previous byte is a GBK lead 0x81–0xFE) or a LONE lead half of a
    // split pair — only the lone half is trimmed.
    const last = buffer[bytes - 1]!
    if (last < 0x80) return bytes
    if (bytes >= 2) {
      const prev = buffer[bytes - 2]!
      if (prev >= 0x81 && prev <= 0xfe && last !== 0x7f) return bytes // complete pair
    }
    return bytes - 1
  }
  return bytes
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
 * Read one decoded chunk of a file. The encoding comes from the caller's
 * HINT when provided (the first chunk's detected encoding, carried forward
 * by the client — stable per file, no re-detection surprises); otherwise it
 * is detected from the head (a 4–8 byte peek, first chunk only). UTF-16
 * offsets are aligned down to an even byte; non-final chunk tails are
 * trimmed to character boundaries (trimToBoundary) so a mid-character
 * boundary never corrupts the decode; the first chunk carries the binary
 * sniff.
 */
export async function readTextChunk(
  path: string,
  offset: number,
  limit: number,
  encodingHint: TextviewerEncoding | undefined,
  signal: AbortSignal,
): Promise<TextviewerSnapshot> {
  if (signal.aborted) throw new Error('read-text was aborted')
  const st = await stat(path)
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`)
  const handle = await open(path, 'r')
  try {
    let encoding = encodingHint
    if (encoding === undefined) {
      const head = Buffer.alloc(8)
      const headRead = await handle.read(head, 0, head.length, 0)
      encoding = detectEncoding(head.subarray(0, headRead.bytesRead))
    }
    const start = Math.min(alignOffset(offset, encoding), st.size)
    const want = Math.min(limit, st.size - start)
    const buffer = Buffer.alloc(want)
    const chunkRead = await handle.read(buffer, 0, want, start)
    const rawBytes = chunkRead.bytesRead
    const atEof = start + rawBytes >= st.size
    // Decode with boundary-aware trimming (decodeChunkBytes owns the
    // UTF-8/GBK ladder and reports the real byte count). At EOF there is no
    // next chunk to carry a partial sequence into — nothing is trimmed and
    // the fallback handles a malformed tail.
    const { text, encoding: actual, bytes } = decodeChunkBytes(buffer, rawBytes, encoding, atEof)
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
  const readRenderer = options.readRenderer ?? defaultReadRenderer
  const readRendererDiagram = options.readRendererDiagram ?? defaultReadRendererDiagram
  return async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    if (endpoint !== 'read-text' && endpoint !== 'renderer' && endpoint !== 'renderer-diagram') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `unknown textviewer endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      }
    }
    // Serves a lazy bundle source; no path inputs, so there is nothing to
    // scope — a build-less deployment surfaces the failure.
    const serveBundle = async (name: 'renderer' | 'renderer-diagram', reader: () => Promise<string>): Promise<RpcResult<unknown>> => {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: `textviewer ${name} was aborted`, details: {} } }
      }
      try {
        const code = await reader()
        return { ok: true, value: { code } satisfies TextviewerRendererResult }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'internal', message: `${name} bundle unavailable: ${error instanceof Error ? error.message : String(error)}`, details: {} },
        }
      }
    }
    if (endpoint === 'renderer') return serveBundle('renderer', readRenderer)
    if (endpoint === 'renderer-diagram') return serveBundle('renderer-diagram', readRendererDiagram)
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
    // Encoding stability: the client carries the first chunk's detected
    // encoding forward, so later chunks never re-fall-back (a GBK chunk that
    // happens to be valid UTF-8 must not flip mid-file).
    const encoding = (readPayload?.encoding as TextviewerEncoding | undefined) ?? undefined
    try {
      const snapshot = await readTextChunk(readPath, offset, limit, encoding, signal)
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
