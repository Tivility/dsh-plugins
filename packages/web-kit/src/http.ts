/**
 * Response plumbing for read-only plugin routes: content typing, validators,
 * byte ranges, and the small senders that wrap them.
 *
 * A plugin route owns its whole response lifecycle — the webserver matches a
 * route and steps aside, and a named route is matched ahead of any
 * method handling the carrier would otherwise apply — so every one of these
 * concerns is the route's to get right. Ranges in particular are not
 * optional decoration: a browser will not scrub an inline video, and will not
 * resume an interrupted download, from a server that answers every request
 * with the whole file.
 * @module @tivility/dsh-web-kit/http
 */

import { createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'

/** Content types by file extension, lowercase, dot included. */
export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** Served as text even though the extension is unknown to {@link MIME}. */
const TEXT_MIME = 'text/plain; charset=utf-8'

/** Served when nothing else matches: never sniffed, never executed. */
const OPAQUE_MIME = 'application/octet-stream'

/**
 * The content type for one filename.
 * @param path - file path or name; only the extension is read.
 * @param fallback - type for an extension {@link MIME} does not list.
 * @returns the content type.
 */
export function mimeFor(path: string, fallback: string = OPAQUE_MIME): string {
  return MIME[extname(path).toLowerCase()] ?? fallback
}

/**
 * Whether a content type describes bytes a browser may render inline without
 * the response becoming a script execution surface in this origin.
 * @param type - a content type, with or without parameters.
 * @returns true for images, audio, video, and PDF.
 */
export function isInlineSafe(type: string): boolean {
  const essence = type.split(';')[0]?.trim().toLowerCase() ?? ''
  if (essence === 'application/pdf') return true
  // SVG is an image that executes script, so it is deliberately excluded: an
  // inline SVG from a workspace would run in this origin.
  if (essence === 'image/svg+xml') return false
  return essence.startsWith('image/') || essence.startsWith('audio/') || essence.startsWith('video/')
}

/**
 * A validator for one file version.
 *
 * Size and mtime, not a content hash: a hash means reading every byte of a
 * file the request may not even want, and these two change together on every
 * write the plugins can produce. The value is quoted and weak — an mtime has
 * second-to-millisecond resolution depending on the filesystem, so two writes
 * inside one tick can collide, and a weak validator is the honest label for
 * that. Weak validators are still valid for `If-None-Match`; ranges fall back
 * to a full response when they cannot be trusted.
 * @param stats - the file's stat result.
 * @returns the ETag header value, quotes included.
 */
export function etagFor(stats: Stats): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

/**
 * Whether a request's `If-None-Match` already holds this version.
 * @param req - the incoming request.
 * @param etag - the current entity tag.
 * @returns true when the client may be answered with 304.
 */
export function isFresh(req: IncomingMessage, etag: string): boolean {
  const header = req.headers['if-none-match']
  if (typeof header !== 'string') return false
  if (header.trim() === '*') return true
  // Weak comparison: W/"x" and "x" name the same entity for freshness.
  const bare = (value: string): string => value.trim().replace(/^W\//, '')
  return header.split(',').some(candidate => bare(candidate) === bare(etag))
}

/** One satisfiable byte range, inclusive on both ends. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * Parse a single-range `Range` header against a known size.
 *
 * Only one range is honored. A multi-range request is answered in full
 * instead, which the specification permits and which avoids emitting a
 * multipart body no consumer of these routes asks for.
 * @param header - the raw `Range` header, if any.
 * @param size - the entity's total size in bytes.
 * @returns the range, `undefined` to serve the whole entity, or `'unsatisfiable'`.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | undefined | 'unsatisfiable' {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    // Suffix form: the last N bytes. A zero-length suffix names nothing.
    const length = Number(rawEnd)
    if (length === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/** Headers written alongside every response this module sends. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  // These routes serve workspace bytes chosen by a URL. Sniffing would let a
  // text file be reinterpreted as script; a restrictive policy keeps whatever
  // does render from reaching back into this origin.
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

/**
 * Send a status with an optional short text body.
 * @param res - the response to write.
 * @param code - HTTP status code.
 * @param body - plain-text body; omitted for an empty response.
 * @param headers - extra response headers.
 */
export function sendStatus(
  res: ServerResponse,
  code: number,
  body?: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (body === undefined) {
    res.writeHead(code, { ...BASE_HEADERS, ...headers })
    res.end()
    return
  }
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(code, {
    ...BASE_HEADERS,
    'content-type': TEXT_MIME,
    'content-length': String(payload.byteLength),
    ...headers,
  })
  res.end(payload)
}

/**
 * Send an in-memory body with an explicit content type.
 * @param res - the response to write.
 * @param body - the bytes or text to send.
 * @param type - the content type.
 * @param headers - extra response headers.
 * @param code - HTTP status code; defaults to 200.
 */
export function sendBody(
  res: ServerResponse,
  body: string | Buffer,
  type: string,
  headers: Readonly<Record<string, string>> = {},
  code = 200,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  res.writeHead(code, {
    ...BASE_HEADERS,
    'content-type': type,
    'content-length': String(payload.byteLength),
    ...headers,
  })
  // A HEAD response carries the headers of the GET it stands in for, and no body.
  res.end(res.req.method === 'HEAD' ? undefined : payload)
}

/**
 * Send an HTML page.
 * @param res - the response to write.
 * @param html - the document body.
 * @param headers - extra response headers.
 */
export function sendHtml(
  res: ServerResponse,
  html: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendBody(res, html, 'text/html; charset=utf-8', headers)
}

/**
 * Send a JSON value.
 * @param res - the response to write.
 * @param value - the value to serialize.
 * @param code - HTTP status code; defaults to 200.
 */
export function sendJson(res: ServerResponse, value: unknown, code = 200): void {
  sendBody(res, JSON.stringify(value), 'application/json; charset=utf-8', {}, code)
}

/** How one file should be presented to the browser. */
export interface ServeFileOptions {
  /** Content type; derived from the extension when absent. */
  readonly type?: string
  /** Offer the file as a download under this filename. */
  readonly download?: string
  /**
   * Render in the browser rather than downloading. Defaults to
   * {@link isInlineSafe}, which is deliberately narrow: the caller decides
   * that anything else is safe to display, because "display" for `text/html`
   * means executing it in this origin.
   */
  readonly inline?: boolean
  /** `Cache-Control` value; validators alone are used when absent. */
  readonly cacheControl?: string
  /** Extra response headers, merged last. */
  readonly headers?: Readonly<Record<string, string>>
  /** Already-taken stat result, to avoid a second syscall. */
  readonly stats?: Stats
}

/**
 * Serve one regular file with validators and range support.
 *
 * The caller has already decided this path may be read; this function makes
 * no containment judgment of its own.
 * @param req - the incoming request, read for method and conditional headers.
 * @param res - the response to write.
 * @param file - absolute path of a regular file.
 * @param options - presentation and caching.
 * @returns resolution once the response has been handed to the socket.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  options: ServeFileOptions = {},
): Promise<void> {
  const stats = options.stats ?? await stat(file)
  const etag = etagFor(stats)
  const type = options.type ?? mimeFor(file)
  const disposition = options.download !== undefined
    ? `attachment; filename*=UTF-8''${encodeURIComponent(options.download)}`
    : (options.inline ?? isInlineSafe(type)) ? 'inline' : 'attachment'
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'content-type': type,
    'accept-ranges': 'bytes',
    etag,
    'last-modified': new Date(stats.mtimeMs).toUTCString(),
    'content-disposition': disposition,
    ...(options.cacheControl === undefined ? {} : { 'cache-control': options.cacheControl }),
    ...options.headers,
  }

  if (isFresh(req, etag)) {
    // A 304 carries validators and nothing else; a body here would be a protocol error.
    res.writeHead(304, { etag, ...(options.cacheControl === undefined ? {} : { 'cache-control': options.cacheControl }) })
    res.end()
    return
  }

  // If-Range guards a resumed transfer: when the entity changed under the
  // client, the range it remembers names different bytes, so the whole file is
  // the only correct answer.
  const ifRange = req.headers['if-range']
  const rangeApplies = ifRange === undefined || ifRange === etag
  const range = rangeApplies ? parseRange(req.headers.range, stats.size) : undefined

  if (range === 'unsatisfiable') {
    sendStatus(res, 416, undefined, { 'content-range': `bytes */${String(stats.size)}` })
    return
  }

  if (range === undefined) {
    res.writeHead(200, { ...headers, 'content-length': String(stats.size) })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeFile(res, file)
    return
  }

  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(stats.size)}`,
    'content-length': String(range.end - range.start + 1),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeFile(res, file, range)
}

/**
 * Stream a file, or a slice of one, into an already-headed response.
 * @param res - the response, with its head already written.
 * @param file - absolute path of the file to read.
 * @param range - byte range to send; the whole file when absent.
 * @returns resolution once the stream has finished or failed.
 */
async function pipeFile(res: ServerResponse, file: string, range?: ByteRange): Promise<void> {
  const stream = createReadStream(file, range === undefined ? {} : { start: range.start, end: range.end })
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      stream.destroy()
      resolve()
    }
    // The head is already on the wire, so a mid-stream read failure has no
    // status left to report with: dropping the connection is what tells the
    // client the body is incomplete.
    stream.on('error', () => {
      res.destroy()
      finish()
    })
    res.on('close', finish)
    stream.pipe(res)
    stream.on('end', finish)
  })
}

/**
 * Refuse anything but a read method, answering the way the carrier would.
 * @param req - the incoming request.
 * @param res - the response to write on refusal.
 * @returns true when the request may proceed.
 */
export function assertReadMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  sendStatus(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
  return false
}
