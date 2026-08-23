import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Trailing sourcemap reference the harness's published bundles carry. */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=\S+\s*$/

export default defineConfig({
  plugins: [{
    // The published UI primitives point at `.map` files their tarball does not
    // ship, and Vite reads that comment eagerly while inlining the package —
    // printing a stack trace on every run for a map nobody needs here.
    // Dropping the reference is cheaper than teaching Vite to ignore it.
    name: 'drop-dangling-sourcemap-refs',
    enforce: 'pre',
    // `load`, not `transform`: Vite reads the file and follows its
    // sourceMappingURL before any transform hook runs, so a transform is too
    // late to stop the lookup. Returning the contents here means Vite never
    // reads the file itself.
    load(id: string) {
      const file = id.split('?')[0] ?? id
      if (!file.includes('@deepseek-ai/dsh-client-ui-primitives') || !file.endsWith('.js')) return null
      const code = readFileSync(file, 'utf8')
      if (!SOURCEMAP_COMMENT.test(code)) return null
      return { code: code.replace(SOURCEMAP_COMMENT, ''), map: null }
    },
  }],
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    environment: 'node',
    server: {
      deps: {
        // Loaded from node_modules this package reaches Node's ESM loader
        // directly, which has no idea what a `.css` file is. Inlining routes
        // it through Vite, whose default `css: false` resolves a stylesheet to
        // an empty module — exactly right for a suite that never renders.
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
