/**
 * Shared /textviewer wire contract. Pure types only: both halves import
 * this module without pulling each other's runtime code into their bundles.
 */

/** One listed row (no git states in v1 — the viewer is format-focused). */
export interface TextviewerEntry {
  /** Base name shown in a row. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  kind: 'file' | 'dir'
  /** Byte size; absent when the probe could not produce one. */
  size?: number
  /** Last-modification epoch ms; absent when the probe could not produce one. */
  mtimeMs?: number
  /** Hidden by the platform's dot-prefix convention; the client owns whether to show it. */
  hidden: boolean
}

/** The list response value. */
export interface TextviewerListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Direct children, directories first then name-sorted. */
  entries: TextviewerEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** list request payload; an absent path lists the root (or the host process cwd). */
export interface TextviewerListRequest {
  path?: string
  /**
   * Locked root (the session workspace): when present, `path` must equal it
   * or descend from it — the viewer cannot escape the workspace.
   */
  root?: string
}

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
}

/** renderer response value: the lazy renderer bundle source (self-contained). */
export interface TextviewerRendererResult {
  /** JavaScript source of the renderer bundle (one factory expression). */
  code: string
}

