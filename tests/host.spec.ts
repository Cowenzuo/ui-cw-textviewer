/**
 * /textviewer host tests: the handler factory exercised directly (no ctx),
 * with real files in a temporary directory. Encoding fixtures cover the
 * BOM/fallback ladder; chunking covers byte paging and UTF-16 alignment.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  clampReadLimit, createTextviewerHandler, decodeChunk, detectEncoding, isWithin,
  parseAttribOutput, READ_DEFAULT_LIMIT, READ_MAX_LIMIT,
} from '../src/handler.ts'
import type { TextviewerListing, TextviewerSnapshot } from '../src/contract.ts'

/** Assert the result is the success branch and return the listing. */
function expectListing(result: unknown): TextviewerListing {
  const r = result as { ok: true; value: TextviewerListing } | { ok: false; error: { code: string } }
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: TextviewerListing }).value
}

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

describe('parseAttribOutput', () => {
  it('collects hidden attribute rows only', () => {
    const output = [
      'A  H          C:\\work\\.git',
      'A             C:\\work\\readme.md',
      'A  H          "C:\\work\\my dir\\secret.txt"',
    ].join('\r\n')
    const hidden = parseAttribOutput(output)
    expect(hidden.has('c:\\work\\.git')).toBe(true)
    expect(hidden.has('c:\\work\\readme.md')).toBe(false)
    expect(hidden.has('c:\\work\\my dir\\secret.txt')).toBe(true)
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

  it('lists a level: directories first, then name-sorted files', async () => {
    await mkdir(join(root, 'zeta-dir'))
    await mkdir(join(root, 'alpha-dir'))
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'a.txt'), 'a')
    const handler = createTextviewerHandler()
    const listing = expectListing(await handler('list', { root, path: root, }, new AbortController().signal))
    expect(listing.path).toBe(root)
    expect(listing.entries.map(entry => entry.name)).toEqual(['alpha-dir', 'zeta-dir', 'a.txt', 'b.txt'])
    expect(listing.entries.every(entry => entry.hidden === false)).toBe(true)
    const file = listing.entries.find(entry => entry.name === 'a.txt')
    expect(file?.kind).toBe('file')
    expect(file?.size).toBe(1)
    expect(file?.mtimeMs).toBeTypeOf('number')
  })

  it('marks hidden entries through the injected reader', async () => {
    await writeFile(join(root, 'secret.txt'), 's')
    const hiddenPath = join(root, 'secret.txt')
    const handler = createTextviewerHandler({
      readHidden: async () => new Set([hiddenPath.toLowerCase()]),
    })
    const listing = expectListing(await handler('list', { root, path: root }, new AbortController().signal))
    expect(listing.entries.find(entry => entry.name === 'secret.txt')?.hidden).toBe(true)
  })

  it('cuts levels at the complete-result bound', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await writeFile(join(root, 'c.txt'), 'c')
    const handler = createTextviewerHandler({ maxEntries: 2 })
    const listing = expectListing(await handler('list', { root, path: root }, new AbortController().signal))
    expect(listing.entries).toHaveLength(2)
    expect(listing.truncated).toBe(true)
  })

  it('enforces the locked workspace root on list', async () => {
    const outside = resolve(root, '..')
    const handler = createTextviewerHandler()
    const result = await handler('list', { root, path: outside }, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.message).toContain('escapes')
  })

  it('rejects unqualified paths on list', async () => {
    const handler = createTextviewerHandler()
    const result = await handler('list', { root, path: 'relative/path' }, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('directory-unreadable')
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
