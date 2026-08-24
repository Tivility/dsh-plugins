/**
 * Put this package's bundled preset where the harness will find it.
 *
 * The harness discovers presets by path — the roots its launcher composes,
 * plus `$DSH_HOME/.agent-presets` — and a package directory is neither. Two
 * shortcuts look like they should bridge that and do not: a configured root
 * pointing into `node_modules` is discarded, because the `dsh` launcher spreads
 * the user's `agent-presets` config and then assigns `roots` itself in an
 * overlay applied after every user layer; and a symlink into the user root is
 * skipped, because `scanRoot` passes over anything that is not `isDirectory()`.
 *
 * Both failures are silent — an absent preset looks the same however it went
 * missing — so what is left is putting real files in the real directory. Doing
 * it here rather than in a README is the difference between a preset that
 * follows `pnpm update` and one that follows whether somebody remembered.
 *
 * The directory belongs to the user, not to this package, so the install is
 * bounded by what it can prove: it writes a marker recording exactly what it
 * wrote, and only ever replaces a copy still byte-identical to that record.
 * Anything else — an edited preset, one copied by hand before this existed — is
 * left alone and reported.
 * @module @tivility/dsh-tool-subagent-model/preset-install
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled preset's id, which is also its directory name in both places. */
export const PRESET_ID = 'standard-subagent-model'

/** Where the harness reads a person's own presets from, under `$DSH_HOME`. */
export const USER_PRESET_DIR = '.agent-presets'

/** Records what this package wrote, so a later run can tell its own copy from an edited one. */
export const MARKER_FILE = '.installed-by-tivility-dsh-tool-subagent-model'

/** What one install attempt did, for the caller to log. */
export type InstallOutcome =
  | { readonly kind: 'installed' }
  | { readonly kind: 'updated', readonly from: string }
  | { readonly kind: 'current' }
  | { readonly kind: 'kept-edited' }
  | { readonly kind: 'migrated', readonly backup: string }
  | { readonly kind: 'adopted' }
  | { readonly kind: 'unavailable', readonly reason: string }

/** The marker's contents: what was written, and by which release. */
interface Marker {
  readonly version: string
  readonly digest: string
}

/** One preset file, as it is copied and hashed. */
interface PresetFile {
  readonly name: string
  readonly body: Buffer
}

/**
 * Read a preset directory's files, excluding the marker.
 * @param directory - the preset directory.
 * @returns its files sorted by name, or undefined when the directory is absent.
 */
async function readPreset(directory: string): Promise<PresetFile[] | undefined> {
  let names: string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries.filter(entry => entry.isFile() && entry.name !== MARKER_FILE).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return await Promise.all(names.map(async name => ({ name, body: await readFile(join(directory, name)) })))
}

/**
 * A digest over a preset's files, name and content both.
 *
 * Names are included and length-prefixed so that renaming a file, or moving
 * bytes across a file boundary, cannot leave the digest unchanged.
 * @param files - the preset's files, sorted by name.
 * @returns the hex digest.
 */
export function digestOf(files: readonly PresetFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${String(file.name.length)}:${file.name}:${String(file.body.byteLength)}:`)
    hash.update(file.body)
  }
  return hash.digest('hex')
}

/**
 * Read the marker this package may have left in a preset directory.
 * @param directory - the installed preset directory.
 * @returns the marker, or undefined when absent or unreadable.
 */
async function readMarker(directory: string): Promise<Marker | undefined> {
  let raw: string
  try {
    raw = await readFile(join(directory, MARKER_FILE), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Marker>
    if (typeof parsed.version !== 'string' || typeof parsed.digest !== 'string') return undefined
    return { version: parsed.version, digest: parsed.digest }
  } catch {
    // A corrupt marker is treated as no marker: the copy is then foreign, and
    // being left alone is the safe reading of "this package cannot prove it
    // wrote that".
    return undefined
  }
}

/**
 * Replace a preset directory's contents with the given files.
 * @param directory - the destination preset directory.
 * @param files - the files to write.
 * @param marker - the record to leave behind.
 */
async function write(directory: string, files: readonly PresetFile[], marker: Marker): Promise<void> {
  await mkdir(directory, { recursive: true })
  const keep = new Set([...files.map(file => file.name), MARKER_FILE])
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // A file this package's previous release wrote and this one does not; the
    // copy is provably ours, so its leftovers are ours to remove.
    if (entry.isFile() && !keep.has(entry.name)) await rm(join(directory, entry.name))
  }
  for (const file of files) await writeFile(join(directory, file.name), file.body)
  await writeFile(join(directory, MARKER_FILE), `${JSON.stringify(marker, undefined, 2)}\n`)
}

/** This package's own root, from which both the manifest and the preset hang. */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * This release's version, read from the manifest beside the shipped preset.
 * @param root - the package root.
 * @returns the version, or `unknown` when the manifest cannot be read.
 */
async function packageVersion(root: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof raw.version === 'string' ? raw.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** What an install may be pointed at, for tests that must not touch the real home. */
export interface InstallOptions {
  /** The bundled preset directory; defaults to this package's own. */
  readonly sourceDir?: string
  /** The version recorded in the marker; defaults to this package's own. */
  readonly version?: string
}

/**
 * Move a preset directory out of the roster without deleting it.
 *
 * The destination carries a dot, which `PRESET_ID` does not admit, so the
 * scanner passes over it — set aside rather than merely renamed. A counter
 * rather than a timestamp keeps repeated runs from accumulating a new copy per
 * boot, and keeps the name reproducible in tests.
 * @param directory - the preset directory to set aside.
 * @returns the path the contents now live at.
 */
async function setAside(directory: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const destination = `${directory}.superseded-${String(index)}`
    try {
      await rename(directory, destination)
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    }
  }
}

/**
 * Install or refresh the bundled preset in the harness's user preset root.
 *
 * Never throws: a preset that could not be installed is a missing menu entry,
 * not a reason for the delegation tool to fail to load.
 * @param home - the resolved `$DSH_HOME`.
 * @param options - overrides for tests.
 * @returns what happened, for the caller to log.
 */
export async function installBundledPreset(
  home: string,
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  try {
    const root = packageRoot()
    const sourceDir = options.sourceDir ?? join(root, 'presets', PRESET_ID)
    const version = options.version ?? await packageVersion(root)
    const source = await readPreset(sourceDir)
    if (source === undefined || source.length === 0) {
      return { kind: 'unavailable', reason: `the bundled preset is missing from ${sourceDir}` }
    }
    const digest = digestOf(source)
    const target = join(home, USER_PRESET_DIR, PRESET_ID)
    const installed = await readPreset(target)

    if (installed === undefined) {
      await write(target, source, { version, digest })
      return { kind: 'installed' }
    }

    const current = digestOf(installed)
    if (current === digest) {
      // Identical either way; adopt it so the next release may refresh it.
      const marker = await readMarker(target)
      if (marker?.digest !== digest) await write(target, source, { version, digest })
      return { kind: marker === undefined ? 'adopted' : 'current' }
    }

    const marker = await readMarker(target)
    if (marker !== undefined && marker.digest !== current) return { kind: 'kept-edited' }

    if (marker === undefined) {
      // A directory under this preset's id that this package cannot prove it
      // wrote: almost always a copy made by hand before the package installed
      // itself, and stale by exactly the amount this install would fix. It is
      // still not ours to delete, and saying so in a log would say it to
      // nobody — `dsh web` prints one line for a whole boot. So it is set
      // aside instead, under a name the scanner skips (`PRESET_ID` admits no
      // dot), where it stays readable and stops being the preset in use.
      const backup = await setAside(target)
      await write(target, source, { version, digest })
      return { kind: 'migrated', backup }
    }

    await write(target, source, { version, digest })
    return { kind: 'updated', from: marker.version }
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One line describing an outcome, or nothing when there is nothing to say.
 * @param outcome - what the install did.
 * @param home - the resolved `$DSH_HOME`, for naming the directory in advice.
 * @returns the message and how loudly to say it.
 */
export function describeOutcome(
  outcome: InstallOutcome, home: string,
): { readonly level: 'info' | 'warn', readonly message: string } | undefined {
  const at = join(home, USER_PRESET_DIR, PRESET_ID)
  switch (outcome.kind) {
    case 'installed':
      return { level: 'info', message: `tool-subagent-model: installed the "${PRESET_ID}" preset into ${at}` }
    case 'updated':
      return {
        level: 'info',
        message: `tool-subagent-model: updated the "${PRESET_ID}" preset in ${at} (was from ${outcome.from})`,
      }
    case 'kept-edited':
      return {
        level: 'warn',
        message: `tool-subagent-model: ${at} has local edits, so it was left as it is — `
          + 'delete it to take this release\'s version',
      }
    case 'migrated':
      return {
        level: 'info',
        message: `tool-subagent-model: replaced a preset at ${at} that this package did not write; `
          + `the previous contents are at ${outcome.backup}`,
      }
    case 'unavailable':
      return {
        level: 'warn',
        message: `tool-subagent-model: could not install the "${PRESET_ID}" preset: ${outcome.reason}`,
      }
    // Nothing changed and nothing needs saying.
    case 'current':
    case 'adopted':
      return undefined
  }
}
