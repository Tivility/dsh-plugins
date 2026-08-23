/**
 * The browsable/writable root set shared by the file plugins: the harness's
 * registered workspaces plus whatever extra directories a deployment adds by
 * configuration.
 *
 * Workspaces are read fresh on every request rather than cached, because the
 * registry is live — a workspace added or removed while the server runs must
 * take effect without a restart. Their paths need no canonicalization: the
 * registry stores the `fs.realpath` of the directory it was created from and
 * never rewrites it. Configured roots are the opposite — fixed for the
 * process, but written by a human in any spelling — so they are canonicalized
 * once at plugin activation.
 * @module @tivility/dsh-web-kit/roots
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalize } from './containment.js'

/**
 * The single field this package reads from a workspace record. Declared
 * structurally rather than imported: `workspaceRegistry` is an optional
 * service, and a type-only import would turn `@deepseek-ai/dsh-workspace`
 * into a peer every consumer must install to satisfy a dependency none of
 * them actually has at runtime.
 */
interface WorkspaceLike {
  /** Canonical directory path, as stored by the registry. */
  readonly path: string
}

/** The one method this package calls on the optional workspace registry. */
interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
}

/**
 * Canonicalize configured roots once, dropping the ones that do not exist.
 *
 * A configured root that is absent at activation is dropped rather than
 * fatal: a deployment may list a removable volume, and refusing to start over
 * an unplugged disk trades a missing directory for a dead server. It is
 * dropped rather than retried because a root appearing later would silently
 * widen the exposed surface without anyone re-reading the configuration.
 * @param roots - configured directories in any spelling.
 * @returns the canonical paths of those that exist, in configuration order.
 */
export async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = []
  for (const root of roots) {
    const path = await canonicalize(root)
    // canonicalize() tolerates absent components; existence is what decides.
    try {
      if ((await stat(path)).isDirectory()) resolved.push(path)
    } catch {
      continue
    }
  }
  return resolved
}

/**
 * The harness workspaces currently registered, or none when the registry is
 * absent from this composition.
 * @param ctx - a context that can see the optional `workspaceRegistry` service.
 * @returns canonical workspace directories in registry order.
 */
export function workspaceRoots(ctx: Context): string[] {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry === undefined) return []
  return registry.list().map(workspace => workspace.path)
}

/**
 * The full root set for one request: configured roots first, then the live
 * workspaces.
 * @param ctx - a context that can see the optional `workspaceRegistry` service.
 * @param staticRoots - already-canonical configured roots (see {@link canonicalizeRoots}).
 * @returns every directory a request may reach, deduplicated.
 */
export function collectRoots(ctx: Context, staticRoots: readonly string[] = []): string[] {
  return [...new Set([...staticRoots, ...workspaceRoots(ctx)])]
}
