import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalize, isPathUnder, resolveUnderRoots } from '../src/containment.ts'

let base: string
let root: string
let outside: string

beforeAll(async () => {
  // The temp directory itself is reached through a symlink on macOS
  // (/var -> /private/var), so the fixture root is canonicalized up front —
  // otherwise every assertion here would be testing that symlink instead.
  base = await canonicalize(await mkdtemp(join(tmpdir(), 'web-kit-')))
  root = join(base, 'workspace')
  outside = join(base, 'elsewhere')
  await mkdir(join(root, 'nested'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'nested', 'file.txt'), 'inside')
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await symlink(join(outside, 'secret.txt'), join(root, 'escape-link'))
  await symlink(outside, join(root, 'escape-dir'))
})

afterAll(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
})

describe('canonicalize', () => {
  it('resolves an existing path', async () => {
    await expect(canonicalize(join(root, 'nested', 'file.txt'))).resolves.toBe(join(root, 'nested', 'file.txt'))
  })

  it('follows a symlink to where it actually points', async () => {
    await expect(canonicalize(join(root, 'escape-link'))).resolves.toBe(join(outside, 'secret.txt'))
  })

  it('follows a symlinked directory before appending a missing child', async () => {
    await expect(canonicalize(join(root, 'escape-dir', 'new.txt'))).resolves.toBe(join(outside, 'new.txt'))
  })

  it('keeps a not-yet-existing suffix under its canonical parent', async () => {
    await expect(canonicalize(join(root, 'nested', 'a', 'b', 'c.txt')))
      .resolves.toBe(join(root, 'nested', 'a', 'b', 'c.txt'))
  })

  it('resolves ".." through the filesystem rather than lexically', async () => {
    // Spelled as a raw string: path.join() would collapse the ".." itself and
    // canonicalize() would never see the segment this asserts on.
    await expect(canonicalize(`${root}/escape-dir/..`)).resolves.toBe(base)
  })
})

describe('isPathUnder', () => {
  it('accepts the root itself and its descendants', async () => {
    await expect(isPathUnder(root, root)).resolves.toBe(true)
    await expect(isPathUnder(join(root, 'nested', 'file.txt'), root)).resolves.toBe(true)
  })

  it('rejects a sibling whose name merely starts with the root', async () => {
    await expect(isPathUnder(`${root}-other`, root)).resolves.toBe(false)
  })

  it('recognizes an alias spelling through filesystem identity', async () => {
    await expect(isPathUnder(root.toUpperCase(), root, true))
      .resolves.toBe(process.platform !== 'linux')
  })
})

describe('resolveUnderRoots', () => {
  it('returns the canonical path and its owning root', async () => {
    const found = await resolveUnderRoots(join(root, 'nested', 'file.txt'), [root])
    expect(found).toEqual({ path: join(root, 'nested', 'file.txt'), root })
  })

  it('refuses a symlink pointing out of every root', async () => {
    await expect(resolveUnderRoots(join(root, 'escape-link'), [root])).resolves.toBeUndefined()
  })

  it('refuses a write target behind a symlinked directory', async () => {
    await expect(resolveUnderRoots(join(root, 'escape-dir', 'planted.txt'), [root])).resolves.toBeUndefined()
  })

  it('refuses a traversal that leaves the root through a symlink', async () => {
    await expect(resolveUnderRoots(`${root}/escape-dir/../elsewhere/secret.txt`, [root])).resolves.toBeUndefined()
  })

  it('refuses a traversal out of the root', async () => {
    await expect(resolveUnderRoots(join(root, '..', 'elsewhere', 'secret.txt'), [root])).resolves.toBeUndefined()
  })

  it('contains nothing when no roots are configured', async () => {
    await expect(resolveUnderRoots(join(root, 'nested', 'file.txt'), [])).resolves.toBeUndefined()
  })

  it('accepts a path under any one of several roots', async () => {
    const found = await resolveUnderRoots(join(outside, 'secret.txt'), [root, outside])
    expect(found?.root).toBe(outside)
  })
})
