/**
 * Inverted lexical feature index, used to pre-filter candidates for the vector
 * branch of recall.
 *
 * Why this exists: the "vector" in vector.js is a *lexical* feature-hash
 * embedding (character 2/3/4-grams plus latin word tokens). Comparing it against
 * every row is a full table scan; the old query had no ORDER BY either, so it
 * scored the *oldest* `scanLimit` rows and a new memory could never win a vector
 * slot. An ANN/LSH index would make the score approximate, which is pointless
 * here: the stored features are already lexical, so we can keep the *unhashed*
 * features in an inverted table, use the rarest features a query shares with the
 * corpus to nominate a small candidate set, and rescore those candidates with the
 * exact cosine. Hash collisions only change which rows are nominated, never the
 * final score, so every nominated row keeps an exact similarity.
 *
 * Model: the number of stored features per memory is part of
 * `FEATURE_INDEX_MODEL`. When it changes the stored rows are meaningless, so the
 * model is recorded in the `feature-index-model` meta key and the whole table is
 * cleared + re-indexed on the next backfill.
 *
 * Everything here writes only to `memory_features`, never to `memory`, so the FTS
 * sync triggers do not fire (indexing a row must not look like an edit, and it
 * must not bump `updated_at`).
 *
 * @module dsh-memory/feature-index
 */
import { extractFeatures, fnv1a } from './vector.js'

/** Stored feature count per memory; part of FEATURE_INDEX_MODEL. */
export const DEFAULT_FEATURE_LIMIT = 96

/** Stored alongside every feature row so a model change is detected. */
export const FEATURE_INDEX_MODEL = `feat-hash-v1-${DEFAULT_FEATURE_LIMIT}`

/** meta key holding {@link FEATURE_INDEX_MODEL}. */
export const FEATURE_INDEX_MODEL_KEY = 'feature-index-model'

/**
 * Marker feature for "this memory has no indexable feature" (e.g. text `A`).
 * Without it a memory would look un-indexed forever and every open would retry
 * it. Never used as a candidate (queries exclude feature 0).
 */
export const EMPTY_FEATURE = 0

/**
 * Upper bound on how many query features we probe for document frequency. Each
 * probe is one index range scan, so this bounds the per-recall work.
 */
export const MAX_PROBE_FEATURES = 48

/**
 * A feature that appears in more visible rows than this is treated as "too common
 * to discriminate": probing stops there (cost bound) and the feature is not used
 * for the candidate query (so that query stays small too). On a large memory
 * store, grams like 项目/部署 are in thousands of rows; using them nominates the
 * whole corpus, which the FTS/LIKE passes already cover.
 */
export const MAX_DOCUMENT_FREQUENCY = 256

/**
 * @typedef {object} WeightedFeature
 * @property {string} feature - unhashed feature, e.g. `c:部署` or `w:pnpm`
 * @property {number} weight  - sublinear term frequency, 1 + ln(count)
 */

/**
 * Weighted features of `text`, strongest first.
 *
 * Ordering is deterministic (weight desc, then feature string asc) so the stored
 * set does not depend on the layout of the text or on Map insertion order.
 *
 * @param {string} text
 * @param {number} [limit] at most this many features (capped at DEFAULT_FEATURE_LIMIT)
 * @returns {WeightedFeature[]}
 */
export function topFeatures(text, limit = DEFAULT_FEATURE_LIMIT) {
  const requested = Number(limit)
  const capped =
    Number.isFinite(requested) && requested > 0 ? Math.min(DEFAULT_FEATURE_LIMIT, Math.floor(requested)) : DEFAULT_FEATURE_LIMIT
  /** @type {WeightedFeature[]} */
  const weighted = []
  for (const [feature, count] of extractFeatures(text)) weighted.push({ feature, weight: 1 + Math.log(count) })
  weighted.sort((a, b) => b.weight - a.weight || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0))
  return weighted.slice(0, capped)
}

/**
 * Hash the feature list and keep the strongest weight per hash.
 *
 * A 32-bit hash can collide (rare); merging the two features on one row keeps
 * `SUM(weight)` in the same range as a single feature, so a collision cannot
 * promote a row on weight alone.
 *
 * @param {WeightedFeature[]} features
 * @returns {Map<number, number>} feature hash → weight
 */
function hashFeatures(features) {
  /** @type {Map<number, number>} */
  const hashed = new Map()
  for (const { feature, weight } of features) {
    const hash = fnv1a(feature)
    // 0 marks the "no indexable feature" sentinel; a feature that hashes to it is
    // dropped instead of being mistaken for one.
    if (hash === EMPTY_FEATURE) continue
    const previous = hashed.get(hash)
    if (previous === undefined || weight > previous) hashed.set(hash, weight)
  }
  return hashed
}

/**
 * Run `work` inside a transaction unless the caller already holds one.
 *
 * `BEGIN`, not `SAVEPOINT`: a savepoint makes SQLite journal the pre-image of
 * every touched page for rollback (measured ~1ms per memory here, vs ~0.2ms),
 * while without any transaction each of the ~48 feature INSERTs commits on its
 * own (~4ms per memory). One BEGIN/COMMIT per memory is the cheap middle ground;
 * the guard keeps this composable with the bulk backfill, which owns a bigger
 * transaction.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
function inTransaction(db, work) {
  let ownTransaction = false
  try {
    db.exec('BEGIN')
    ownTransaction = true
  } catch {
    /* already inside a caller's transaction */
  }
  try {
    const result = work()
    if (ownTransaction) db.exec('COMMIT')
    return result
  } catch (error) {
    if (ownTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure */
      }
    }
    throw error
  }
}

/**
 * Replace the stored feature set of one memory.
 *
 * If a write fails halfway, the row's partial set is dropped so it does not look
 * "already indexed" to the next backfill.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} memoryId
 * @param {WeightedFeature[]} features
 * @returns {number} feature rows written
 */
function replaceFeatures(db, memoryId, features) {
  const hashed = hashFeatures(features)
  const insert = db.prepare('INSERT OR REPLACE INTO memory_features(memory_id, feature, weight) VALUES (?, ?, ?)')
  const remove = db.prepare('DELETE FROM memory_features WHERE memory_id = ?')
  try {
    return inTransaction(db, () => {
      remove.run(memoryId)
      if (hashed.size === 0) {
        insert.run(memoryId, EMPTY_FEATURE, 0)
        return 1
      }
      for (const [hash, weight] of hashed) insert.run(memoryId, hash, weight)
      return hashed.size
    })
  } catch (error) {
    try {
      remove.run(memoryId)
    } catch {
      /* the connection may be unusable; the caller still sees the real failure */
    }
    throw error
  }
}

/**
 * Index (or re-index) one memory's features.
 *
 * Safe to call for a row that is already indexed: the old feature rows are
 * replaced. An empty feature set stores the {@link EMPTY_FEATURE} sentinel so the
 * backfill does not retry the row on every open.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id - memory row id
 * @param {string} text
 * @param {{ limit?: number }} [options]
 * @returns {number} number of feature rows written (1 for the sentinel)
 */
export function indexMemoryFeatures(db, id, text, options = {}) {
  const memoryId = Number(id)
  if (!Number.isInteger(memoryId) || memoryId <= 0) return 0
  const features = topFeatures(text, options.limit ?? DEFAULT_FEATURE_LIMIT)
  return replaceFeatures(db, memoryId, features)
}

/**
 * Record the current feature model, clearing the index when it changed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean} true when the stored rows were discarded
 */
export function ensureFeatureIndexModel(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(FEATURE_INDEX_MODEL_KEY)
  const stored = row === undefined ? undefined : String(row.value)
  if (stored === FEATURE_INDEX_MODEL) return false
  // A different feature count (or a pre-v4 database): every stored row is stale.
  db.prepare('DELETE FROM memory_features').run()
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(FEATURE_INDEX_MODEL_KEY, FEATURE_INDEX_MODEL)
  return true
}

/**
 * Index rows that have no feature rows yet (fresh v4 database, rows written by
 * an import path that bypasses saveMemory/insertFact, or a model change that
 * cleared the table).
 *
 * Bounded so opening a large database stays fast: the next open finishes the
 * remainder.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ limit?: number }} [options]
 * @returns {number} rows processed
 */
export function backfillFeatureIndex(db, options = {}) {
  const requested = Number(options.limit)
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(10_000, Math.floor(requested)) : 500
  // Before selecting: a model change clears the table, which makes every row
  // "missing" again.
  ensureFeatureIndexModel(db)
  const rows = db
    .prepare(
      `SELECT id, text FROM memory
        WHERE NOT EXISTS (SELECT 1 FROM memory_features f WHERE f.memory_id = memory.id)
        LIMIT ?`,
    )
    .all(limit)
  if (rows.length === 0) return 0
  // One transaction for the whole batch: the per-row write then reuses it instead
  // of committing once per memory.
  inTransaction(db, () => {
    for (const row of rows) indexMemoryFeatures(db, Number(row.id), String(row.text ?? ''))
  })
  return rows.length
}

/**
 * Build the visibility filter shared by the df probe and the candidate query.
 *
 * Also exported for the semantic scan (embedding-store.js): both branches must
 * agree on what "visible" means, or the hybrid score would mix rows one of the
 * two halves could never have returned.
 *
 * Mirrors store.searchFts: a `project` scope without a project key sees global
 * rows only (a session without a cwd must not read other projects' rows), and
 * `all` adds no restriction.
 *
 * @param {'project'|'global'|'all'} scope
 * @param {string|null} project
 * @param {string[]|undefined} kinds
 * @returns {{ clause: string, params: Array<string|null> }}
 */
export function visibilityClause(scope, project, kinds) {
  /** @type {string[]} */
  const clauses = []
  /** @type {Array<string|null>} */
  const params = []
  if (kinds) {
    clauses.push(`m.kind IN (${kinds.map(() => '?').join(',')})`)
    params.push(...kinds)
  }
  if (scope === 'global') {
    clauses.push("m.scope = 'global'")
  } else if (scope === 'project') {
    if (project) {
      clauses.push("(m.scope = 'global' OR (m.scope = 'project' AND m.project = ?))")
      params.push(project)
    } else {
      clauses.push("m.scope = 'global'")
    }
  }
  const clause = clauses.length === 0 ? '' : ' AND ' + clauses.join(' AND ')
  return { clause, params }
}

/**
 * Memory ids that share rare lexical features with `text`, best first.
 *
 * Returns only ids: the caller rescopes them (`getByIds`) and scores them with
 * the exact cosine, because the index is a nomination heuristic, not a score.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text - query text
 * @param {{
 *   limit?: number,          // candidates to return (default 64)
 *   maxFeatures?: number,    // rare features to query with (default 12)
 *   scope?: 'project'|'global'|'all',
 *   project?: string|null,
 *   kinds?: string[],
 *   featureLimit?: number,   // query-side feature cap (default DEFAULT_FEATURE_LIMIT)
 * }} [options]
 * @returns {number[]}
 */
export function candidateMemoryIds(db, text, options = {}) {
  const requestedLimit = Number(options.limit)
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(1000, Math.floor(requestedLimit)) : 64
  const requestedFeatures = Number(options.maxFeatures)
  const maxFeatures =
    Number.isFinite(requestedFeatures) && requestedFeatures > 0
      ? Math.min(MAX_PROBE_FEATURES, Math.floor(requestedFeatures))
      : 12
  const scope = options.scope === 'global' || options.scope === 'all' ? options.scope : 'project'
  const project = options.project ?? null
  const kinds = Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : undefined
  const requestedFeatureLimit = Number(options.featureLimit)
  const featureLimit =
    Number.isFinite(requestedFeatureLimit) && requestedFeatureLimit > 0
      ? Math.min(DEFAULT_FEATURE_LIMIT, Math.floor(requestedFeatureLimit))
      : DEFAULT_FEATURE_LIMIT

  // Probing is capped separately from the stored-feature cap: one COUNT per
  // feature is the expensive part of a recall.
  const queryFeatures = topFeatures(text, Math.min(featureLimit, MAX_PROBE_FEATURES))
  if (queryFeatures.length === 0) return []

  const { clause, params } = visibilityClause(scope, project, kinds)
  /** @type {Array<{ hash: number, weight: number }>} */
  const hashes = []
  const seen = new Set()
  for (const { feature, weight } of queryFeatures) {
    const hash = fnv1a(feature)
    if (hash === EMPTY_FEATURE || seen.has(hash)) continue
    seen.add(hash)
    hashes.push({ hash, weight })
  }
  if (hashes.length === 0) return []

  // Document frequency is probed with a cap, and the cap doubles as the "too
  // common to discriminate" threshold. Without it a query made of corpus-common
  // grams (e.g. 项目/部署 on a large memory store) would scan the postings of every
  // probed feature and cost hundreds of milliseconds. A feature that appears in
  // more than MAX_DOCUMENT_FREQUENCY visible rows is skipped: it cannot narrow the
  // candidate set anyway, and in that situation the FTS/LIKE passes are usually
  // rich enough that the vector branch never runs.
  const dfStatement = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT 1
         FROM memory_features f
         JOIN memory m ON m.id = f.memory_id
        WHERE f.feature = ? AND f.feature <> ${EMPTY_FEATURE} AND m.superseded_by IS NULL${clause}
        LIMIT ?
     )`,
  )
  /** @type {Array<{ hash: number, weight: number, df: number }>} */
  const probed = []
  for (const entry of hashes) {
    const df = Number(dfStatement.get(entry.hash, ...params, MAX_DOCUMENT_FREQUENCY)?.n ?? 0)
    if (df > 0 && df < MAX_DOCUMENT_FREQUENCY) probed.push({ ...entry, df })
  }
  if (probed.length === 0) return []

  // Rarest first: a feature shared by most of the corpus nominates everything and
  // therefore discriminates nothing.
  const selected = probed
    .sort((a, b) => a.df - b.df || b.weight - a.weight || a.hash - b.hash)
    .slice(0, maxFeatures)
  const placeholders = selected.map(() => '?').join(',')
  // INDEXED BY is not decoration: without it SQLite drives this join from `memory`
  // (via its scope index) and probes the feature PK once per row — 106ms vs 5ms on
  // a 10k-memory corpus for the same rows. The feature index must be the outer loop.
  const rows = db
    .prepare(
      `SELECT f.memory_id, COUNT(*) AS hits, SUM(f.weight) AS w
         FROM memory_features f INDEXED BY memory_features_feature_idx
         JOIN memory m ON m.id = f.memory_id
        WHERE f.feature IN (${placeholders}) AND f.feature <> ${EMPTY_FEATURE} AND m.superseded_by IS NULL${clause}
        GROUP BY f.memory_id
        ORDER BY hits DESC, w DESC
        LIMIT ?`,
    )
    .all(...selected.map((entry) => entry.hash), ...params, limit)
  return rows.map((row) => Number(row.memory_id))
}
