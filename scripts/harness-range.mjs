#!/usr/bin/env node
/**
 * Write the peer range for a span of DeepSeek Harness versions into package manifests.
 *
 *   node scripts/harness-range.mjs <through> <floor> <manifest...>
 *   node scripts/harness-range.mjs 0.2 0.2.0-rc.2 packages/compaction-window/package.json
 *   node scripts/harness-range.mjs 0.2.2 0.2.1-rc.5 packages/tool-subagent-memory/package.json
 *
 * Every `@deepseek-ai/dsh-*` peer in the given manifests gets a range that starts
 * at the floor; nothing else is touched. `<through>` is where it ends: a minor
 * line (`0.2`) admits every later version of that minor and stops below the next
 * minor; a patch line (`0.2.2`) admits every version through that patch's
 * prereleases and release and stops below the next patch's first prerelease.
 *
 * Why the range is spelled out tuple by tuple: the harness ships almost only
 * prereleases, and a semver prerelease satisfies a range only when one of its
 * comparators carries a prerelease on the same major.minor.patch. So
 * `>=0.2.0-rc.2` matches 0.2.0-rc.3 but not 0.2.1-alpha.1, and neither does
 * `^0.2.0-rc.2`. A package manager that auto-installs peers then picks the
 * newest version the range admits — 0.2.0-rc.2, a release behind a host on
 * 0.2.1-alpha.1. Listing each patch tuple lets it pick the newest admitted
 * version instead, and the closing bound keeps it from reaching for a version
 * the plugin was never written against.
 *
 * Inside a dsh profile the range decides what loads. dsh installs plugins with
 * autoInstallPeers off and resolves harness packages from the host, then checks
 * every `@deepseek-ai/dsh-*` peer range against the running dsh version, with
 * prereleases included; an unmet range blocks installation and activation
 * unless the user grants an exact plugin/runtime exemption. End the range at the
 * last line the plugin was tested against: the harness removes and renames APIs
 * between prereleases of one minor line, so a wider range turns that removal
 * into a load or runtime failure instead of a refusal at install time.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const TUPLES = 16

const [through, floor, ...manifests] = process.argv.slice(2)
const throughParts = /^\d+\.\d+(\.\d+)?$/.test(through ?? '') ? through.split('.').map(Number) : undefined
const floorParts = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(floor ?? '')
  ? floor.split('-')[0].split('.').map(Number)
  : undefined
if (throughParts === undefined || floorParts === undefined || manifests.length === 0) {
  console.error('usage: harness-range.mjs <through, e.g. 0.2 or 0.2.2> <floor, e.g. 0.2.1-rc.5> <package.json...>')
  process.exit(1)
}
const [major, minor, lastPatch] = throughParts
const floorPatch = floorParts[2]
if (floorParts[0] !== major || floorParts[1] !== minor || (lastPatch !== undefined && floorPatch > lastPatch)) {
  console.error(`harness-range.mjs: floor ${floor} is not at or below ${through} on the ${major}.${minor} line`)
  process.exit(1)
}

const parts = [`>=${floor} <${major}.${minor}.${floorPatch + 1}-0`]
if (lastPatch === undefined) {
  for (let patch = floorPatch + 1; patch < floorPatch + TUPLES; patch += 1) {
    parts.push(`>=${major}.${minor}.${patch}-0 <${major}.${minor}.${patch + 1}-0`)
  }
  // Releases past the last listed tuple, up to the next minor.
  parts.push(`>=${major}.${minor}.${floorPatch + TUPLES} <${major}.${minor + 1}.0-0`)
} else {
  for (let patch = floorPatch + 1; patch <= lastPatch; patch += 1) {
    parts.push(`>=${major}.${minor}.${patch}-0 <${major}.${minor}.${patch + 1}-0`)
  }
}
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
  console.log(`${path}: ${changed} harness peers → ${range}`)
}
