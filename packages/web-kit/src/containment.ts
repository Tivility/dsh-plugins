/**
 * Path canonicalization and containment for plugin routes that resolve a
 * URL-supplied path against a set of allowed roots.
 *
 * Lexical `startsWith` over `path.resolve` output is not containment: it
 * misses symlink escapes, and on a case-insensitive filesystem (the macOS
 * default) it rejects spellings that name the very same directory. The
 * containment rule here is a port of the harness's own sandbox check
 * (`@deepseek-ai/dsh-fs-sandbox`'s `isPathUnder`, which the package does not
 * export), keeping the lexical fast path and the filesystem-identity fallback
 * that recognizes case and long-name aliases.
 * @module @tivility/dsh-web-kit/containment
 */

import type { BigIntStats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Errno codes meaning "this path component is simply not there". */
const MISSING_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Whether an error means the path is absent rather than unreadable.
 * @param error - the rejection from a filesystem call.
 * @returns true for absent-path errno codes.
 */
function isMissing(error: unknown): boolean {
  return MISSING_CODES.has((error as NodeJS.ErrnoException).code)
}

/**
 * Compare-ready spelling of a path under the host's case convention.
 * @param path - the path to fold.
 * @param caseSensitive - whether case is significant on this filesystem.
 * @returns the path as it should be compared.
 */
function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase()
}

/**
 * Purely textual containment, the fast path for canonical spellings.
 *
 * Exported for callers that must answer synchronously and can accept a
 * conservative answer — prompt assembly, where the result decides what an
 * example URL looks like rather than what may be read. It resolves no
 * symlinks, so a link into the roots spelled from outside them reads as
 * outside. Never use it to authorize a read: {@link isPathUnder} is the check
 * that follows symlinks, and it is the one a request must pass.
 * @param path - candidate path.
 * @param root - the root it may live under.
 * @param caseSensitive - whether case is significant on this filesystem; defaults to the host convention.
 * @returns whether the path is the root or textually beneath it.
 */
export function isLexicallyUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): boolean {
  const target = comparablePath(path, caseSensitive)
  const base = comparablePath(root, caseSensitive)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return target.startsWith(prefix)
}

/**
 * Stat one path, treating absence as a value rather than a failure.
 * @param path - the path to stat.
 * @returns the stats, or undefined when the path is absent.
 */
async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Whether two stat results name the same filesystem object.
 * @param left - one stat result.
 * @param right - the other.
 * @returns true when device and inode both match.
 */
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Determine whether a canonical target is a root or lies beneath it.
 *
 * The lexical fast path handles normal canonical spellings. When spellings
 * differ, walk the target's existing ancestors and compare filesystem
 * identity with the root; this recognizes case and long-name aliases without
 * weakening containment to a textual approximation.
 * @param path - canonical target, which may end in a not-yet-existing suffix.
 * @param root - canonical root directory.
 * @param caseSensitive - whether lexical comparison preserves case; defaults to the host filesystem convention.
 * @returns whether the target is the root or a descendant of it.
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true

  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false

  let ancestor = path
  for (;;) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo !== undefined && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

/**
 * Canonicalize a path that need not exist yet.
 *
 * Every existing component is resolved by `fs.realpath`, so a symlink
 * anywhere along the way — including one whose target sits outside the roots —
 * is followed before containment is judged. Only components that genuinely do
 * not exist are appended textually, where no symlink can hide. `..` is never
 * collapsed lexically: it is handed to `realpath` together with the ancestors
 * around it, which resolves links first and only then walks up.
 * @param target - the path to canonicalize, absolute or relative to `cwd`.
 * @returns the canonical absolute path.
 * @throws {Error} for a filesystem failure other than an absent component.
 */
export async function canonicalize(target: string): Promise<string> {
  const absolute = isAbsolute(target) ? target : resolve(target)
  try {
    return await realpath(absolute)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
  const parent = dirname(absolute)
  // Root reached without ever resolving: nothing above exists, so the path is
  // already as canonical as the filesystem can make it.
  if (parent === absolute) return absolute
  return join(await canonicalize(parent), basename(absolute))
}

/**
 * Canonicalize one request-supplied path and place it inside an allowed root.
 * @param target - the path to resolve, absolute or relative to `cwd`.
 * @param roots - canonical root directories; an empty list contains nothing.
 * @returns the canonical path and its owning root, or undefined when no root contains it.
 */
export async function resolveUnderRoots(
  target: string,
  roots: readonly string[],
): Promise<{ readonly path: string, readonly root: string } | undefined> {
  const path = await canonicalize(target)
  for (const root of roots) {
    if (await isPathUnder(path, root)) return { path, root }
  }
  return undefined
}
