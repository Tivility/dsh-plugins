/**
 * The mapping between a filesystem path and its position in the viewer's URL
 * space.
 *
 * The route carries the absolute path verbatim: `/files` plus
 * `/Users/me/project/README.md` addresses exactly that file. There is no id
 * table and no per-request token, because the containment check is what
 * decides whether a path may be read — an opaque handle would only move the
 * same decision somewhere less visible.
 * @module @tivility/dsh-file-viewer/paths
 */

import { isAbsolute, sep } from 'node:path'

/** Drive-letter prefix a Windows absolute path starts with. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/

/**
 * Percent-encode an absolute filesystem path for use after the route prefix.
 *
 * Each segment is encoded on its own so that separators survive and
 * everything else — spaces, `#`, `?`, non-ASCII — is escaped.
 * @param absolute - an absolute filesystem path.
 * @returns the path portion of a viewer URL, leading slash included.
 */
export function toRequestPath(absolute: string): string {
  const normalized = absolute.split(sep).join('/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return withLeadingSlash.split('/').map(encodeURIComponent).join('/')
}

/**
 * Recover the filesystem path a request addresses.
 *
 * On Windows the URL carries the drive-lettered path behind the leading
 * slash the URL grammar requires (`/C:/Users/...`), so that slash is removed
 * before the result can be an absolute path again.
 * @param pathname - the decoded pathname after the route prefix.
 * @returns the absolute filesystem path, or undefined when the input cannot name one.
 */
export function fromRequestPath(pathname: string): string | undefined {
  if (pathname === '' || pathname === '/') return undefined
  // A NUL would truncate the path inside the syscall layer, so a request
  // carrying one is refused before it reaches any filesystem call.
  if (pathname.includes('\u0000')) return undefined
  const candidate = WINDOWS_DRIVE.test(pathname.slice(1)) ? pathname.slice(1) : pathname
  return isAbsolute(candidate) ? candidate : undefined
}

/** One step of a path, with the URL that addresses it. */
export interface Crumb {
  /** The segment's display name. */
  readonly name: string
  /** Viewer URL for this step, or undefined for the step the reader is on. */
  readonly href?: string
}

/**
 * Build the breadcrumb trail from a root down to a path.
 *
 * The trail starts at the root rather than at the filesystem root: everything
 * above is unreachable, and offering a link to it would only produce a 403.
 * @param route - the viewer's route prefix.
 * @param path - the canonical path being shown.
 * @param root - the canonical root containing it.
 * @returns the trail, ending with the path itself.
 */
export function crumbsFor(route: string, path: string, root: string): Crumb[] {
  const rootName = root.split(sep).filter(part => part !== '').pop() ?? root
  const crumbs: Crumb[] = [{ name: rootName, href: `${route}${toRequestPath(root)}` }]
  if (path === root) {
    const last = crumbs[crumbs.length - 1]
    if (last !== undefined) crumbs[crumbs.length - 1] = { name: last.name }
    return crumbs
  }
  const rest = path.slice(root.length).split(sep).filter(part => part !== '')
  let walked = root
  for (const [index, part] of rest.entries()) {
    walked = walked.endsWith(sep) ? `${walked}${part}` : `${walked}${sep}${part}`
    crumbs.push(index === rest.length - 1
      ? { name: part }
      : { name: part, href: `${route}${toRequestPath(walked)}` })
  }
  return crumbs
}
