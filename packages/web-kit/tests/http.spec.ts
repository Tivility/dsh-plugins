import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { etagFor, isFresh, isInlineSafe, mimeFor, parseRange, serveFile } from '../src/http.ts'

describe('mimeFor', () => {
  it('types the extensions these routes actually serve', () => {
    expect(mimeFor('/a/b.png')).toBe('image/png')
    expect(mimeFor('/a/b.PDF')).toBe('application/pdf')
    expect(mimeFor('/a/b.mp4')).toBe('video/mp4')
  })

  it('falls back rather than guessing', () => {
    expect(mimeFor('/a/binary')).toBe('application/octet-stream')
    expect(mimeFor('/a/notes.rst', 'text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8')
  })
})

describe('isInlineSafe', () => {
  it('allows media a browser renders without executing it', () => {
    expect(isInlineSafe('image/png')).toBe(true)
    expect(isInlineSafe('video/mp4')).toBe(true)
    expect(isInlineSafe('application/pdf')).toBe(true)
  })

  it('excludes SVG, which is an image that runs script in this origin', () => {
    expect(isInlineSafe('image/svg+xml')).toBe(false)
  })

  it('excludes everything else', () => {
    expect(isInlineSafe('text/html; charset=utf-8')).toBe(false)
    expect(isInlineSafe('application/octet-stream')).toBe(false)
  })
})

describe('parseRange', () => {
  it('reads the closed, open, and suffix forms', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('clamps an end past the entity instead of failing', () => {
    expect(parseRange('bytes=95-500', 100)).toEqual({ start: 95, end: 99 })
  })

  it('reports the unsatisfiable cases', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })

  it('serves the whole entity for an absent, malformed, or multi-range header', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('items=0-9', 100)).toBeUndefined()
    expect(parseRange('bytes=0-9,20-29', 100)).toBeUndefined()
    expect(parseRange('bytes=-', 100)).toBeUndefined()
  })
})

describe('isFresh', () => {
  const etag = 'W/"10-1a2b"'

  it('matches weakly, so W/"x" and "x" name one entity', () => {
    expect(isFresh({ headers: { 'if-none-match': etag } } as never, etag)).toBe(true)
    expect(isFresh({ headers: { 'if-none-match': '"10-1a2b"' } } as never, etag)).toBe(true)
  })

  it('matches any member of a list, and the wildcard', () => {
    expect(isFresh({ headers: { 'if-none-match': `"other", ${etag}` } } as never, etag)).toBe(true)
    expect(isFresh({ headers: { 'if-none-match': '*' } } as never, etag)).toBe(true)
  })

  it('does not match a different version or an absent header', () => {
    expect(isFresh({ headers: { 'if-none-match': 'W/"99-ffff"' } } as never, etag)).toBe(false)
    expect(isFresh({ headers: {} } as never, etag)).toBe(false)
  })
})

describe('serveFile', () => {
  let dir: string
  let file: string
  let server: Server
  let origin: string
  const body = 'abcdefghijklmnopqrstuvwxyz'

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'web-kit-http-'))
    file = join(dir, 'alphabet.txt')
    await writeFile(file, body)
    server = createServer((req, res) => {
      void serveFile(req, res, file, { type: 'text/plain; charset=utf-8' })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(dir, { recursive: true, force: true })
  })

  it('sends the whole file and advertises range support', async () => {
    const response = await fetch(origin)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('answers a repeat request with 304 and no body', async () => {
    const etag = (await stat(file)).size >= 0 ? etagFor(await stat(file)) : ''
    const response = await fetch(origin, { headers: { 'if-none-match': etag } })
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
  })

  it('serves the requested slice as 206', async () => {
    const response = await fetch(origin, { headers: { range: 'bytes=3-7' } })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('defgh')
    expect(response.headers.get('content-range')).toBe(`bytes 3-7/${String(body.length)}`)
  })

  it('reports an unsatisfiable range with the entity size', async () => {
    const response = await fetch(origin, { headers: { range: `bytes=${String(body.length)}-` } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${String(body.length)}`)
  })

  it('ignores a range whose If-Range names a version the file no longer has', async () => {
    const response = await fetch(origin, { headers: { range: 'bytes=3-7', 'if-range': 'W/"stale"' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
  })

  it('does not render an unrecognized type inline', async () => {
    const response = await fetch(origin)
    expect(response.headers.get('content-disposition')).toBe('attachment')
  })

  it('answers HEAD with the GET headers and no body', async () => {
    const response = await fetch(origin, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(await response.text()).toBe('')
  })
})
