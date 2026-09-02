/**
 * /textviewer host tests: the handler factory exercised directly (no ctx),
 * with real files in a temporary directory. Encoding fixtures cover the
 * BOM/fallback ladder; chunking covers byte paging and UTF-16 alignment.
 * There is no listing coverage by design — the file tree belongs to the
 * ui-cw-fileexplorer plugin, not this channel.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  clampReadLimit, createTextviewerHandler, decodeChunk, detectEncoding, isWithin,
  readTextChunk, trimToBoundary, READ_DEFAULT_LIMIT, READ_MAX_LIMIT,
} from '../src/handler.ts'
import type { TextviewerSnapshot } from '../src/contract.ts'

/** Assert the result is the success branch and return the snapshot. */
function expectSnapshot(result: unknown): TextviewerSnapshot {
  const r = result as { ok: true; value: TextviewerSnapshot } | { ok: false; error: { code: string } }
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: TextviewerSnapshot }).value
}

/** UTF-16BE bytes from a string, with an optional BOM prefix. */
function utf16be(text: string, bom = false): Buffer {
  const le = Buffer.from(text, 'utf16le')
  const out = Buffer.alloc(le.length)
  for (let i = 0; i < le.length; i += 2) {
    out[i] = le[i + 1]!
    out[i + 1] = le[i]!
  }
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), out]) : out
}

describe('clampReadLimit', () => {
  it('defaults and clamps into [1, READ_MAX_LIMIT]', () => {
    expect(clampReadLimit(undefined)).toBe(READ_DEFAULT_LIMIT)
    expect(clampReadLimit(0)).toBe(1)
    expect(clampReadLimit(-5)).toBe(1)
    expect(clampReadLimit(Number.POSITIVE_INFINITY)).toBe(READ_DEFAULT_LIMIT)
    expect(clampReadLimit(READ_MAX_LIMIT * 10)).toBe(READ_MAX_LIMIT)
    expect(clampReadLimit(1024)).toBe(1024)
  })
})

describe('encoding detection', () => {
  it('detects BOMs', () => {
    expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('UTF-8')
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe('UTF-16LE')
    expect(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe('UTF-16BE')
    expect(detectEncoding(Buffer.from([0x61, 0x62]))).toBe('UTF-8')
  })

  it('falls back to GBK only when strict UTF-8 decoding fails', () => {
    // GBK bytes for 中文 (0xD6 0xD0 0xCE 0xC4) are not valid UTF-8.
    expect(decodeChunk(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'UTF-8')).toEqual({ text: '中文', encoding: 'GBK' })
    expect(decodeChunk(Buffer.from('hello'), 'UTF-8')).toEqual({ text: 'hello', encoding: 'UTF-8' })
  })

  it('decodes UTF-16 chunks through the WHATWG decoders', () => {
    expect(decodeChunk(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]), 'UTF-16LE')).toEqual({ text: 'hi', encoding: 'UTF-16LE' })
    expect(decodeChunk(utf16be('hi', true), 'UTF-16BE')).toEqual({ text: 'hi', encoding: 'UTF-16BE' })
  })
})

describe('isWithin', () => {
  it('compares exactly on the platform separator (case-insensitive on win32)', () => {
    const root = process.platform === 'win32' ? 'C:\\work' : '/work'
    const inside = process.platform === 'win32' ? 'C:\\work\\a\\b' : '/work/a/b'
    const sibling = process.platform === 'win32' ? 'C:\\workspace' : '/workspace'
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(root, inside)).toBe(true)
    expect(isWithin(root, sibling)).toBe(false)
  })
})

describe('trimToBoundary', () => {
  it('keeps complete UTF-8 sequences and trims split tails', () => {
    // 字 = E8 AF 97 (3 bytes). Complete triple → untouched.
    const full = Buffer.from('字', 'utf8')
    expect(trimToBoundary(full, 3, 'UTF-8')).toBe(3)
    // Split tail: E8 AF only (2 of 3 bytes) → trim both.
    expect(trimToBoundary(full, 2, 'UTF-8')).toBe(0)
    // ASCII tail untouched.
    expect(trimToBoundary(Buffer.from('ab'), 2, 'UTF-8')).toBe(2)
  })

  it('trims a trailing GBK pair half', () => {
    // 汉 = BA BA (2 bytes). Complete pair untouched; a lone trailing half trims.
    const pair = Buffer.from([0xba, 0xba])
    expect(trimToBoundary(pair, 2, 'GBK')).toBe(2)
    expect(trimToBoundary(pair, 1, 'GBK')).toBe(0)
    expect(trimToBoundary(Buffer.from([0x61, 0xba]), 2, 'GBK')).toBe(1)
  })
})

describe('textviewer handler', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'textviewer-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects unknown endpoints', async () => {
    const handler = createTextviewerHandler()
    const result = await handler('nope', {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('bad-request')
  })

  it('serves the lazy renderer bundle through the renderer endpoint', async () => {
    const handler = createTextviewerHandler({ readRenderer: async () => '/* renderer bundle */' })
    const result = await handler('renderer', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    const value = (result as { ok: true; value: { code: string } }).value
    expect(value.code).toContain('renderer bundle')
  })

  it('reports an unavailable renderer bundle', async () => {
    const handler = createTextviewerHandler({
      readRenderer: async () => { throw new Error('lib/renderer.js missing') },
    })
    const result = await handler('renderer', {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('missing')
  })

  it('reads a UTF-8 file whole', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, '第一行\n第二行\n')
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(snapshot.content).toBe('第一行\n第二行\n')
    expect(snapshot.encoding).toBe('UTF-8')
    expect(snapshot.size).toBe(Buffer.byteLength('第一行\n第二行\n'))
    expect(snapshot.offset).toBe(0)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.binary).toBe(false)
    expect(snapshot.lineCount).toBe(2)
  })

  it('reads a UTF-16LE file (BOM stripped by the decoder)', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]))
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(snapshot.content).toBe('hello\n')
    expect(snapshot.encoding).toBe('UTF-16LE')
    expect(snapshot.lineCount).toBe(1)
  })

  it('reads a UTF-16BE file', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, utf16be('hello\n', true))
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(snapshot.content).toBe('hello\n')
    expect(snapshot.encoding).toBe('UTF-16BE')
  })

  it('falls back to GBK for BOM-less legacy Chinese', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\r\n')]))
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(snapshot.content).toBe('中文\r\n')
    expect(snapshot.encoding).toBe('GBK')
    expect(snapshot.lineCount).toBe(1)
  })

  it('sniffs NUL bytes as binary on the first chunk', async () => {
    const file = join(root, 'a.bin')
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]))
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(snapshot.binary).toBe(true)
  })

  it('pages a large file with byte offsets and limits', async () => {
    const file = join(root, 'big.txt')
    await writeFile(file, Buffer.alloc(600 * 1024, 0x61))
    const handler = createTextviewerHandler()
    const first = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(first.bytes).toBe(READ_DEFAULT_LIMIT)
    expect(first.content.length).toBe(READ_DEFAULT_LIMIT)
    expect(first.truncated).toBe(true)
    // The remainder arrives in one page when the client submits a big limit.
    const second = expectSnapshot(await handler(
      'read-text', { root, path: file, offset: first.offset + first.bytes, limit: READ_MAX_LIMIT }, new AbortController().signal,
    ))
    expect(second.offset).toBe(READ_DEFAULT_LIMIT)
    expect(second.content.length).toBe(600 * 1024 - READ_DEFAULT_LIMIT)
    expect(second.truncated).toBe(false)
    // Appending the chunks reproduces the file exactly.
    expect(first.content + second.content).toBe('a'.repeat(600 * 1024))
  })

  it('keeps chunk boundaries on character edges — a mid-character split never corrupts decoding', async () => {
    // 字 = 3 UTF-8 bytes: 262144 % 3 = 1, so the default chunk boundary cuts
    // a character. Before the trim this chunk failed strict UTF-8 and the
    // WHOLE 256KB fell back to GBK (intermittent big-file mojibake).
    const file = join(root, 'utf8-big.txt')
    const text = '字'.repeat(90000) // 270000 bytes
    await writeFile(file, text, 'utf8')
    const handler = createTextviewerHandler()
    const first = expectSnapshot(await handler('read-text', { root, path: file }, new AbortController().signal))
    expect(first.encoding).toBe('UTF-8')
    expect(first.bytes % 3).toBe(0) // trimmed to a character edge
    const second = expectSnapshot(await handler(
      'read-text', { root, path: file, offset: first.offset + first.bytes }, new AbortController().signal,
    ))
    expect(second.encoding).toBe('UTF-8')
    // The trimmed bytes are re-read as the next chunk's head — lossless join.
    expect(first.content + second.content).toBe(text)
  })

  it('carries the encoding hint forward so multi-chunk GBK stays stable', async () => {
    const file = join(root, 'gbk-big.txt')
    // 中 in GBK = D6 D0 (2 bytes) — built manually, no iconv in tests.
    const pair = Buffer.from([0xd6, 0xd0])
    const text = '中'.repeat(4000) // 8000 GBK bytes
    await writeFile(file, Buffer.concat(Array.from({ length: 4000 }, () => pair)))
    const handler = createTextviewerHandler()
    const first = expectSnapshot(await handler(
      'read-text', { root, path: file, limit: 3000 }, new AbortController().signal,
    ))
    expect(first.encoding).toBe('GBK')
    // The client sends the first chunk's encoding as the hint for later ones.
    const second = expectSnapshot(await handler(
      'read-text', { root, path: file, offset: 3000, limit: 3000, encoding: 'GBK' }, new AbortController().signal,
    ))
    expect(second.encoding).toBe('GBK')
    const third = expectSnapshot(await handler(
      'read-text', { root, path: file, offset: 6000, limit: 3000, encoding: 'GBK' }, new AbortController().signal,
    ))
    expect(first.content + second.content + third.content).toBe(text)
    expect(second.bytes % 2).toBe(0) // GBK pairs stay intact
  })

  it('clamps a submitted limit and aligns UTF-16 offsets to even bytes', async () => {
    const file = join(root, 'u16.txt')
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]))
    const handler = createTextviewerHandler()
    // Odd offset 5 aligns down to 4 → the BOM is skipped and 'ello' stays intact.
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file, offset: 5, limit: 1000 }, new AbortController().signal))
    expect(snapshot.offset).toBe(4)
    expect(snapshot.content).toBe('ello')
    expect(snapshot.encoding).toBe('UTF-16LE')
  })

  it('returns an empty chunk past the end of the file', async () => {
    const file = join(root, 'a.txt')
    await writeFile(file, 'hi')
    const handler = createTextviewerHandler()
    const snapshot = expectSnapshot(await handler('read-text', { root, path: file, offset: 100 }, new AbortController().signal))
    expect(snapshot.content).toBe('')
    expect(snapshot.truncated).toBe(false)
  })

  it('enforces the locked workspace root on read-text', async () => {
    const outside = resolve(root, '..', 'outside.txt')
    await writeFile(outside, 'x')
    const handler = createTextviewerHandler()
    const result = await handler('read-text', { root, path: outside }, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('escapes')
    await rm(outside, { force: true })
  })

  it('fails cleanly for a missing file and a directory target', async () => {
    const handler = createTextviewerHandler()
    const missing = await handler('read-text', { root, path: join(root, 'nope.txt') }, new AbortController().signal)
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.error.code).toBe('directory-unreadable')
    const dir = await handler('read-text', { root, path: root }, new AbortController().signal)
    expect(dir.ok).toBe(false)
    expect(dir.ok ? '' : dir.error.message).toContain('not a regular file')
  })
})
