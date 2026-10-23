/**
 * The `/memory/api` HTTP surface used by the Settings → Memory page.
 *
 * The browser half cannot read files or touch the plugin's runtime, so this
 * route is the only bridge. It is deliberately tiny and uniform:
 *
 *   POST /memory/api/<method>   JSON object in, `{ ok, value }` out
 *
 * Every method is POST (a cross-site form cannot send `application/json`
 * without a CORS preflight, and the route is same-origin), every payload is a
 * plain object, and every failure is `{ ok: false, error: { code, message } }`
 * with a stable code — the client renders the message, the tests assert the
 * code.
 *
 * @module dsh-memory/api
 */

/** Route family; the method name is the last path segment. */
export const API_PREFIX = '/memory/api'

/** Upper bound for one request body; every payload here is a small object. */
export const MAX_BODY_BYTES = 64 * 1024

/** Stable error codes → HTTP status. */
const STATUS_BY_CODE = {
  'bad-request': 400,
  forbidden: 403,
  'not-found': 404,
  'method-not-allowed': 405,
  // A manual edit whose text is already stored under another row: the caller
  // can resolve it (edit that row instead), so this is not a 5xx.
  conflict: 409,
  // The data endpoints need an open database; a plugin whose database failed to
  // open still serves the settings routes, and says so with a stable 503.
  'not-ready': 503,
  'io-error': 500,
  internal: 500,
}

/** An error whose code and message are safe to show in the settings page. */
export class MemoryApiError extends Error {
  /**
   * @param {string} code - one of the keys of STATUS_BY_CODE
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'MemoryApiError'
    this.code = code
  }

  /** HTTP status this error maps to. */
  get status() {
    return STATUS_BY_CODE[this.code] ?? 500
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Read and validate a small JSON object body. An empty body is `{}`.
 * @param {AsyncIterable<Uint8Array|string>} req
 * @returns {Promise<Record<string, any>>}
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (size > MAX_BODY_BYTES) throw new MemoryApiError('bad-request', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MemoryApiError('bad-request', 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MemoryApiError('bad-request', 'request body must be a JSON object')
  }
  return parsed
}

/**
 * Build the web route.
 *
 * @param {{
 *   methods: Record<string, (payload: Record<string, any>) => any | Promise<any>>,
 *   admits?: (req: import('node:http').IncomingMessage) => boolean,
 *   log?: (level: string, message: string) => void,
 * }} options
 * @returns {{ kind: 'prefix', path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }}
 */
export function createApiRoute(options) {
  const methods = options.methods ?? {}
  const log = options.log ?? (() => {})

  return {
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      try {
        // Trust fence first: an unauthenticated caller must not learn which
        // methods exist.
        if (typeof options.admits === 'function' && options.admits(req) !== true) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        if (!pathname.startsWith(`${API_PREFIX}/`)) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown endpoint' } })
          return
        }
        const method = pathname.slice(API_PREFIX.length + 1)
        if (method.includes('/') || !Object.hasOwn(methods, method)) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
          return
        }
        try {
          const payload = await readJsonBody(req)
          const value = await methods[method](payload)
          writeJson(res, 200, { ok: true, value })
        } catch (error) {
          if (error instanceof MemoryApiError) {
            writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          if (error instanceof TypeError || error instanceof RangeError) {
            // Programming errors are not caller-correctable; keep the detail in
            // the log so a broken plugin does not leak stack traces to the page.
            log('warn', `${method} failed: ${message}`)
            writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'the memory operation failed' } })
            return
          }
          log('warn', `${method} failed: ${message}`)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
        }
      } catch (error) {
        // Never leave a request hanging: the last line of defence.
        try {
          log('warn', `api handler threw: ${error instanceof Error ? error.message : String(error)}`)
          writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'the memory api failed' } })
        } catch {
          try {
            res.destroy?.()
          } catch {
            /* ignore */
          }
        }
      }
    },
  }
}
