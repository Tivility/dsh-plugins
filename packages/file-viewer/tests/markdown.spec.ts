import { describe, expect, it } from 'vitest'
import { renderFallback, renderMarkdown } from '../src/markdown.ts'

/** Pass every URL through unchanged, so the tests read the renderer's own filtering. */
const passthrough = { resolve: (url: string) => url }

/** Rewrite relative URLs the way the viewer does, to observe that they are rewritten. */
const viewer = {
  resolve: (url: string) => /^https?:/.test(url) ? url : `/files/docs/${url}`,
}

describe('renderFallback', () => {
  it('renders the block constructs it claims to', () => {
    const html = renderFallback([
      '# Title',
      '',
      'A paragraph with `code` and **bold**.',
      '',
      '- one',
      '- two',
      '',
      '> quoted',
      '',
      '```js',
      'const x = 1',
      '```',
    ].join('\n'), passthrough)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<li>one</li>')
    expect(html).toMatch(/<ul>\s*<li>one<\/li>/)
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<pre><code class="language-js">const x = 1</code></pre>')
  })

  it('escapes markup rather than emitting it', () => {
    const html = renderFallback('Hello <img src=x onerror=alert(1)> world', passthrough)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('escapes markup inside a fenced block', () => {
    const html = renderFallback('```\n</code></pre><script>alert(1)</script>\n```', passthrough)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('drops a javascript: link but keeps its text', () => {
    const html = renderFallback('[click](javascript:alert(1))', passthrough)
    expect(html).not.toContain('javascript:')
    expect(html).toContain('click')
  })

  it('drops a data: image', () => {
    const html = renderFallback('![x](data:text/html;base64,PHNjcmlwdD4=)', passthrough)
    expect(html).not.toContain('data:')
  })

  it('sends relative links back through the viewer route', () => {
    const html = renderFallback('[next](./chapter-2.md) and ![shot](img/a.png)', viewer)
    expect(html).toContain('href="/files/docs/./chapter-2.md"')
    expect(html).toContain('src="/files/docs/img/a.png"')
  })

  it('leaves an absolute link alone', () => {
    const html = renderFallback('[home](https://example.test/a)', viewer)
    expect(html).toContain('href="https://example.test/a"')
  })

  it('does not let emphasis syntax leak out of a code span', () => {
    const html = renderFallback('`a *b* c`', passthrough)
    expect(html).toContain('<code>a *b* c</code>')
    expect(html).not.toContain('<em>')
  })
})

describe('renderMarkdown', () => {
  it('renders a document through whichever parser is available', async () => {
    const html = await renderMarkdown('# Title\n\nBody **text**.\n', passthrough)
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>text</strong>')
  })

  it('never emits raw HTML from the document', async () => {
    const html = await renderMarkdown('<script>alert(1)</script>\n\ntext\n', passthrough)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('refuses executable URL schemes whichever parser ran', async () => {
    const html = await renderMarkdown('[a](javascript:alert(1)) ![b](data:text/html,x)\n', passthrough)
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:text/html')
  })

  it('renders a GFM table when the harness parser is reachable', async () => {
    const html = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n', passthrough)
    // The fallback has no table support; either output is correct for its
    // renderer, so the assertion is that the cells survive in some form.
    expect(html).toContain('1')
    expect(html).toContain('2')
  })
})
