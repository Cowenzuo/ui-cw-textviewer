/**
 * Shared /textviewer wire contract. Pure types only: both halves import
 * this module without pulling each other's runtime code into their bundles.
 *
 * There is deliberately NO listing contract here: the file tree belongs to
 * the ui-cw-fileexplorer plugin, which broadcasts open-file events (see
 * TextviewerOpenEvent) that this viewer subscribes to.
 */

/** Encodings the reader can serve (BOM-detected UTF-8/16, or GBK fallback). */
export type TextviewerEncoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'GBK'

/** One decoded text chunk. */
export interface TextviewerSnapshot {
  /** Absolute host path of the read file. */
  path: string
  /** Total byte size of the file (drives chunked paging). */
  size: number
  /** Byte offset this chunk starts at (aligned to a code-unit boundary). */
  offset: number
  /** Bytes actually read into this chunk (≤ the requested limit). */
  bytes: number
  /** Decoded text of this chunk. */
  content: string
  /** Encoding the chunk was decoded as. */
  encoding: TextviewerEncoding
  /** Lines in this chunk's content (a trailing newline closes the last line, it does not open a new one). */
  lineCount: number
  /** True when more bytes remain after this chunk. */
  truncated: boolean
  /** True when the file carries NUL bytes in its head (not a text file). */
  binary: boolean
}

/** read-text request payload: one chunk of one file, inside the locked root. */
export interface TextviewerReadRequest {
  /** Locked root (the session workspace); `path` must stay inside it. */
  root: string
  /** Absolute host path of the file to read. */
  path: string
  /** Byte offset of the chunk; the host aligns it for multi-byte encodings. */
  offset?: number
  /** Byte size of the chunk; the host clamps it to a sane bound. */
  limit?: number
  /**
   * Encoding hint carried forward from the first chunk's detection: later
   * chunks decode with it directly (no re-detection, no fallback flips).
   * Absent on the first chunk — the host detects.
   */
  encoding?: TextviewerEncoding
}

/** renderer response value: the lazy renderer bundle source (self-contained). */
export interface TextviewerRendererResult {
  /** JavaScript source of the renderer bundle (one factory expression). */
  code: string
}

/**
 * Cross-plugin open-file event (client-side, broadcast by
 * ui-cw-fileexplorer through the cordis event bus — event name
 * `ui-cw/fileexplorer/file-open`, emitted on the emitter's scope and
 * received on the root context). Carries the locked workspace root with the
 * file so the receiver never needs its own listing.
 */
export interface TextviewerOpenEvent {
  /** Base name shown in headers. */
  name: string
  /** Absolute host path of the file to open. */
  path: string
  /** Locked workspace root the file lives in (read-text scope). */
  root: string
}
