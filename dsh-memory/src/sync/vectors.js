/**
 * Vector payloads: the fat half of a sync push.
 *
 * A 4096-dim float32 vector is 16 KB. Writing it into `sync_oplog.payload`
 * would mean ~21 KB of base64 per row, stored in WAL and kept for
 * `oplogKeepDays` — the oplog would grow by 120 MB for a library this size
 * while carrying nothing the blob itself does not. So the schema only marks a
 * row **dirty** and this module reads the blob back at push time.
 *
 * Three codecs, because the trade is real and belongs to the caller:
 *
 *   - `f32` — byte-exact. No recall loss. 16 KB/row.
 *   - `f16` — half precision. Measured zero top-10 drift on this library.
 *   - `i8`  — one float32 scale per vector. ~1.5% top-10 drift.
 *
 * `off` means vectors stay local and is the default: a fresh install must not
 * silently upload a hundred megabytes to somebody's bucket.
 *
 * @module dsh-memory/sync/vectors
 */
import { parseEmbKey } from './keys.js'

/** Codecs this build can write. `off` is expressed by the config, not here. */
export const VECTOR_CODECS = ['f32', 'f16', 'i8']

/**
 * Normalize a `sync.vectors` value.
 * @param {unknown} value
 * @returns {'off'|'f32'|'f16'|'i8'}
 */
export function normalizeCodec(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'off' || text === 'none' || text === 'false' || text === '0') return 'off'
  return /** @type {'f32'|'f16'|'i8'} */ (VECTOR_CODECS.includes(text) ? text : 'off')
}

/**
 * IEEE-754 binary32 → binary16, truncating the mantissa (13 bits dropped).
 * @param {number} value
 * @returns {number} 16-bit pattern
 */
function floatToHalf(value) {
  if (Number.isNaN(value)) return 0x7e00
  const scratch = new Float32Array(1)
  scratch[0] = value
  const bits = new Uint32Array(scratch.buffer)[0]
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00
  const target = exponent - 127 + 15
  if (target >= 0x1f) return sign | 0x7c00
  if (target <= 0) {
    if (target < -10) return sign
    const shifted = (mantissa | 0x800000) >>> (1 - target)
    return (sign | (shifted >>> 13)) & 0xffff
  }
  return (sign | (target << 10) | (mantissa >>> 13)) & 0xffff
}

/**
 * IEEE-754 binary16 → binary32.
 * @param {number} half
 * @returns {number}
 */
function halfToFloat(half) {
  const sign = (half & 0x8000) === 0 ? 1 : -1
  const exponent = (half >>> 10) & 0x1f
  const mantissa = half & 0x3ff
  if (exponent === 0) return sign * mantissa * Math.pow(2, -24)
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15)
}

/**
 * @param {Buffer} blob
 * @param {number} dims
 * @returns {Buffer}
 */
function asFloat32(blob, dims) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? [])
  if (buffer.length !== dims * 4) {
    throw Object.assign(new Error(`vector is ${buffer.length} bytes, expected ${dims * 4} for ${dims} dims`), {
      code: 'vector-size',
    })
  }
  return buffer
}

/**
 * Encode one vector for transport.
 *
 * @param {Buffer|Uint8Array} blob - float32 little-endian, `dims * 4` bytes
 * @param {number} dims
 * @param {'f32'|'f16'|'i8'} codec
 * @returns {string} base64
 */
export function encodeVector(blob, dims, codec) {
  const source = asFloat32(/** @type {Buffer} */ (blob), dims)
  if (codec === 'f32') return source.toString('base64')
  if (codec === 'f16') {
    const out = Buffer.alloc(dims * 2)
    for (let i = 0; i < dims; i += 1) out.writeUInt16LE(floatToHalf(source.readFloatLE(i * 4)), i * 2)
    return out.toString('base64')
  }
  // i8: one float32 scale in front of `dims` signed bytes.
  let maxAbs = 0
  for (let i = 0; i < dims; i += 1) maxAbs = Math.max(maxAbs, Math.abs(source.readFloatLE(i * 4)))
  const scale = maxAbs === 0 ? 1 : maxAbs / 127
  const out = Buffer.alloc(4 + dims)
  out.writeFloatLE(scale, 0)
  for (let i = 0; i < dims; i += 1) {
    const value = Math.round(source.readFloatLE(i * 4) / scale)
    out[4 + i] = Math.max(-127, Math.min(127, value)) & 0xff
  }
  return out.toString('base64')
}

/**
 * Decode a transported vector back to the float32 blob the store expects.
 *
 * A corrupt payload throws `vector-size` / `vector-codec` rather than writing
 * garbage into the store: a wrong-width blob would crash every later recall.
 *
 * @param {string} data - base64
 * @param {number} dims
 * @param {'f32'|'f16'|'i8'} codec
 * @returns {Buffer}
 */
export function decodeVector(data, dims, codec) {
  const width = Math.max(0, Math.floor(Number(dims) || 0))
  if (width === 0) throw Object.assign(new Error('vector has no dimensions'), { code: 'vector-size' })
  const raw = Buffer.from(String(data ?? ''), 'base64')
  if (codec === 'f32') return asFloat32(raw, width)
  const out = Buffer.alloc(width * 4)
  if (codec === 'f16') {
    if (raw.length !== width * 2) throw Object.assign(new Error('f16 vector has the wrong width'), { code: 'vector-size' })
    for (let i = 0; i < width; i += 1) out.writeFloatLE(halfToFloat(raw.readUInt16LE(i * 2)), i * 4)
    return out
  }
  if (codec === 'i8') {
    if (raw.length !== width + 4) throw Object.assign(new Error('i8 vector has the wrong width'), { code: 'vector-size' })
    const scale = raw.readFloatLE(0)
    for (let i = 0; i < width; i += 1) {
      const signed = raw[4 + i] > 127 ? raw[4 + i] - 256 : raw[4 + i]
      out.writeFloatLE(signed * scale, i * 4)
    }
    return out
  }
  throw Object.assign(new Error(`unknown vector codec: ${codec}`), { code: 'vector-codec' })
}

/**
 * Rough JSON size of one op, used to cap a part before it is built.
 * @param {number} dims
 * @param {'f32'|'f16'|'i8'} codec
 * @returns {number}
 */
function opBytes(dims, codec) {
  const per = codec === 'f32' ? 4 : codec === 'f16' ? 2 : 1
  return Math.ceil((dims * per + 8) / 3) * 4 + 220
}

/**
 * Build one op from a joined row.
 *
 * @param {Record<string, any>} row
 * @param {'f32'|'f16'|'i8'} codec
 * @param {{ lamport: number, device: string, now: number, op?: 'upsert'|'delete' }} stamp
 * @returns {Record<string, any>|null}
 */
function toOp(row, codec, stamp) {
  const { hash, model } = parseEmbKey(row.key)
  if (hash === '' || model === '') return null
  const dims = Number(row.dims) || 0
  const op = row.op === 'delete' ? 'delete' : 'upsert'
  const base = {
    opId: `emb:${stamp.device}:${stamp.lamport}:${row.key}`,
    tbl: 'memory_embeddings',
    key: String(row.key),
    op,
    lamport: Number(stamp.lamport) || 0,
    device: String(stamp.device ?? ''),
    createdAt: Number(row.createdAt) || stamp.now,
  }
  if (op === 'delete') return { ...base, payload: { hash, model } }
  if (dims <= 0 || row.vec === null || row.vec === undefined) return null
  let vec
  try {
    vec = encodeVector(row.vec, dims, codec)
  } catch {
    return null
  }
  return {
    ...base,
    payload: { hash, model, dims, codec, text_hash: String(row.textHash ?? ''), vec, created_at: Number(row.createdAt) || stamp.now },
  }
}

/**
 * Vectors whose current version has not been uploaded yet, oldest first.
 *
 * A dirty row whose blob is gone (the memory was deleted while queued) turns
 * into a delete op, so a peer does not keep a vector for a fact it dropped.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ codec: 'f32'|'f16'|'i8', limit?: number }} options
 * @returns {{ ops: Array<Record<string, any>>, keys: string[], bytes: number }}
 */
export function collectDirtyEmbOps(db, options) {
  const codec = /** @type {'f32'|'f16'|'i8'} */ (options.codec)
  const limit = Math.max(1, Math.floor(Number(options.limit ?? 60)))
  const rows = db
    .prepare(
      `SELECT d.row_key AS key, d.op AS op, d.lamport AS lamport, d.device AS device, d.text_hash AS textHash,
              e.dims AS dims, e.vec AS vec, e.created_at AS createdAt
         FROM sync_emb_dirty d
         LEFT JOIN memory m ON m.hash = substr(d.row_key, 1, instr(d.row_key, '|') - 1)
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = substr(d.row_key, instr(d.row_key, '|') + 1)
        ORDER BY d.lamport ASC
        LIMIT ?`,
    )
    .all(limit)
  const ops = []
  const keys = []
  let bytes = 0
  for (const row of rows) {
    const op = toOp(row, codec, {
      lamport: Number(row.lamport) || 0,
      device: String(row.device ?? ''),
      now: Date.now(),
      op: row.vec === null || row.vec === undefined ? 'delete' : undefined,
    })
    keys.push(String(row.key))
    if (op !== null) {
      ops.push(op)
      bytes += opBytes(Number(row.dims) || 0, codec)
    }
  }
  return { ops, keys, bytes }
}

/**
 * One page of the full vector set, for snapshot parts. Paged on purpose: the
 * whole library is ~95 MB of blobs, and holding every base64 copy at once would
 * triple that for no reason.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ codec: 'f32'|'f16'|'i8', offset?: number, limit?: number, lamport?: number, device?: string, now?: number }} options
 * @returns {Array<Record<string, any>>}
 */
export function readEmbPage(db, options) {
  const codec = /** @type {'f32'|'f16'|'i8'} */ (options.codec)
  const limit = Math.max(1, Math.floor(Number(options.limit ?? 40)))
  const afterHash = options.afterHash === undefined || options.afterHash === null ? '' : String(options.afterHash)
  // Two statements, and the split is the whole point.
  //
  // A single `SELECT … JOIN … ORDER BY m.hash, e.model LIMIT ?` cannot use an
  // index for the ordering (hash lives in `memory`, model in the primary key of
  // `memory_embeddings`), so SQLite materialises **every row including its
  // 16 KB blob** into a temp b-tree and discards all but one page: measured
  // 1.8 s per page, 265 s for the library, and it got slower the larger the
  // library was.
  //
  // Step one walks `memory.hash` (unique index, covers the EXISTS probe) and
  // returns only the page's hashes. Step two fetches exactly those blobs. Same
  // bytes, 265 s → under 3 s.
  const hashes = db
    .prepare(
      `SELECT m.hash AS hash
         FROM memory m
        WHERE m.hash > ?
          AND EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id)
        ORDER BY m.hash
        LIMIT ?`,
    )
    .all(afterHash, limit)
    .map((row) => String(row.hash))
  if (hashes.length === 0) return []
  const marks = hashes.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT m.hash || '|' || e.model AS key, 'upsert' AS op, e.dims AS dims, e.text_hash AS textHash,
              e.vec AS vec, e.created_at AS createdAt
         FROM memory_embeddings e JOIN memory m ON m.id = e.memory_id
        WHERE m.hash IN (${marks})
        ORDER BY m.hash, e.model`,
    )
    .all(...hashes)
  const stamp = {
    lamport: Number(options.lamport ?? 0) || 0,
    device: String(options.device ?? ''),
    now: Number(options.now ?? Date.now()),
  }
  const ops = []
  for (const row of rows) {
    const op = toOp(row, codec, stamp)
    // A snapshot must fail loudly rather than skip: a silently dropped page
    // would leave the cursor un-advanced (infinite loop) or the library short a
    // vector the cloud claims to hold.
    if (op === null) {
      throw Object.assign(new Error(`vector row is unusable: ${String(row.key ?? '')}`), { code: 'vector-corrupt' })
    }
    ops.push(op)
  }
  return ops
}

/**
 * Forget dirty marks that were uploaded. Their `sync_rowstate` entry stays:
 * it is the LWW stamp a later remote op is compared against.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} keys
 * @returns {number} rows removed
 */
export function markEmbUploaded(db, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return 0
  const statement = db.prepare('DELETE FROM sync_emb_dirty WHERE row_key = ?')
  let removed = 0
  for (const key of keys) removed += Number(statement.run(String(key))?.changes ?? 0)
  return removed
}

/**
 * Vector counters for the panel: what is stored, what still owes an upload.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ rows: number, pending: number, models: string[], dims: number, bytes: number }}
 */
export function embStats(db) {
  const one = (sql) => {
    try {
      return db.prepare(sql).get() ?? {}
    } catch {
      return {}
    }
  }
  const rows = Number(one('SELECT COUNT(*) AS n FROM memory_embeddings').n ?? 0)
  const pending = Number(one('SELECT COUNT(*) AS n FROM sync_emb_dirty').n ?? 0)
  const blobs = one('SELECT SUM(LENGTH(vec)) AS bytes, MAX(dims) AS dims FROM memory_embeddings')
  const models = (() => {
    try {
      return db.prepare('SELECT DISTINCT model FROM memory_embeddings ORDER BY model').all().map((row) => String(row.model))
    } catch {
      return []
    }
  })()
  return { rows, pending, models, dims: Number(blobs.dims ?? 0) || 0, bytes: Number(blobs.bytes ?? 0) || 0 }
}

/**
 * Every vector key this database holds, in the shape `verify()` compares.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
export function localEmbKeys(db) {
  try {
    return db
      .prepare('SELECT m.hash || \'|\' || e.model AS key FROM memory_embeddings e JOIN memory m ON m.id = e.memory_id')
      .all()
      .map((row) => String(row.key))
  } catch {
    return []
  }
}
