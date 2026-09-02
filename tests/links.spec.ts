/**
 * Markdown link resolution tests: local file links must resolve against the
 * viewed file's directory and never escape the drive root (the viewer's own
 * link interceptor; web links go to new tabs instead).
 */
import { describe, expect, it } from 'vitest'
import { resolveLocalLink } from '../src/client/TextViewer.tsx'

describe('resolveLocalLink', () => {
  const base = 'D:/workspace/docs'

  it('keeps absolute drive-letter paths', () => {
    expect(resolveLocalLink('D:\\other\\a.md', base)).toBe('D:/other/a.md')
    expect(resolveLocalLink('D:/other/a.md', base)).toBe('D:/other/a.md')
  })

  it('joins relative links against the viewed file directory', () => {
    expect(resolveLocalLink('./a.md', base)).toBe('D:/workspace/docs/a.md')
    expect(resolveLocalLink('a.md', base)).toBe('D:/workspace/docs/a.md')
    expect(resolveLocalLink('sub/../a.md', base)).toBe('D:/workspace/docs/a.md')
    expect(resolveLocalLink('../a.md', base)).toBe('D:/workspace/a.md')
  })

  it('never escapes above the drive root', () => {
    expect(resolveLocalLink('../../../../a.md', 'D:/root')).toBe('D:/a.md')
  })

  it('keeps UNC prefixes', () => {
    expect(resolveLocalLink('\\\\server\\share\\a.md', base)).toBe('//server/share/a.md')
  })

  it('resolves percent-encoded hrefs after decoding (react-markdown output)', () => {
    const encoded = '%E7%BB%8F%E9%AA%8C%E8%AE%B0%E5%BD%95/02-%E6%8C%82%E8%BD%BD%E6%96%B9%E5%BC%8F.md'
    const decoded = decodeURIComponent(encoded)
    expect(decoded).toBe('经验记录/02-挂载方式.md')
    expect(resolveLocalLink(decoded, 'D:/_dev/dsh-plugins')).toBe('D:/_dev/dsh-plugins/经验记录/02-挂载方式.md')
  })
})
