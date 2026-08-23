/**
 * Getting a gate in front of `/api`.
 *
 * ## Why this is a patch
 *
 * The harness has no authorization seam, and the three places that look like
 * one are all taken or closed:
 *
 * - `connection.rpc.intercept('/api', …)` is the designed extension point,
 *   but a channel accepts exactly one interceptor and `typertGateway` claims
 *   it in its own constructor. A second registration throws.
 * - `webServer.register` refuses a duplicate `(kind, path)`, so the `/api`
 *   prefix cannot be claimed a second time and shadowed.
 * - Route matching is longest-prefix-wins, so there is no more specific
 *   prefix that covers every endpoint.
 *
 * What is left is wrapping the handler that is already installed. Both
 * directions have to be covered, and the *already registered* one is the
 * normal case rather than the edge case: bundle rows load before the rows a
 * profile patch inserts, so the `/api` owner has almost always registered
 * before this plugin activates.
 *
 * ## Why it is safe to fail
 *
 * Reaching into the service's route tables is white-box, and a harness
 * release could move them. That is survivable only because every assumption
 * is checked and a failed check **throws at activation**: the deployment does
 * not start, with a message saying why. The failure mode this package refuses
 * to have is the quiet one, where the lock is installed, reports success, and
 * gates nothing.
 * @module @tivility/dsh-readonly-auth/gate
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { symbols } from '@deepseek-ai/cordis'

/** One route registration, as the webserver models it. */
interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One upgrade registration, as the webserver models it. */
interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** The service surface this module patches. */
interface WebServerLike {
  register(route: Route): () => void
  registerUpgrade(route: UpgradeRoute): () => void
}

/** Marks a handler this module has already wrapped, so a second install does not nest. */
const WRAPPED = Symbol.for('@tivility/dsh-readonly-auth/wrapped')

/** How one gate decides and refuses. */
export interface GateHooks {
  /** Whether this request's path is one the gate covers. */
  covers(path: string): boolean
  /**
   * Answer the request instead of the wrapped handler.
   * @returns true when the gate answered and the handler must not run.
   */
  intercept(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>
  /**
   * Whether one upgrade may proceed; absent leaves upgrades untouched.
   * @returns true to let the socket through.
   */
  allowUpgrade?(req: IncomingMessage): boolean
}

/**
 * Recover the service instance behind Cordis's tracker proxy.
 *
 * Own properties must be defined on the real object: defining them on the
 * proxy would either be trapped or shadow only that proxy, leaving the
 * request path reading the untouched prototype method.
 * @param service - the service as read from a context.
 * @returns the underlying instance.
 */
function unwrap<T extends object>(service: T): T {
  const original = Reflect.get(service, symbols.original) as unknown
  return typeof original === 'object' && original !== null ? original as T : service
}

/**
 * Read one of the webserver's private route tables.
 * @param server - the unwrapped service instance.
 * @param field - the table's property name.
 * @returns the table.
 * @throws {Error} when the field is missing or not a Map.
 */
function routeTable(server: object, field: string): Map<string, Route> {
  const table = Reflect.get(server, field) as unknown
  if (!(table instanceof Map)) {
    throw new Error(
      `readonly-auth: cannot install the /api gate — webServer has no "${field}" route table. `
      + 'The harness\'s webserver internals have changed; this plugin must be updated before it can '
      + 'be trusted to gate anything.',
    )
  }
  return table as Map<string, Route>
}

/**
 * Wrap one handler so the gate runs first.
 * @param handler - the handler to protect.
 * @param hooks - the gate's decision and refusal.
 * @returns the wrapped handler, marked so it is not wrapped twice.
 */
function guard(handler: Route['handler'], hooks: GateHooks): Route['handler'] {
  if (Reflect.get(handler, WRAPPED) === true) return handler
  const wrapped: Route['handler'] = async (req, res) => {
    if (await hooks.intercept(req, res)) return
    await handler(req, res)
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true })
  return wrapped
}

/**
 * Put a gate in front of every route covering the guarded paths, whether it
 * was registered before this call or after it.
 * @param service - the `webServer` service, proxy or not.
 * @param hooks - the gate's decision, refusal, and optional upgrade rule.
 * @returns a disposer restoring the service.
 * @throws {Error} when the service does not have the shape this patch needs.
 */
export function installGate(service: WebServerLike, hooks: GateHooks): () => void {
  const server = unwrap(service)
  const tables = [routeTable(server, 'exact'), routeTable(server, 'prefixes')]
  const restore: (() => void)[] = []

  // Already registered: replace the table entry with a guarded copy. The
  // owner's own disposer deletes by path and is unaffected by the swap.
  for (const table of tables) {
    for (const [path, route] of [...table]) {
      if (!hooks.covers(path)) continue
      const guarded: Route = { ...route, handler: guard(route.handler, hooks) }
      table.set(path, guarded)
      restore.push(() => {
        if (table.get(path) === guarded) table.set(path, route)
      })
    }
  }

  // Registered later: guard on the way in. The own property shadows the
  // prototype method for this instance only.
  restore.push(patchMethod(server, 'register', original => (...args) => {
    const route = args[0] as Route
    return original(hooks.covers(route.path) ? { ...route, handler: guard(route.handler, hooks) } : route)
  }))

  const allowUpgrade = hooks.allowUpgrade
  if (allowUpgrade !== undefined) {
    const guardUpgrade = (route: UpgradeRoute): UpgradeRoute => {
      if (!hooks.covers(route.path)) return route
      return {
        ...route,
        handler: (req, socket, head) => {
          if (!allowUpgrade(req)) {
            // No status line is available once a socket is being upgraded and
            // the refusal is not negotiable, so the socket is simply dropped —
            // the same thing the harness does for an untrusted upgrade.
            socket.destroy()
            return
          }
          return route.handler(req, socket, head)
        },
      }
    }
    restore.push(patchMethod(server, 'registerUpgrade', original => (...args) =>
      original(guardUpgrade(args[0] as UpgradeRoute))))
    // Upgrades already registered live in a third table; missing it would
    // leave the live event stream open, so its absence is fatal too.
    const upgrades = Reflect.get(server, 'upgrades') as unknown
    if (!(upgrades instanceof Map)) {
      for (const undo of restore.reverse()) undo()
      throw new Error(
        'readonly-auth: cannot gate upgrades — webServer has no "upgrades" route table. '
        + 'Set allowGuests to true, or update this plugin for the harness release in use.',
      )
    }
    for (const [path, route] of [...upgrades as Map<string, UpgradeRoute>]) {
      if (!hooks.covers(path)) continue
      const guarded = guardUpgrade(route)
      ;(upgrades as Map<string, UpgradeRoute>).set(path, guarded)
      restore.push(() => {
        if ((upgrades as Map<string, UpgradeRoute>).get(path) === guarded) {
          (upgrades as Map<string, UpgradeRoute>).set(path, route)
        }
      })
    }
  }

  return () => {
    for (const undo of restore.reverse()) undo()
  }
}

/** An instance method, seen through the patch layer. */
type Method = (...args: unknown[]) => unknown

/**
 * Shadow one instance method with a wrapper, reversibly.
 *
 * The current implementation is handed to `wrap` already bound to `target`:
 * the webserver's own methods read `this.exact` and `this.prefixes`, and this
 * patch always applies to one specific instance, so binding is both correct
 * and one less thing for a call site to get wrong.
 * @param target - the object to patch.
 * @param key - the method name.
 * @param wrap - builds the replacement from the bound implementation.
 * @returns a disposer restoring the previous state exactly.
 * @throws {Error} when the named property is not a function.
 */
function patchMethod(target: object, key: string, wrap: (original: Method) => Method): () => void {
  const current = Reflect.get(target, key) as unknown
  if (typeof current !== 'function') {
    throw new Error(`readonly-auth: webServer has no ${key}() to gate; this plugin must be updated.`)
  }
  const own = Object.getOwnPropertyDescriptor(target, key)
  const replacement = wrap((current as Method).bind(target))
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement })
  return () => {
    // Only undo our own patch: another wrapper installed on top of ours would
    // be silently disabled if we clobbered it.
    if (Reflect.get(target, key) !== replacement) return
    if (own === undefined) {
      Reflect.deleteProperty(target, key)
      return
    }
    Object.defineProperty(target, key, own)
  }
}
