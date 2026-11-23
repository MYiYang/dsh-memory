/**
 * Reading and trimming the local oplog.
 *
 * The oplog is append-only and written by triggers (see `schema.js`). This
 * module is the only reader: it hands the engine the ops that have not been
 * packed into a segment yet, reports how far behind the pusher is, and trims
 * what has already been flushed.
 *
 * @module dsh-memory/sync/oplog
 */
import { getSyncMeta, setSyncMeta } from './schema.js'

/** Default cap for one segment. */
export const DEFAULT_MAX_OPS = 2_000

/**
 * Ops with `seq > watermark`, oldest first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ limit?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function unflushedOps(db, options = {}) {
  const watermark = Number(getSyncMeta(db, 'watermark', '0')) || 0
  const limit = Math.max(1, Math.min(10_000, Number(options.limit ?? DEFAULT_MAX_OPS)))
  return db
    .prepare(
      `SELECT seq, op_id AS opId, device, lamport, tbl, row_key AS rowKey, op, payload, created_at AS createdAt
         FROM sync_oplog WHERE seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(watermark, limit)
}

/**
 * How much is waiting to be pushed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ ops: number, bytes: number, oldestAt: number|null, watermark: number }}
 */
export function backlog(db) {
  const watermark = Number(getSyncMeta(db, 'watermark', '0')) || 0
  const row = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes, MIN(created_at) AS oldest FROM sync_oplog WHERE seq > ?')
    .get(watermark)
  return {
    ops: Number(row?.n ?? 0),
    bytes: Number(row?.bytes ?? 0),
    oldestAt: row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest),
    watermark,
  }
}

/**
 * Record that every op up to `seq` is durably stored remotely.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} seq
 */
export function advanceWatermark(db, seq) {
  const current = Number(getSyncMeta(db, 'watermark', '0')) || 0
  if (Number(seq) > current) setSyncMeta(db, 'watermark', Math.floor(Number(seq)))
}

/**
 * Delete flushed ops older than `keepDays`.
 *
 * Only rows at or below the watermark are removed: an unflushed op is the only
 * copy of that change until it reaches the cloud.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ keepDays?: number, now?: number }} [options]
 * @returns {number} rows deleted
 */
export function pruneOplog(db, options = {}) {
  const keepDays = Math.max(1, Number(options.keepDays ?? 30))
  const cutoff = Number(options.now ?? Date.now()) - keepDays * 86_400_000
  const watermark = Number(getSyncMeta(db, 'watermark', '0')) || 0
  const result = db
    .prepare('DELETE FROM sync_oplog WHERE seq <= ? AND created_at < ?')
    .run(watermark, cutoff)
  return Number(result.changes ?? 0)
}

/**
 * True when the backlog exceeded the configured cap and the incremental chain
 * can no longer be trusted; the caller must publish a fresh snapshot instead.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ maxOps?: number, maxBytes?: number }} [options]
 * @returns {boolean}
 */
export function needsSnapshot(db, options = {}) {
  const limits = { maxOps: 50_000, maxBytes: 200 * 1024 * 1024, ...options }
  if (getSyncMeta(db, 'gap', '') !== '') return true
  const { ops, bytes } = backlog(db)
  return ops > Number(limits.maxOps) || bytes > Number(limits.maxBytes)
}
