#!/usr/bin/env node
/**
 * Write the peer range for one DeepSeek Harness line into package manifests.
 *
 *   node scripts/harness-range.mjs <minor-line> <floor> <manifest...>
 *   node scripts/harness-range.mjs 0.2 0.2.0-rc.2 packages/compaction-window/package.json
 *
 * Every `@deepseek-ai/dsh-*` peer in the given manifests gets the range for that
 * line; nothing else is touched.
 *
 * Why the range is spelled out tuple by tuple: the harness ships almost only
 * prereleases, and a semver prerelease satisfies a range only when one of its
 * comparators carries a prerelease on the same major.minor.patch. So
 * `>=0.2.0-rc.2` matches 0.2.0-rc.3 but not 0.2.1-alpha.1, and neither does
 * `^0.2.0-rc.2`. A package manager that auto-installs peers then picks the
 * newest version the range admits — 0.2.0-rc.2, a release behind a host on
 * 0.2.1-alpha.1. Listing each patch tuple of the line lets it pick the newest
 * 0.2 version instead, and the closing `<0.3.0-0` keeps it from reaching for a
 * 0.3 that the plugin was never written against.
 *
 * Inside a dsh profile none of this decides what loads: dsh installs plugins
 * with autoInstallPeers off and resolves harness packages from the host. There
 * the range only decides whether installing prints a peer warning.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const TUPLES = 16

const [line, floor, ...manifests] = process.argv.slice(2)
if (!/^\d+\.\d+$/.test(line ?? '') || floor === undefined || manifests.length === 0) {
  console.error('usage: harness-range.mjs <minor-line, e.g. 0.2> <floor, e.g. 0.2.0-rc.2> <package.json...>')
  process.exit(1)
}
const [major, minor] = line.split('.').map(Number)
const floorPatch = Number(floor.split('-')[0].split('.')[2])
const next = `${major}.${minor + 1}.0-0`

const parts = [`>=${floor} <${major}.${minor}.${floorPatch + 1}-0`]
for (let patch = floorPatch + 1; patch < floorPatch + TUPLES; patch += 1) {
  parts.push(`>=${major}.${minor}.${patch}-0 <${major}.${minor}.${patch + 1}-0`)
}
// Releases past the last listed tuple, up to the next line.
parts.push(`>=${major}.${minor}.${floorPatch + TUPLES} <${next}`)
const range = parts.join(' || ')

for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  let changed = 0
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    manifest.peerDependencies[name] = range
    changed += 1
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${path}: ${changed} harness peers → ${line} line`)
}
