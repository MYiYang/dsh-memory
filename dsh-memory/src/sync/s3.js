/**
 * Minimal S3 client (SigV4), no dependencies.
 *
 * Only the five calls sync needs are implemented: PutObject, GetObject,
 * HeadObject, ListObjectsV2, DeleteObject. Multipart, ACLs and presigned URLs
 * are deliberately absent — segments are capped at 1 MB.
 *
 * The signing code is validated against three official AWS test vectors (ranged
 * GET, PUT with storage class, LIST with query string); see
 * `test/sync-s3.test.js`.
 *
 * @module dsh-memory/sync/s3
 */
import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/**
 * @param {string} code
 * @param {string} message
 * @param {{ status?: number, body?: string }} [extra]
 */
function s3Error(code, message, extra = {}) {
  const error = new Error(message)
  Object.assign(error, { code, status: extra.status ?? 0, body: extra.body ?? '' })
  return error
}

/**
 * @param {string} value
 * @returns {string}
 */
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')

/**
 * @param {Buffer|string} key
 * @param {Buffer|string} data
 * @returns {Buffer}
 */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * RFC 3986 encoding for one path segment (`/` is kept by the caller).
 * @param {string} value
 * @returns {string}
 */
function encodeSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Canonical URI: encode each segment, keep the separators.
 * @param {string} path
 * @returns {string}
 */
export function canonicalUri(path) {
  return path
    .split('/')
    .map((part) => encodeSegment(part))
    .join('/')
}

/**
 * Canonical query string: every pair sorted by encoded key then value.
 * @param {Record<string, string|number|undefined>} query
 * @returns {string}
 */
export function canonicalQuery(query) {
  const pairs = []
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    pairs.push([encodeSegment(key), encodeSegment(String(value))])
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

/**
 * Sign one request. Exported for the test vectors.
 *
 * @param {{
 *   method: string, path: string, query?: Record<string, any>, headers: Record<string, string>,
 *   payloadHash: string, accessKey: string, secretKey: string, region: string,
 *   service?: string, amzDate: string,
 * }} input
 * @returns {{ authorization: string, canonicalRequest: string, stringToSign: string, signature: string }}
 */
export function signRequest(input) {
  const headers = {}
  for (const [key, value] of Object.entries(input.headers)) headers[key.toLowerCase()] = String(value).trim()
  const keys = Object.keys(headers).sort()
  const canonicalHeaders = keys.map((key) => `${key}:${headers[key]}\n`).join('')
  const signedHeaders = keys.join(';')
  const query = canonicalQuery(input.query ?? {})
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const dateStamp = input.amzDate.slice(0, 8)
  const scope = `${dateStamp}/${input.region}/${input.service ?? 's3'}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  let signingKey = hmac(`AWS4${input.secretKey}`, dateStamp)
  signingKey = hmac(signingKey, input.region)
  signingKey = hmac(signingKey, input.service ?? 's3')
  signingKey = hmac(signingKey, 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signature,
  }
}

/**
 * `YYYYMMDD'T'HHmmss'Z'`
 * @param {Date} [date]
 * @returns {string}
 */
export function amzNow(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Create a client bound to one bucket.
 *
 * @param {{
 *   endpoint: string, bucket: string, region?: string, pathStyle?: boolean,
 *   accessKey: string, secretKey: string, timeoutMs?: number, caFile?: string,
 * }} config
 * @returns {{
 *   describe: () => Record<string, any>,
 *   put: (key: string, body: Buffer, opts?: { ifAbsent?: boolean }) => Promise<{ status: number, etag: string|null, existed?: boolean }>,
 *   get: (key: string) => Promise<{ body: Buffer, etag: string|null } | null>,
 *   head: (key: string) => Promise<{ size: number, etag: string|null } | null>,
 *   list: (prefix: string) => Promise<Array<{ key: string, size: number, lastModified: number }>>,
 *   delete: (key: string) => Promise<void>,
 * }}
 */
export function createS3Client(config) {
  const url = new URL(config.endpoint)
  const secure = url.protocol === 'https:'
  const request = secure ? httpsRequest : httpRequest
  const region = String(config.region || 'us-east-1')
  const pathStyle = config.pathStyle !== false
  const timeoutMs = Math.max(1_000, Number(config.timeoutMs ?? 15_000))
  const bucket = String(config.bucket ?? '')
  let ca
  if (secure && config.caFile) ca = readFileSync(String(config.caFile))

  /**
   * @param {string} method
   * @param {string} key
   * @param {{ query?: Record<string, any>, body?: Buffer, headers?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
   */
  function send(method, key, options = {}) {
    const objectPath = key === '' ? '' : '/' + key.replace(/^\/+/, '')
    const path = pathStyle ? `/${bucket}${objectPath}` : objectPath || '/'
    const host = pathStyle ? url.host : `${bucket}.${url.host}`
    const payload = options.body ?? Buffer.alloc(0)
    const payloadHash = sha256Hex(payload)
    const amzDate = amzNow()
    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.headers ?? {}),
    }
    if (payload.length > 0) headers['content-length'] = String(payload.length)

    const signed = signRequest({
      method,
      path,
      query: options.query ?? {},
      headers,
      payloadHash,
      accessKey: String(config.accessKey ?? ''),
      secretKey: String(config.secretKey ?? ''),
      region,
      amzDate,
    })

    const query = canonicalQuery(options.query ?? {})
    const target = path + (query === '' ? '' : `?${query}`)
    const sendHeaders = { ...headers, authorization: signed.authorization }

    return new Promise((resolve, reject) => {
      const req = request(
        {
          protocol: url.protocol,
          hostname: pathStyle ? url.hostname : `${bucket}.${url.hostname}`,
          port: url.port || (secure ? 443 : 80),
          method,
          path: target,
          headers: sendHeaders,
          timeout: timeoutMs,
          ...(ca === undefined ? {} : { ca }),
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: /** @type {Record<string, string>} */ (res.headers),
              body: Buffer.concat(chunks),
            })
          })
        },
      )
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('s3 request timed out'), { code: 'ETIMEDOUT' }))
      })
      req.on('error', (error) => reject(Object.assign(error, { code: /** @type {any} */ (error).code ?? 'ENETWORK' })))
      if (payload.length > 0) req.write(payload)
      req.end()
    })
  }

  /**
   * @param {Record<string, any>} response
   * @param {string} action
   */
  function fail(response, action) {
    const text = response.body.toString('utf8')
    const code = (text.match(/<Code>([^<]+)<\/Code>/) ?? [])[1] ?? ''
    const message = (text.match(/<Message>([^<]+)<\/Message>/) ?? [])[1] ?? `HTTP ${response.status}`
    throw s3Error(code || 's3-error', `${action}: ${message}`.trim(), { status: response.status, body: text.slice(0, 400) })
  }

  return {
    describe() {
      return { kind: 's3', endpoint: config.endpoint, bucket, region, pathStyle, secure }
    },

    async put(key, body, opts = {}) {
      const headers = {}
      if (opts.ifAbsent === true) headers['if-none-match'] = '*'
      const response = await send('PUT', key, { body, headers })
      if (response.status === 412) return { status: 412, etag: null, existed: true }
      if (response.status < 200 || response.status >= 300) fail(response, 'PUT')
      return { status: response.status, etag: response.headers.etag ?? null }
    },

    async get(key) {
      const response = await send('GET', key)
      if (response.status === 404) return null
      if (response.status < 200 || response.status >= 300) fail(response, 'GET')
      return { body: response.body, etag: response.headers.etag ?? null }
    },

    async head(key) {
      const response = await send('HEAD', key)
      if (response.status === 404) return null
      if (response.status < 200 || response.status >= 300) fail(response, 'HEAD')
      return { size: Number(response.headers['content-length'] ?? 0), etag: response.headers.etag ?? null }
    },

    async list(prefix) {
      /** @type {Array<{ key: string, size: number, lastModified: number }>} */
      const out = []
      let token
      for (let page = 0; page < 20; page++) {
        const query = { 'list-type': 2, prefix, 'max-keys': 1000, ...(token === undefined ? {} : { 'continuation-token': token }) }
        const response = await send('GET', '', { query })
        if (response.status < 200 || response.status >= 300) fail(response, 'LIST')
        const xml = response.body.toString('utf8')
        const re = /<Contents>([\s\S]*?)<\/Contents>/g
        let match
        while ((match = re.exec(xml)) !== null) {
          const block = match[1]
          const key = (block.match(/<Key>([^<]+)<\/Key>/) ?? [])[1]
          const size = Number((block.match(/<Size>(\d+)<\/Size>/) ?? [])[1] ?? 0)
          const lastModified = Date.parse((block.match(/<LastModified>([^<]+)<\/LastModified>/) ?? [])[1] ?? '') || 0
          if (key !== undefined) out.push({ key: decodeXml(key), size, lastModified })
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) ?? [])[1]
        if (!truncated || token === undefined) break
      }
      return out
    },

    async delete(key) {
      const response = await send('DELETE', key)
      if (response.status === 404) return
      if (response.status < 200 || response.status >= 300) fail(response, 'DELETE')
    },
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function decodeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export { EMPTY_SHA256 }
