/**
 * Segment encoding: one immutable object per push.
 *
 * Layout (all integers big-endian):
 *
 *   magic  4   "DSHS"
 *   fmt    1   format version (currently 1)
 *   hdrLen 4   byte length of the JSON header
 *   header hdrLen  { epoch, device, seq, count, codec, enc, iv?, tag?, createdAt }
 *   body   …   brotli(JSONL) — or ciphertext when `enc` is set
 *
 * The header sits *outside* the encrypted body on purpose: the receiver must be
 * able to read `epoch/device/seq` (and the IV) before it has a key.
 *
 * @module dsh-memory/sync/segment
 */
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'

/** Bytes at the start of every segment. */
export const SEGMENT_MAGIC = Buffer.from('DSHS', 'ascii')
/** Format version written by this build. */
export const SEGMENT_FMT = 1
/** Current `fmt` values this build can read. */
const READABLE_FMT = new Set([1])

/**
 * Object key for one segment.
 * @param {{ prefix?: string, workspace: string, device: string, seq: number, ext?: string }} input
 * @returns {string}
 */
export function segmentObjectKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  const seq = String(Math.max(0, Math.floor(Number(input.seq) || 0))).padStart(8, '0')
  return `${prefix}/${input.workspace}/${input.device}/${seq}.jsonl.${input.ext ?? 'br'}`
}

/**
 * Object key for a snapshot.
 *
 * Legacy single-object layout. Still exported because old buckets may hold
 * such objects; `bootstrap` deliberately ignores them (their lamports were
 * fabricated by row index and would shadow every later edit — see
 * DESIGN-sync-integrity.md E1).
 *
 * @param {{ prefix?: string, workspace: string, stamp: number, device?: string }} input
 * @returns {string}
 */
export function snapshotObjectKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  const suffix = input.device === undefined ? '' : `-${String(input.device).slice(0, 8)}`
  return `${prefix}/${input.workspace}/snapshot/${Math.floor(input.stamp)}${suffix}.jsonl.br`
}

/** Manifest format written by this build. */
export const SNAPSHOT_MANIFEST_FMT = 1

/**
 * `-<device>` suffix shared by a snapshot's manifest and its parts. One
 * snapshot is one directory, so parts can never be mixed across snapshots.
 *
 * @param {unknown} device
 * @returns {string}
 */
function deviceSuffix(device) {
  return device === undefined || device === null || device === ''
    ? ''
    : `-${String(device).slice(0, 8)}`
}

/**
 * Object key for the manifest — the commit marker of a snapshot.
 * @param {{ prefix?: string, workspace: string, stamp: number, device?: string }} input
 * @returns {string}
 */
export function snapshotManifestKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  return `${prefix}/${input.workspace}/snapshot/${Math.floor(input.stamp)}${deviceSuffix(input.device)}.manifest.json`
}

/**
 * Object key for one part of a snapshot.
 * @param {{ prefix?: string, workspace: string, stamp: number, device?: string, index: number }} input
 * @returns {string}
 */
export function snapshotPartKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  const index = String(Math.max(0, Math.floor(Number(input.index) || 0))).padStart(3, '0')
  return `${prefix}/${input.workspace}/snapshot/${Math.floor(input.stamp)}${deviceSuffix(input.device)}/part-${index}.jsonl.br`
}

/**
 * Object key for one incremental vector segment.
 *
 * Vectors live in their own subtree so a peer can pull them without scanning
 * the truth stream, and so a `sync.vectors=off` device simply never lists it.
 *
 * @param {{ prefix?: string, workspace: string, device: string, seq: number }} input
 * @returns {string}
 */
export function embObjectKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  const seq = String(Math.max(0, Math.floor(Number(input.seq) || 0))).padStart(8, '0')
  return `${prefix}/${input.workspace}/emb/${input.device}/${seq}.jsonl.br`
}

/**
 * Parse `.../emb/{device}/{seq}.jsonl.br`.
 * @param {string} key
 * @returns {{ device: string, seq: number } | null}
 */
export function parseEmbObjectKey(key) {
  const match = /\/emb\/([^/]+)\/(\d{8})\.jsonl\.[a-z]+$/.exec(String(key))
  return match === null ? null : { device: match[1], seq: Number(match[2]) }
}

/**
 * Object key for one vector part of a snapshot.
 * @param {{ prefix?: string, workspace: string, stamp: number, device?: string, index: number }} input
 * @returns {string}
 */
export function embPartKey(input) {
  const prefix = String(input.prefix ?? 'v1').replace(/^\/+|\/+$/g, '')
  const index = String(Math.max(0, Math.floor(Number(input.index) || 0))).padStart(3, '0')
  return `${prefix}/${input.workspace}/snapshot/${Math.floor(input.stamp)}${deviceSuffix(input.device)}/emb-${index}.jsonl.br`
}

/**
 * Serialise a manifest.
 * @param {Record<string, any>} manifest
 * @returns {Buffer}
 */
export function encodeManifest(manifest) {
  return Buffer.from(JSON.stringify({ fmt: SNAPSHOT_MANIFEST_FMT, ...manifest }), 'utf8')
}

/**
 * Parse and shape-check a manifest.
 * @param {Buffer|string} input
 * @returns {Record<string, any>}
 * @throws {Error & { code: string }} `corrupt` | `unsupported-fmt`
 */
export function decodeManifest(input) {
  let parsed
  try {
    parsed = JSON.parse(Buffer.isBuffer(input) ? input.toString('utf8') : String(input))
  } catch {
    throw coded('corrupt', 'manifest is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw coded('corrupt', 'manifest must be an object')
  const fmt = Number(parsed.fmt ?? 0)
  if (!Number.isFinite(fmt) || fmt <= 0) throw coded('corrupt', 'manifest.fmt is missing')
  if (fmt > SNAPSHOT_MANIFEST_FMT) throw coded('unsupported-fmt', `snapshot manifest format ${fmt} is newer than this build`)
  if (!Array.isArray(parsed.parts)) throw coded('corrupt', 'manifest.parts must be an array')
  for (const part of parsed.parts) {
    if (part === null || typeof part !== 'object') throw coded('corrupt', 'manifest part must be an object')
    if (typeof part.key !== 'string' || part.key === '') throw coded('corrupt', 'manifest part is missing its key')
    if (typeof part.sha256 !== 'string' || part.sha256.length !== 64) throw coded('corrupt', 'manifest part is missing its sha256')
  }
  // Vector parts are optional (a snapshot published by `sync.vectors=off` has
  // none), but a present list must obey the same shape rules as truth parts.
  if (parsed.embParts !== undefined) {
    if (!Array.isArray(parsed.embParts)) throw coded('corrupt', 'manifest.embParts must be an array')
    for (const part of parsed.embParts) {
      if (part === null || typeof part !== 'object') throw coded('corrupt', 'manifest embPart must be an object')
      if (typeof part.key !== 'string' || part.key === '') throw coded('corrupt', 'manifest embPart is missing its key')
      if (typeof part.sha256 !== 'string' || part.sha256.length !== 64) {
        throw coded('corrupt', 'manifest embPart is missing its sha256')
      }
    }
  }
  return parsed
}

/**
 * Pack ops into a segment buffer.
 *
 * @param {{ epoch?: number, device: string, seq: number, ops: Array<Record<string, any>>, crypto?: { encrypt?: (buf: Buffer) => { enc: string, iv?: string, tag?: string, body: Buffer } }, now?: number }} input
 * @returns {Buffer}
 */
export function encodeSegment(input) {
  const ops = Array.isArray(input.ops) ? input.ops : []
  const lines = ops.map((op) =>
    JSON.stringify({
      opId: String(op.opId ?? op.op_id ?? ''),
      tbl: String(op.tbl ?? ''),
      key: String(op.key ?? op.rowKey ?? op.row_key ?? ''),
      op: String(op.op ?? 'upsert'),
      lamport: Number(op.lamport ?? 0),
      device: String(op.device ?? input.device),
      payload: typeof op.payload === 'string' ? safeParse(op.payload) : (op.payload ?? null),
      createdAt: Number(op.createdAt ?? op.created_at ?? Date.now()),
    }),
  )
  const raw = brotliCompressSync(Buffer.from(lines.join('\n'), 'utf8'), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
  })

  let body = raw
  let enc = 'none'
  let iv
  let tag
  if (input.crypto && typeof input.crypto.encrypt === 'function') {
    const sealed = input.crypto.encrypt(raw)
    body = sealed.body
    enc = sealed.enc
    iv = sealed.iv
    tag = sealed.tag
  }

  const header = {
    epoch: Number(input.epoch ?? 1),
    device: String(input.device),
    seq: Number(input.seq ?? 0),
    count: ops.length,
    codec: 'br',
    enc,
    ...(iv === undefined ? {} : { iv }),
    ...(tag === undefined ? {} : { tag }),
    createdAt: Number(input.now ?? Date.now()),
  }
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(9)
  SEGMENT_MAGIC.copy(prefix, 0)
  prefix.writeUInt8(SEGMENT_FMT, 4)
  prefix.writeUInt32BE(headerBuf.length, 5)
  return Buffer.concat([prefix, headerBuf, body])
}

/**
 * Unpack a segment.
 *
 * @param {Buffer} buf
 * @param {{ crypto?: { decrypt?: (header: Record<string, any>, body: Buffer) => Buffer } }} [options]
 * @returns {{ header: Record<string, any>, ops: Array<Record<string, any>> }}
 * @throws {Error & { code: string }} `unsupported-fmt` | `corrupt` | `decrypt-failed`
 */
export function decodeSegment(buf, options = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 13) throw coded('corrupt', 'segment is too short')
  if (!buf.subarray(0, 4).equals(SEGMENT_MAGIC)) throw coded('corrupt', 'bad magic')
  const fmt = buf.readUInt8(4)
  if (!READABLE_FMT.has(fmt)) throw coded('unsupported-fmt', `segment format ${fmt} is newer than this build`)
  const headerLen = buf.readUInt32BE(5)
  if (headerLen <= 0 || 9 + headerLen > buf.length) throw coded('corrupt', 'header length out of range')
  const header = JSON.parse(buf.subarray(9, 9 + headerLen).toString('utf8'))
  let body = buf.subarray(9 + headerLen)
  if (header.enc && header.enc !== 'none') {
    if (!options.crypto || typeof options.crypto.decrypt !== 'function') {
      throw coded('decrypt-failed', 'segment is encrypted and no key was supplied')
    }
    body = options.crypto.decrypt(header, body)
  }
  let text
  try {
    text = brotliDecompressSync(body).toString('utf8')
  } catch {
    throw coded('corrupt', 'body is not valid brotli')
  }
  const ops = text === '' ? [] : text.split('\n').map((line) => JSON.parse(line))
  return { header, ops }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * @param {string} text
 * @returns {any}
 */
function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
