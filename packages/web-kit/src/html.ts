/**
 * The minimal HTML shell the plugin pages share.
 *
 * These pages exist so a browser can look at something the harness produced
 * without a GUI on the same machine; they are not an application. The style
 * block below is the whole design system on purpose — it inlines, so no page
 * needs a second request or a route to serve one from, and it follows the
 * reader's colour scheme rather than choosing one.
 * @module @tivility/dsh-web-kit/html
 */

/** Characters that would otherwise close or open markup. */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape text for interpolation into markup.
 *
 * Every one of these pages renders bytes the harness wrote — filenames,
 * directory entries, file contents — so nothing interpolated here is
 * trustworthy. Both quote styles are escaped so the same function is safe in
 * an attribute as in a text node.
 * @param value - untrusted text.
 * @returns the text with markup-significant characters replaced.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ESCAPES[character] ?? character)
}

/**
 * Percent-encode one path segment for use in a URL.
 *
 * `encodeURIComponent` leaves `'` alone, which would close an attribute this
 * package quotes with `'` nowhere — but a filename containing one still has
 * to survive `escapeHtml` afterwards, so the two are always applied together.
 * @param segment - a single filename, undecoded.
 * @returns the encoded segment.
 */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment)
}

/** The shared stylesheet, inlined into every page. */
const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6a6a6a; --bg: #ffffff; --line: #e3e3e3; --accent: #0b62d0; --code-bg: #f6f6f7; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e6e6; --muted: #9a9a9a; --bg: #161618; --line: #2c2c30; --accent: #6aa9f0; --code-bg: #1e1e22; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg); font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 1.25rem; word-break: break-all; }
h1 a, .crumbs a { color: var(--accent); text-decoration: none; }
h1 a:hover, .crumbs a:hover { text-decoration: underline; }
.crumbs { color: var(--muted); font-weight: 400; }
ul.listing { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
ul.listing li { border-bottom: 1px solid var(--line); }
ul.listing a { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.5rem 0.25rem; color: inherit; text-decoration: none; }
ul.listing a:hover { background: var(--code-bg); }
ul.listing .name { flex: 1; word-break: break-all; }
ul.listing .meta { color: var(--muted); font-size: 0.85em; font-variant-numeric: tabular-nums; white-space: nowrap; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 0.9rem 1rem; overflow-x: auto; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
pre code { background: none; padding: 0; }
img, video { max-width: 100%; height: auto; }
iframe.embed { width: 100%; height: 80vh; border: 1px solid var(--line); border-radius: 6px; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--line); padding: 0.35rem 0.6rem; text-align: left; }
blockquote { margin: 0 0 1rem; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
.empty, .note { color: var(--muted); }
`.trim()

/**
 * Wrap body markup in the shared document shell.
 * @param title - document title; escaped by this function.
 * @param body - markup for `<main>`, already escaped by its producer.
 * @param extraStyle - additional CSS appended to the shared stylesheet.
 * @returns a complete HTML document.
 */
export function page(title: string, body: string, extraStyle = ''): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}${extraStyle === '' ? '' : `\n${extraStyle}`}</style>
<main>${body}</main>
</html>
`
}

/**
 * Render a byte count the way a directory listing wants it.
 * @param bytes - size in bytes.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'TB'}`
}
