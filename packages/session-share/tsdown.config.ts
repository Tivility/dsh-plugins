/**
 * The browser bundle for this package's client half.
 *
 * The harness ships a preset for exactly this (`packages/client/tsdown.client.ts`),
 * but it is repository-bound: it locates a package by globbing
 * `packages/*&#47;*&#47;package.json` inside the harness checkout and throws when the
 * name is not there. So the contract is restated here — it is short, and it
 * is the whole of what makes a bundle loadable.
 *
 * Four things have to be true, and all four come from the harness's own
 * client-module loader:
 *
 * 1. **CJS on a browser platform, emitted as `lib/client.js`** — the path
 *    `exports["./client"]` names and `/plugins/<id>/client.js` serves.
 * 2. **The `__ModuleLoader__.load` handoff**, spelled by the banner/footer/
 *    intro below. The bundle is fetched outside any module graph and hands
 *    the loader a factory rather than exporting anything.
 * 3. **Externals resolve through the injected `require`**, which answers only
 *    the loader's module table: the platform baseline plus whatever this
 *    package declares in `dsh.client.external`. A `require()` the table cannot
 *    answer throws at boot, so everything else must inline.
 * 4. **Source maps**, since plugin code is outside the shell's graph and a
 *    browser stack frame has no other way back to the source.
 */

import { defineConfig } from 'tsdown'

/** Package name, stamped into the loader handoff and matched by the boot graph row. */
const ID = '@tivility/dsh-session-share'

/**
 * The module table the injected `require` can answer.
 *
 * Mirrored from the harness's `PLATFORM_MODULES` and
 * `PRELOADED_CLIENT_EXTERNALS`. Only the runtime is actually imported here —
 * this plugin renders nothing — but the list is stated whole so adding a React
 * import later does not silently inline a second copy of React.
 */
const EXTERNALS: ReadonlySet<string> = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

export default defineConfig({
  name: `${ID}/client`,
  // Consumes the JavaScript tsc already emitted, so the bundle carries the
  // same code the type checker approved.
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  // The node half's own output lives in this directory; a clean would wipe it.
  clean: false,
  // `external`, not tsdown's `deps` heuristics: those classify by npm section,
  // and everything the loader answers is a devDependency here (the runtime
  // provides it, so declaring it a dependency would install a second copy).
  // Left to `deps`, the whole primitives package — markdown, katex, fonts —
  // gets inlined into a plugin bundle that must not contain it.
  external: (id: string) => EXTERNALS.has(id),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
