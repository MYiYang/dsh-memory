/**
 * Remote stores: where segments live.
 *
 * Two implementations, one shape:
 *   - `local` — a directory (a synced folder, a mounted drive, or a test harness);
 *   - `s3`    — anything speaking the S3 protocol (MinIO, OSS, R2, AWS).
 *
 * Every key is a relative POSIX path; the caller owns the layout
 * (`segmentObjectKey` / `snapshotObjectKey`).
 *
 * @module dsh-memory/sync/remote
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { createS3Client } from './s3.js'

/**
 * Resolve a credential: an env-var name when the value looks like a reference,
 * otherwise the literal (tests use literals).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function resolveSecret(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const fromEnv = process.env[text]
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : text
}

/**
 * @param {string} base
 * @param {string} key
 * @returns {string}
 */
function safeJoin(base, key) {
  const root = resolve(base)
  const target = resolve(join(root, normalize(key)))
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(':') && rel.split(':').length > 1) {
    const error = new Error(`refusing to touch a path outside the remote root: ${key}`)
    Object.assign(error, { code: 'bad-key' })
    throw error
  }
  return target
}

/**
 * @param {{ kind: 'local', dir: string } | { kind: 's3', endpoint: string, bucket: string, region?: string, pathStyle?: boolean, accessKey: string, secretKey: string, caFile?: string, timeoutMs?: number }} config
 * @returns {{
 *   kind: string,
 *   describe: () => Record<string, any>,
 *   put: (key: string, body: Buffer, opts?: { ifAbsent?: boolean }) => Promise<{ status: number, existed: boolean }>,
 *   get: (key: string) => Promise<Buffer | null>,
 *   head: (key: string) => Promise<{ size: number } | null>,
 *   list: (prefix: string) => Promise<Array<{ key: string, size: number, lastModified: number }>>,
 *   delete: (key: string) => Promise<void>,
 * }}
 */
export function createRemote(config) {
  if (config.kind === 's3') {
    const client = createS3Client({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      pathStyle: config.pathStyle,
      accessKey: resolveSecret(config.accessKey),
      secretKey: resolveSecret(config.secretKey),
      caFile: config.caFile,
      timeoutMs: config.timeoutMs,
    })
    return {
      kind: 's3',
      describe: () => client.describe(),
      async put(key, body, opts = {}) {
        const result = await client.put(key, body, opts)
        return { status: result.status, existed: result.existed === true }
      },
      async get(key) {
        const result = await client.get(key)
        return result === null ? null : result.body
      },
      head: (key) => client.head(key),
      list: (prefix) => client.list(prefix),
      delete: (key) => client.delete(key),
    }
  }

  const base = String(config.dir ?? '')
  if (base === '') throw Object.assign(new Error('local remote needs a directory'), { code: 'bad-config' })
  return {
    kind: 'local',
    describe: () => ({ kind: 'local', dir: base }),
    async put(key, body, opts = {}) {
      const target = safeJoin(base, key)
      if (opts.ifAbsent === true && existsSync(target)) return { status: 412, existed: true }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      return { status: 200, existed: false }
    },
    async get(key) {
      const target = safeJoin(base, key)
      try {
        return readFileSync(target)
      } catch (error) {
        if (/** @type {any} */ (error).code === 'ENOENT') return null
        throw error
      }
    },
    async head(key) {
      const target = safeJoin(base, key)
      try {
        const stat = statSync(target)
        return { size: stat.size }
      } catch {
        return null
      }
    },
    async list(prefix) {
      const root = resolve(base)
      const start = safeJoin(base, prefix)
      if (!existsSync(start)) return []
      /** @type {Array<{ key: string, size: number, lastModified: number }>} */
      const out = []
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          const stat = statSync(full)
          out.push({ key: relative(root, full).split('\\').join('/'), size: stat.size, lastModified: stat.mtimeMs })
        }
      }
      if (statSync(start).isDirectory()) walk(start)
      else {
        const stat = statSync(start)
        out.push({ key: relative(root, start).split('\\').join('/'), size: stat.size, lastModified: stat.mtimeMs })
      }
      return out.sort((a, b) => (a.key < b.key ? -1 : 1))
    },
    async delete(key) {
      rmSync(safeJoin(base, key), { force: true })
    },
  }
}
