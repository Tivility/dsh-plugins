import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installBundledPreset, describeOutcome, MARKER_FILE, PRESET_ID, USER_PRESET_DIR,
} from '../src/preset-install.ts'

let base: string
let home: string
let source: string

/** The installed preset directory the harness would scan. */
function installed(): string {
  return join(home, USER_PRESET_DIR, PRESET_ID)
}

/** Install from the fixture source, never from this package's real preset. */
async function install(version = '1.0.0'): ReturnType<typeof installBundledPreset> {
  return await installBundledPreset(home, { sourceDir: source, version })
}

/** One installed file's contents. */
async function read(name: string): Promise<string> {
  return await readFile(join(installed(), name), 'utf8')
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'preset-install-'))
  home = join(base, 'home')
  source = join(base, 'pkg', 'presets', PRESET_ID)
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'preset.yml'), 'name: 混动模式\n')
  await writeFile(join(source, 'agent.cordis.yml'), '- name: a\n')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('a preset root that has never been installed into', () => {
  it('creates the preset and records what it wrote', async () => {
    expect(await install()).toEqual({ kind: 'installed' })
    expect(await read('preset.yml')).toBe('name: 混动模式\n')
    const marker = JSON.parse(await read(MARKER_FILE)) as { version: string, digest: string }
    expect(marker.version).toBe('1.0.0')
    expect(marker.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('says nothing when the second run finds its own copy unchanged', async () => {
    await install()
    expect(await install()).toEqual({ kind: 'current' })
    expect(describeOutcome({ kind: 'current' }, home)).toBeUndefined()
  })
})

describe('a new release of the preset', () => {
  it('replaces a copy this package wrote and still owns', async () => {
    await install('1.0.0')
    await writeFile(join(source, 'preset.yml'), 'name: 混动模式 v2\n')
    expect(await install('2.0.0')).toEqual({ kind: 'updated', from: '1.0.0' })
    expect(await read('preset.yml')).toBe('name: 混动模式 v2\n')
    expect(JSON.parse(await read(MARKER_FILE)).version).toBe('2.0.0')
  })

  it('removes a file the previous release wrote and this one dropped', async () => {
    await writeFile(join(source, 'README.md'), 'old\n')
    await install('1.0.0')
    await rm(join(source, 'README.md'))
    await writeFile(join(source, 'preset.yml'), 'name: v2\n')
    expect((await install('2.0.0')).kind).toBe('updated')
    expect(await readdir(installed())).not.toContain('README.md')
  })
})

describe('a copy this package must not touch', () => {
  it('keeps local edits and says so', async () => {
    await install('1.0.0')
    await writeFile(join(installed(), 'preset.yml'), 'name: 我自己改的\n')
    await writeFile(join(source, 'preset.yml'), 'name: 混动模式 v2\n')

    expect(await install('2.0.0')).toEqual({ kind: 'kept-edited' })
    expect(await read('preset.yml')).toBe('name: 我自己改的\n')
    expect(describeOutcome({ kind: 'kept-edited' }, home)?.level).toBe('warn')
  })

  it('treats a corrupt marker as no marker rather than as ownership', async () => {
    await install('1.0.0')
    await writeFile(join(installed(), MARKER_FILE), '{ not json')
    await writeFile(join(source, 'preset.yml'), 'name: v2\n')
    // Unprovable ownership is migrated, not silently overwritten in place.
    expect((await install('2.0.0')).kind).toBe('migrated')
  })
})

describe('a hand-copied preset this package did not write', () => {
  beforeEach(async () => {
    await mkdir(installed(), { recursive: true })
    await writeFile(join(installed(), 'preset.yml'), 'name: 老名字\n')
    await writeFile(join(installed(), 'agent.cordis.yml'), '- name: a\n')
  })

  it('is replaced, so a stale copy stops being the one in use', async () => {
    const outcome = await install()
    expect(outcome.kind).toBe('migrated')
    expect(await read('preset.yml')).toBe('name: 混动模式\n')
  })

  it('keeps the previous contents, out of the roster rather than deleted', async () => {
    const outcome = await install()
    const backup = (outcome as { backup: string }).backup
    expect(await readFile(join(backup, 'preset.yml'), 'utf8')).toBe('name: 老名字\n')
    // PRESET_ID admits no dot, so the scanner passes over the set-aside copy.
    expect(/^[a-z0-9][a-z0-9-]*$/.test(backup.split('/').pop() ?? '')).toBe(false)
  })

  it('does not accumulate a new backup on every boot', async () => {
    await install()
    const before = await readdir(join(home, USER_PRESET_DIR))
    await install()
    await install()
    expect(await readdir(join(home, USER_PRESET_DIR))).toEqual(before)
  })

  it('reports where the previous contents went', async () => {
    const outcome = await install()
    const said = describeOutcome(outcome, home)
    expect(said?.message).toContain('superseded-1')
  })
})

describe('a hand-copied preset that already matches', () => {
  it('is adopted silently, so the next release may refresh it', async () => {
    await mkdir(installed(), { recursive: true })
    await writeFile(join(installed(), 'preset.yml'), 'name: 混动模式\n')
    await writeFile(join(installed(), 'agent.cordis.yml'), '- name: a\n')

    expect(await install('1.0.0')).toEqual({ kind: 'adopted' })
    expect(describeOutcome({ kind: 'adopted' }, home)).toBeUndefined()

    // Adoption is what lets the next release update it rather than refuse.
    await writeFile(join(source, 'preset.yml'), 'name: v2\n')
    expect((await install('2.0.0')).kind).toBe('updated')
  })
})

describe('failures', () => {
  it('reports a missing bundled preset instead of throwing', async () => {
    const outcome = await installBundledPreset(home, { sourceDir: join(base, 'nope'), version: '1.0.0' })
    expect(outcome.kind).toBe('unavailable')
    expect(describeOutcome(outcome, home)?.level).toBe('warn')
  })

  it('reports an unwritable home instead of throwing', async () => {
    // A file where the preset root must be a directory.
    await mkdir(join(base, 'blocked'), { recursive: true })
    await writeFile(join(base, 'blocked', USER_PRESET_DIR), 'not a directory\n')
    const outcome = await installBundledPreset(join(base, 'blocked'), { sourceDir: source, version: '1.0.0' })
    expect(outcome.kind).toBe('unavailable')
  })
})

describe('the digest', () => {
  it('changes when content moves between files without changing the total bytes', async () => {
    await writeFile(join(source, 'preset.yml'), 'ab\n')
    await writeFile(join(source, 'agent.cordis.yml'), 'cd\n')
    await install('1.0.0')
    const first = JSON.parse(await read(MARKER_FILE)).digest as string

    await rm(join(base, 'home'), { recursive: true, force: true })
    await writeFile(join(source, 'preset.yml'), 'abc\n')
    await writeFile(join(source, 'agent.cordis.yml'), 'd\n')
    await install('1.0.0')
    expect(JSON.parse(await read(MARKER_FILE)).digest).not.toBe(first)
  })

  it('ignores the marker itself, so writing it does not invalidate it', async () => {
    await install('1.0.0')
    expect((await install('1.0.0')).kind).toBe('current')
  })
})
