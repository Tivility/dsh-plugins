/**
 * The four pages this plugin serves: the root index, a directory listing, a
 * rendered document, and the wrapper around a file the browser displays
 * itself.
 *
 * Every one of them is built from bytes the harness produced, so every
 * interpolation goes through `escapeHtml` — including filenames, which are
 * attacker-controllable in any workspace holding cloned code.
 * @module @tivility/dsh-file-viewer/pages
 */

import type { Dirent, Stats } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { escapeHtml, formatBytes, page } from '@tivility/dsh-web-kit'
import type { Crumb } from './paths.js'
import { toRequestPath } from './paths.js'

/** One row of a directory listing, already resolved. */
export interface Entry {
  readonly name: string
  readonly directory: boolean
  readonly size: number
  readonly mtimeMs: number
}

/**
 * Render the breadcrumb trail as the page heading.
 * @param crumbs - the trail from the root down to the current path.
 * @returns HTML for the heading's inner content.
 */
function renderCrumbs(crumbs: readonly Crumb[]): string {
  return crumbs
    .map(crumb => crumb.href === undefined
      ? escapeHtml(crumb.name)
      : `<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.name)}</a>`)
    .join('<span class="crumbs"> / </span>')
}

/**
 * Format a modification time for a listing row.
 * @param mtimeMs - the epoch milliseconds from the stat result.
 * @returns a short local timestamp.
 */
function formatTime(mtimeMs: number): string {
  const at = new Date(mtimeMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * Turn a directory read into sorted listing rows.
 *
 * Directories sort ahead of files and both sort by name, which is the order a
 * reader scans for. Entries whose stat fails are dropped rather than shown as
 * broken: a dangling symlink or a file removed between the read and the stat
 * is not something this page can say anything useful about.
 * @param directory - the directory being listed.
 * @param entries - its `readdir` result.
 * @param statOf - stat function, injected so tests need no filesystem.
 * @returns the rows to render.
 */
export async function collectEntries(
  directory: string,
  entries: readonly Dirent[],
  statOf: (path: string) => Promise<Stats>,
): Promise<Entry[]> {
  const rows: Entry[] = []
  for (const entry of entries) {
    // Partial uploads are a transient state of a file that is not there yet;
    // listing them would invite a reader to open half a file.
    if (entry.name.endsWith('.part')) continue
    try {
      const stats = await statOf(join(directory, entry.name))
      rows.push({
        name: entry.name,
        directory: stats.isDirectory(),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      })
    } catch {
      continue
    }
  }
  return rows.sort((left, right) => left.directory === right.directory
    ? left.name.localeCompare(right.name)
    : left.directory ? -1 : 1)
}

/**
 * The page listing the roots this viewer exposes.
 * @param route - the viewer's route prefix.
 * @param roots - canonical root directories.
 * @returns a complete HTML document.
 */
export function rootIndexPage(route: string, roots: readonly string[]): string {
  const body = roots.length === 0
    ? '<p class="empty">No workspaces are registered and no roots are configured, so there is nothing to browse.</p>'
    : `<ul class="listing">${roots.map((root) => {
      const href = `${route}${toRequestPath(root)}`
      const name = root.split(sep).filter(part => part !== '').pop() ?? root
      return `<li><a href="${escapeHtml(href)}"><span class="name">${escapeHtml(name)}</span>`
        + `<span class="meta">${escapeHtml(root)}</span></a></li>`
    }).join('')}</ul>`
  return page('Files', `<h1>Files</h1>${body}`)
}

/**
 * A directory listing.
 * @param route - the viewer's route prefix.
 * @param directory - the canonical directory path.
 * @param crumbs - the trail from its root.
 * @param entries - the rows to show.
 * @returns a complete HTML document.
 */
export function listingPage(
  route: string,
  directory: string,
  crumbs: readonly Crumb[],
  entries: readonly Entry[],
): string {
  const rows = entries.map((entry) => {
    const href = `${route}${toRequestPath(join(directory, entry.name))}`
    const name = entry.directory ? `${entry.name}/` : entry.name
    const meta = entry.directory ? formatTime(entry.mtimeMs) : `${formatBytes(entry.size)} · ${formatTime(entry.mtimeMs)}`
    return `<li><a href="${escapeHtml(href)}"><span class="name">${escapeHtml(name)}</span>`
      + `<span class="meta">${escapeHtml(meta)}</span></a></li>`
  })
  const body = rows.length === 0
    ? '<p class="empty">This directory is empty.</p>'
    : `<ul class="listing">${rows.join('')}</ul>`
  return page(basename(directory) || directory, `<h1>${renderCrumbs(crumbs)}</h1>${body}`)
}

/** The links offered under a file view. */
export interface FileActions {
  /** URL serving the file's bytes as-is. */
  readonly raw: string
  /** URL serving the file as a download. */
  readonly download: string
}

/**
 * Wrap rendered content in the file page shell.
 * @param path - the canonical file path.
 * @param crumbs - the trail from its root.
 * @param content - the rendered body, already escaped by its producer.
 * @param actions - the raw and download URLs.
 * @param note - an optional line above the actions.
 * @returns a complete HTML document.
 */
export function filePage(
  path: string,
  crumbs: readonly Crumb[],
  content: string,
  actions: FileActions,
  note?: string,
): string {
  const footer = `<p class="note">${note === undefined ? '' : `${escapeHtml(note)}<br>`}`
    + `<a href="${escapeHtml(actions.raw)}">raw</a> · `
    + `<a href="${escapeHtml(actions.download)}">download</a></p>`
  return page(basename(path), `<h1>${renderCrumbs(crumbs)}</h1>${content}${footer}`)
}

/**
 * The body for a file the browser renders itself.
 * @param type - the file's content type.
 * @param raw - URL serving its bytes.
 * @param name - the filename, used as the image alt text.
 * @returns HTML for the embed.
 */
export function embedBody(type: string, raw: string, name: string): string {
  const source = escapeHtml(raw)
  if (type.startsWith('image/')) return `<p><img src="${source}" alt="${escapeHtml(name)}"></p>`
  if (type.startsWith('video/')) return `<p><video src="${source}" controls></video></p>`
  if (type.startsWith('audio/')) return `<p><audio src="${source}" controls></audio></p>`
  return `<iframe class="embed" src="${source}" title="${escapeHtml(name)}"></iframe>`
}

/**
 * The body for a file shown as source text.
 * @param text - the file's decoded contents.
 * @returns HTML for the text block.
 */
export function textBody(text: string): string {
  return `<pre><code>${escapeHtml(text)}</code></pre>`
}

/**
 * The body for a file this viewer will not display.
 * @param stats - the file's stat result.
 * @param type - its content type.
 * @returns HTML explaining what the file is.
 */
export function opaqueBody(stats: Stats, type: string): string {
  return `<p class="empty">${escapeHtml(formatBytes(stats.size))} · ${escapeHtml(type)}<br>`
    + 'This file is not shown inline.</p>'
}
