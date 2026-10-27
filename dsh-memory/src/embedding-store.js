/**
 * Storage for vectors produced by a *configured* model (ANALYSIS-vector-model.md
 * §4.4).
 *
 * Why a separate table instead of `memory.vec`:
 *   - `memory.vec` holds the built-in lexical vector and is compared against a
 *     single constant model tag; mixing a 1536-dim semantic vector into the same
 *     column would either break every stored row or require a full rewrite on
 *     each model change.
 *   - Here a row is keyed by `(memory_id, model)` where `model` is the vector
 *     tag (`openai:text-embedding-3-small@1536`). Switching models therefore only
 *     changes which rows are *read*; nothing has to be migrated.
 *   - Writes are asynchronous on purpose: the memory write path stays
 *     synchronous (see §4.5), so a slow or broken endpoint can never block or
 *     fail "save this fact".
 *
 * Like `memory_features`, this module only writes its own table: the FTS sync
 * triggers on `memory` must not fire (indexing is not an edit, and it must not
 * bump `updated_at`).
 *
 * @module dsh-memory/embedding-store
 */
import { packVector, unpackVector } from './vector.js'
import { visibilityClause } from './feature-index.js'

/** Table name; also used by the schema guard. */
export const EMBEDDING_TABLE = 'memory_embeddings'

/**
 * Create the v5 table, its index and the delete trigger. Idempotent, additive:
 * opening an older database only gains an empty table.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureEmbeddingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id  INTEGER NOT NULL,
      model      TEXT NOT NULL,
      dims       INTEGER NOT NULL,
      text_hash  TEXT NOT NULL,
      vec        BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (memory_id, model)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model);

    -- forgetMemories / the data browser delete from memory; the embedding rows
    -- must not outlive the memory they describe.
    CREATE TRIGGER IF NOT EXISTS memory_embeddings_ad AFTER DELETE ON memory BEGIN
      DELETE FROM memory_embeddings WHERE memory_id = old.id;
    END;
  `)
}

/**
 * Whether the table exists. Every read path checks this so a database opened by
 * an older build (or a partially migrated file) degrades instead of throwing.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function hasEmbeddingTable(db) {
  try {
    return db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(EMBEDDING_TABLE) !== undefined
  } catch {
    return false
  }
}

/**
 * Insert or replace one row's vector.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   memoryId: number, model: string, dims: number, textHash: string,
 *   vector: Float32Array, now?: number,
 * }} input
 * @returns {boolean} whether a row was written
 */
export function putEmbedding(db, input) {
  const memoryId = Number(input.memoryId)
  const model = String(input.model ?? '')
  const dims = Math.floor(Number(input.dims))
  const vector = input.vector
  if (!Number.isInteger(memoryId) || memoryId <= 0) return false
  if (model === '' || !Number.isFinite(dims) || dims <= 0) return false
  if (!(vector instanceof Float32Array) || vector.length !== dims) return false
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings(memory_id, model, dims, text_hash, vec, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(memoryId, model, dims, String(input.textHash ?? ''), packVector(vector), Number(input.now ?? Date.now()))
  return true
}

/**
 * Drop every vector of one tag (used when the configured model changes).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} model
 * @returns {number} deleted rows
 */
export function deleteModelEmbeddings(db, model) {
  const result = db.prepare('DELETE FROM memory_embeddings WHERE model = ?').run(String(model ?? ''))
  return Number(result.changes ?? 0)
}

/**
 * Keep only the active tag, so a 6 KB-per-row table cannot accumulate one copy
 * per model the user ever tried.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} model
 * @returns {number} deleted rows
 */
export function deleteOtherModels(db, model) {
  const result = db.prepare('DELETE FROM memory_embeddings WHERE model <> ?').run(String(model ?? ''))
  return Number(result.changes ?? 0)
}

/**
 * Rows that still need a vector for `model`: never embedded, or embedded from an
 * older version of the text (`memory.hash` is the content hash, so an edit makes
 * the stored vector stale).
 *
 * Newest first: a fresh memory is the one most likely to be recalled next, and
 * it keeps the visible "already embedded" number meaningful while a big corpus
 * backfills in the background.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} model
 * @param {number} [limit]
 * @returns {Array<{ id: number, text: string, hash: string }>}
 */
export function pendingEmbeddingRows(db, model, limit = 256) {
  const capped = Math.max(1, Math.min(10_000, Math.floor(Number(limit) || 256)))
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.text AS text, m.hash AS hash
         FROM memory m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
        WHERE m.superseded_by IS NULL
          AND (e.memory_id IS NULL OR e.text_hash <> m.hash)
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(String(model ?? ''), capped)
  return rows.map((row) => ({ id: Number(row.id), text: String(row.text ?? ''), hash: String(row.hash ?? '') }))
}

/**
 * Vectors of the requested ids under one tag, as a Map for O(1) scoring.
 * Ids are chunked: SQLite builds may cap the number of bound variables.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ model: string, dims: number, ids: number[] }} input
 * @returns {Map<number, Float32Array>}
 */
export function loadEmbeddings(db, input) {
  /** @type {Map<number, Float32Array>} */
  const found = new Map()
  const ids = Array.isArray(input.ids) ? input.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0) : []
  const dims = Math.floor(Number(input.dims))
  if (ids.length === 0 || !Number.isFinite(dims) || dims <= 0) return found
  const chunkSize = 400
  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT memory_id, vec FROM memory_embeddings
          WHERE model = ? AND dims = ? AND memory_id IN (${placeholders})`,
      )
      .all(String(input.model ?? ''), dims, ...chunk)
    for (const row of rows) {
      const vector = unpackVector(row.vec, dims)
      if (vector !== null) found.set(Number(row.memory_id), vector)
    }
  }
  return found
}

/**
 * The bounded semantic scan: ids (and vectors) of the newest visible rows that
 * carry a vector for `model`.
 *
 * Unlike the lexical branch there is no inverted pre-filter here — semantic
 * similarity has nothing to do with shared character n-grams, so nominating by
 * features would miss exactly the rows a real embedding model is bought for.
 * The bound is therefore recency (`updated_at DESC`), the same trade-off the
 * lexical fallback scan already makes (README: rows older than `scanLimit` are
 * not nominated).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   model: string, dims: number, limit?: number,
 *   scope?: 'project'|'global'|'all', project?: string|null, kinds?: string[],
 * }} input
 * @returns {Array<{ id: number, vector: Float32Array }>}
 */
export function semanticCandidates(db, input) {
  const dims = Math.floor(Number(input.dims))
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(input.limit) || 2000)))
  if (!Number.isFinite(dims) || dims <= 0) return []
  const scope = input.scope === 'global' || input.scope === 'all' ? input.scope : 'project'
  const { clause, params } = visibilityClause(scope, input.project ?? null, input.kinds)
  // Driving from `memory` (newest first, indexed) and probing the embedding PK
  // per row stops as soon as LIMIT is reached; the reverse plan would read the
  // whole model index and sort it.
  const rows = db
    .prepare(
      `SELECT e.memory_id AS id, e.vec AS vec
         FROM memory m
         JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ? AND e.dims = ?
        WHERE m.superseded_by IS NULL${clause}
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(String(input.model ?? ''), dims, ...params, limit)
  /** @type {Array<{ id: number, vector: Float32Array }>} */
  const out = []
  for (const row of rows) {
    const vector = unpackVector(row.vec, dims)
    if (vector !== null) out.push({ id: Number(row.id), vector })
  }
  return out
}

/**
 * Counters for the settings page: how much of the corpus the active model has
 * covered.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} model
 * @returns {{ total: number, embedded: number, pending: number, stale: number }}
 */
export function embeddingCounts(db, model) {
  const tag = String(model ?? '')
  const count = (sql, ...params) => {
    try {
      return Number(db.prepare(sql).get(...params)?.n ?? 0)
    } catch {
      return 0
    }
  }
  const total = count('SELECT COUNT(*) AS n FROM memory WHERE superseded_by IS NULL')
  const embedded = count('SELECT COUNT(*) AS n FROM memory_embeddings WHERE model = ?', tag)
  const pending = count(
    `SELECT COUNT(*) AS n
       FROM memory m
       LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
      WHERE m.superseded_by IS NULL AND (e.memory_id IS NULL OR e.text_hash <> m.hash)`,
    tag,
  )
  return { total, embedded, pending, stale: Math.max(0, embedded - (total - pending)) }
}
