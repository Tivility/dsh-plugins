import { describe, expect, it } from 'vitest'
import { escapeHtml, formatBytes, page } from '../src/html.ts'

describe('escapeHtml', () => {
  it('neutralizes markup in text and in either quote style', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escapeHtml(`" onload='x'`)).toBe('&quot; onload=&#39;x&#39;')
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })
})

describe('page', () => {
  it('escapes the title but leaves the caller-built body alone', () => {
    const html = page('<x>', '<p>body</p>')
    expect(html).toContain('<title>&lt;x&gt;</title>')
    expect(html).toContain('<main><p>body</p></main>')
  })

  it('asks crawlers to stay away from workspace bytes', () => {
    expect(page('t', '')).toContain('noindex')
  })
})

describe('formatBytes', () => {
  it('scales to the largest unit that keeps the number small', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
})
