/**
 * Markdown rendering for the preview pages.
 *
 * Two renderers behind one function. The preferred path parses with the
 * harness's own Markdown stack — `mdast-util-from-markdown` plus the GFM
 * extensions, which the harness already depends on for its chat rendering —
 * and walks the resulting syntax tree here. Parsing is the part that is hard
 * to get right; emitting HTML from a tree is not, and doing it here is what
 * keeps escaping under this package's control.
 *
 * That stack is reached through a runtime `import()` rather than a declared
 * dependency, because declaring it would install a second copy of a parser
 * the harness already ships. When the profile's layout does not put it on the
 * resolution path, the built-in renderer below takes over: less faithful (no
 * tables, no reference links), never absent.
 *
 * Nothing in a Markdown file is trusted. Raw HTML blocks are escaped rather
 * than emitted — a workspace README rendering as live markup would be script
 * execution in the harness's own origin — and every URL is filtered to the
 * schemes that cannot execute.
 * @module @tivility/dsh-file-viewer/markdown
 */

import { escapeHtml } from '@tivility/dsh-web-kit'

/** How a Markdown document resolves the links it contains. */
export interface MarkdownLinks {
  /**
   * Rewrite one URL as written in the document.
   * @param url - the raw href or src.
   * @returns the URL to emit, or undefined to drop the link and keep its text.
   */
  resolve(url: string): string | undefined
}

/** URL schemes a rendered document may link to. */
const SAFE_SCHEME = /^(https?:|mailto:|#)/i

/**
 * Whether a URL is one this renderer will emit.
 *
 * Anything carrying a scheme that is not explicitly allowed is dropped, which
 * is what keeps `javascript:` and `data:` out of an href built from workspace
 * bytes. A URL with no scheme at all is relative, and the caller's resolver
 * decides what it points at.
 * @param url - the raw URL from the document.
 * @returns true when the URL may be emitted.
 */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim()
  if (SAFE_SCHEME.test(trimmed)) return true
  // A colon appearing before any slash is a scheme; without one this is relative.
  const colon = trimmed.indexOf(':')
  const slash = trimmed.indexOf('/')
  return colon === -1 || (slash !== -1 && slash < colon)
}

/**
 * Resolve one document URL through the scheme filter and the caller's rewriter.
 * @param url - the raw href or src.
 * @param links - the caller's resolver.
 * @returns an emittable URL, or undefined when the link must be dropped.
 */
function safeUrl(url: string, links: MarkdownLinks): string | undefined {
  if (!isSafeUrl(url)) return undefined
  return links.resolve(url)
}

/** Heading levels the renderer emits; anything else clamps into range. */
function headingTag(depth: number | undefined): string {
  return `h${String(Math.min(6, Math.max(1, depth ?? 1)))}`
}

/* ------------------------------------------------------------------ mdast */

/** The fields this renderer reads from an mdast node; which ones exist depends on `type`. */
interface MdNode {
  type: string
  value?: string
  url?: string
  alt?: string | null
  lang?: string | null
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  align?: (string | null)[] | null
  children?: MdNode[]
}

/**
 * Render an mdast node list.
 * @param nodes - the children to render.
 * @param links - URL resolver.
 * @returns HTML for the nodes, concatenated.
 */
function renderNodes(nodes: readonly MdNode[] | undefined, links: MarkdownLinks): string {
  return (nodes ?? []).map(node => renderNode(node, links)).join('')
}

/**
 * Render one mdast node.
 * @param node - the node to render.
 * @param links - URL resolver.
 * @returns HTML for the node.
 */
function renderNode(node: MdNode, links: MarkdownLinks): string {
  switch (node.type) {
    case 'root':
      return renderNodes(node.children, links)
    case 'paragraph':
      return `<p>${renderNodes(node.children, links)}</p>`
    case 'heading': {
      const tag = headingTag(node.depth)
      return `<${tag}>${renderNodes(node.children, links)}</${tag}>`
    }
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'emphasis':
      return `<em>${renderNodes(node.children, links)}</em>`
    case 'strong':
      return `<strong>${renderNodes(node.children, links)}</strong>`
    case 'delete':
      return `<del>${renderNodes(node.children, links)}</del>`
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`
    case 'break':
      return '<br>'
    case 'thematicBreak':
      return '<hr>'
    case 'blockquote':
      return `<blockquote>${renderNodes(node.children, links)}</blockquote>`
    case 'code': {
      const language = node.lang == null ? '' : ` class="language-${escapeHtml(node.lang)}"`
      return `<pre><code${language}>${escapeHtml(node.value ?? '')}</code></pre>`
    }
    case 'list': {
      const tag = node.ordered === true ? 'ol' : 'ul'
      const start = node.ordered === true && node.start != null && node.start !== 1
        ? ` start="${String(node.start)}"`
        : ''
      return `<${tag}${start}>${renderNodes(node.children, links)}</${tag}>`
    }
    case 'listItem': {
      const box = node.checked == null
        ? ''
        : `<input type="checkbox" disabled${node.checked ? ' checked' : ''}> `
      return `<li>${box}${renderNodes(node.children, links)}</li>`
    }
    case 'link': {
      const href = safeUrl(node.url ?? '', links)
      if (href === undefined) return renderNodes(node.children, links)
      return `<a href="${escapeHtml(href)}" rel="noreferrer">${renderNodes(node.children, links)}</a>`
    }
    case 'image': {
      const alt = escapeHtml(node.alt ?? '')
      const src = safeUrl(node.url ?? '', links)
      if (src === undefined) return alt
      return `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">`
    }
    case 'table': {
      const [head, ...body] = node.children ?? []
      const align = node.align ?? []
      const headHtml = head === undefined ? '' : `<thead>${renderRow(head, links, true, align)}</thead>`
      const bodyHtml = body.length === 0
        ? ''
        : `<tbody>${body.map(row => renderRow(row, links, false, align)).join('')}</tbody>`
      return `<table>${headHtml}${bodyHtml}</table>`
    }
    case 'tableRow':
      return renderRow(node, links, false, [])
    case 'tableCell':
      return renderNodes(node.children, links)
    case 'html':
      // Escaped, never emitted: this is workspace content, and rendering it
      // would put author-controlled markup in the harness's own origin.
      return `<code>${escapeHtml(node.value ?? '')}</code>`
    case 'definition':
    case 'footnoteReference':
      return ''
    default:
      return renderNodes(node.children, links)
  }
}

/**
 * Render one table row.
 * @param row - the tableRow node.
 * @param links - URL resolver.
 * @param header - whether the cells are `th`.
 * @param align - per-column alignment carried by the table node.
 * @returns HTML for the row.
 */
function renderRow(
  row: MdNode,
  links: MarkdownLinks,
  header: boolean,
  align: readonly (string | null)[],
): string {
  const tag = header ? 'th' : 'td'
  const cells = (row.children ?? []).map((cell, index) => {
    const at = align[index]
    const style = at == null ? '' : ` style="text-align:${escapeHtml(at)}"`
    return `<${tag}${style}>${renderNodes(cell.children, links)}</${tag}>`
  })
  return `<tr>${cells.join('')}</tr>`
}

/** The one export this package uses from `mdast-util-from-markdown`. */
interface FromMarkdownModule {
  fromMarkdown(value: string, options?: unknown): MdNode
}

/**
 * Parse with the harness's Markdown stack, when it is reachable.
 * @param source - the document text.
 * @returns the mdast root, or undefined when the stack is not installed.
 */
async function parseWithMdast(source: string): Promise<MdNode | undefined> {
  try {
    const [core, syntax, ast] = await Promise.all([
      import('mdast-util-from-markdown') as Promise<FromMarkdownModule>,
      import('micromark-extension-gfm') as Promise<{ gfm(): unknown }>,
      import('mdast-util-gfm') as Promise<{ gfmFromMarkdown(): unknown[] }>,
    ])
    return core.fromMarkdown(source, {
      extensions: [syntax.gfm()],
      mdastExtensions: [ast.gfmFromMarkdown()],
    })
  } catch {
    // Absent from this profile's layout, or a version whose shape moved. The
    // fallback renders the same document either way, so there is nothing here
    // worth failing a page request over.
    return undefined
  }
}

/* --------------------------------------------------------------- fallback */

/**
 * Placeholders wrapping an extracted code span while the other inline rules
 * run. Control characters are used because Markdown source cannot contain
 * them, so no document can forge a placeholder and have its own text
 * substituted back in as somebody else's code span.
 */
const CODE_OPEN = '\u0000'
const CODE_CLOSE = '\u0001'

/**
 * Render the inline spans of one block.
 *
 * Code spans are lifted out before anything else runs and put back at the
 * end, so their contents never pick up emphasis or link syntax.
 * @param text - raw block text, not yet escaped.
 * @param links - URL resolver.
 * @returns HTML for the block's inline content.
 */
function renderInline(text: string, links: MarkdownLinks): string {
  const codes: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `${CODE_OPEN}${String(codes.length - 1)}${CODE_CLOSE}`
  })
  out = escapeHtml(out)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) => {
    const src = safeUrl(url, links)
    return src === undefined ? alt : `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">`
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const href = safeUrl(url, links)
    return href === undefined ? label : `<a href="${escapeHtml(href)}" rel="noreferrer">${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  const placeholder = new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g')
  return out.replace(placeholder, (_match, index: string) => codes[Number(index)] ?? '')
}

/**
 * Render Markdown without the harness's parser.
 *
 * Block-level, single pass, no reference links and no tables. It exists so a
 * profile whose layout hides the parser still shows a readable document
 * instead of a wall of source.
 * @param source - the document text.
 * @param links - URL resolver.
 * @returns HTML for the document body.
 */
export function renderFallback(source: string, links: MarkdownLinks): string {
  const out: string[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: 'ul' | 'ol' | undefined
  let index = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${renderInline(paragraph.join('\n'), links)}</p>`)
    paragraph = []
  }
  const closeList = (): void => {
    if (list === undefined) return
    out.push(`</${list}>`)
    list = undefined
  }
  const openList = (kind: 'ul' | 'ol'): void => {
    if (list === kind) return
    closeList()
    out.push(`<${kind}>`)
    list = kind
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const fence = /^\s*(```|~~~)(.*)$/.exec(line)
    if (fence !== null) {
      flushParagraph()
      closeList()
      const marker = fence[1] ?? '```'
      const language = (fence[2] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(marker)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const attribute = language === '' ? '' : ` class="language-${escapeHtml(language)}"`
      out.push(`<pre><code${attribute}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    index += 1

    if (line.trim() === '') {
      flushParagraph()
      closeList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      closeList()
      const tag = headingTag((heading[1] ?? '#').length)
      out.push(`<${tag}>${renderInline((heading[2] ?? '').trim(), links)}</${tag}>`)
      continue
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph()
      closeList()
      out.push('<hr>')
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      closeList()
      out.push(`<blockquote><p>${renderInline(quote[1] ?? '', links)}</p></blockquote>`)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      flushParagraph()
      openList('ul')
      out.push(`<li>${renderInline(bullet[1] ?? '', links)}</li>`)
      continue
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (numbered !== null) {
      flushParagraph()
      openList('ol')
      out.push(`<li>${renderInline(numbered[1] ?? '', links)}</li>`)
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  closeList()
  return out.join('\n')
}

/**
 * Render a Markdown document to HTML.
 * @param source - the document text.
 * @param links - URL resolver for the links it contains.
 * @returns HTML for the document body.
 */
export async function renderMarkdown(source: string, links: MarkdownLinks): Promise<string> {
  const tree = await parseWithMdast(source)
  return tree === undefined ? renderFallback(source, links) : renderNode(tree, links)
}
