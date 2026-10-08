#!/usr/bin/env node
/**
 * Derive an agent preset from one the host already ships, with rows swapped for
 * this repository's drop-in replacements.
 *
 *   dsh --profile web --dump-config \
 *     | node scripts/derive-preset.mjs --dsh <dsh install dir> [options] \
 *     > preset.patch.yml
 *
 * Options:
 *   --dsh <dir>      a directory that resolves `js-yaml` — any dsh install or checkout does
 *   --base <id>      the shipped preset to start from (default: standard)
 *   --id <id>        the new preset's id (default: memory)
 *   --name <name>    its display name (default: the id)
 *   --with <list>    comma-separated packages to swap in (default: all three)
 *                    compaction-window, tool-subagent-memory, tool-workflow-memory
 *
 * Why a script and not a README snippet: on DeepSeek Harness 0.2 the rows these
 * packages replace live inside each agent preset, and a profile patch can reach
 * neither inside a preset nor change an existing row's `name`. Installing one
 * therefore means declaring a preset whose plugin list is a shipped one with
 * those rows renamed. Copying that list into documentation would freeze it at
 * one harness release; deriving it from `--dump-config` takes the list the host
 * is actually running, every time.
 *
 * The output is a patch list with one `insert`. Write it to a separate file
 * first, then add its row to the profile's `cordis.patch.yml` — if that file
 * holds only `[]`, replace it. Redirecting straight into `cordis.patch.yml` in
 * the same pipeline empties the file before dsh reads it.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const SWAPS = {
  'compaction-window': { id: 'compaction-basic', name: '@tivility/dsh-compaction-window' },
  'tool-subagent-memory': { id: 'tool-subagent', name: '@tivility/dsh-tool-subagent-memory' },
  'tool-workflow-memory': [
    { id: 'workflow-ptc', name: '@tivility/dsh-tool-workflow-memory/engine' },
    { id: 'tool-workflow', name: '@tivility/dsh-tool-workflow-memory' },
  ],
}

const args = process.argv.slice(2)
const option = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : args[index + 1]
}
const dshDir = option('--dsh')
if (dshDir === undefined) {
  console.error('derive-preset: --dsh <dsh install dir> is required (it supplies js-yaml)')
  process.exit(1)
}
const base = option('--base', 'standard')
const id = option('--id', 'memory')
const name = option('--name', id)
const wanted = option('--with', Object.keys(SWAPS).join(',')).split(',').map(s => s.trim()).filter(Boolean)
for (const key of wanted) {
  if (!(key in SWAPS)) {
    console.error(`derive-preset: unknown package "${key}" (known: ${Object.keys(SWAPS).join(', ')})`)
    process.exit(1)
  }
}
const swaps = new Map(wanted.flatMap(key => [SWAPS[key]].flat()).map(swap => [swap.id, swap.name]))

const require = createRequire(join(dshDir, 'package.json'))
const yaml = require(require.resolve('js-yaml', { paths: [dshDir, join(dshDir, 'packages/boot/app-boot')] }))

// Compositions carry `!!js` expressions; keep them opaque and write them back verbatim.
class JsExpr { constructor(source) { this.source = source } }
const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: source => new JsExpr(source),
  instanceOf: JsExpr,
  represent: expr => expr.source,
})])

const input = readFileSync(0, 'utf8')
if (input.trim() === '') {
  console.error('derive-preset: no composition on stdin — did `dsh --dump-config` fail? '
    + '(Do not redirect into the profile\'s cordis.patch.yml in the same pipeline: the shell empties it before dsh reads it.)')
  process.exit(1)
}
const rows = yaml.load(input, { schema })
const preset = rows.find(row => row?.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === base)
if (preset === undefined) {
  console.error(`derive-preset: no preset "${base}" in the dumped composition`)
  process.exit(1)
}

const swapped = new Set()
const swapRows = list => list.map((row) => {
  if (row.group === true && Array.isArray(row.config)) return { ...row, config: swapRows(row.config) }
  const replacement = swaps.get(row.id)
  if (replacement === undefined) return row
  swapped.add(row.id)
  return { ...row, name: replacement }
})
const plugins = swapRows(preset.config.plugins)

const missing = [...swaps.keys()].filter(key => !swapped.has(key))
if (missing.length > 0) {
  // A harness release that moved or renamed a row would otherwise produce a
  // preset that silently still runs upstream's code.
  console.error(`derive-preset: preset "${base}" has no row ${missing.map(m => `"${m}"`).join(', ')} — nothing was swapped for it`)
  process.exit(1)
}

const row = {
  id: `preset-${id}`,
  name: preset.name,
  config: { ...preset.config, id, name, order: (preset.config.order ?? 0) + 100, plugins },
}
process.stdout.write(yaml.dump([{ insert: [row] }], { lineWidth: -1, schema }))
console.error(`derive-preset: "${id}" from "${base}", swapped ${[...swapped].join(', ')}`)
