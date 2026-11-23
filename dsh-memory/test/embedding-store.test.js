import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory, stats as statsOf, backfillVectors } from '../src/store.js'
import {
  activeEmbeddedCount,
  deleteModelEmbeddings,
  deleteOtherModels,
  embeddingCounts,
  ensureEmbeddingSchema,
  hasEmbeddingTable,
  loadEmbeddings,
  pendingEmbeddingRows,
  putEmbedding,
  semanticCandidates,
} from '../src/embedding-store.js'

const MODEL = 'openai:toy@3'

/** 3-dim unit vectors, easy to reason about. */
function vec(x, y = 0, z = 0) {
  return Float32Array.from([x, y, z])
}

function freshDb() {
  return openDatabase(':memory:')
}

/** Store one memory and give it an embedding under `model`. */
function seed(db, text, options = {}) {
  const saved = saveMemory(db, {
    text,
    scope: options.scope ?? 'global',
    project: options.project ?? null,
    kind: options.kind ?? 'fact',
  })
  const row = db.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id)
  putEmbedding(db, {
    memoryId: saved.id,
    model: options.model ?? MODEL,
    dims: 3,
    textHash: String(row.hash),
    vector: options.vector ?? vec(1),
    now: options.now ?? Date.now(),
  })
  return saved.id
}

test('the embedding table exists on a fresh v5 database', () => {
  const db = freshDb()
  assert.equal(hasEmbeddingTable(db), true)
  // Idempotent: a second pass must not drop data.
  seed(db, '部署流程用 pnpm')
  ensureEmbeddingSchema(db)
  assert.equal(embeddingCounts(db, MODEL).embedded, 1)
  db.close()
})

test('putEmbedding validates its input and round-trips through loadEmbeddings', () => {
  const db = freshDb()
  const id = seed(db, '数据库端口 3306', { vector: vec(0, 1, 0) })
  assert.equal(
    putEmbedding(db, { memoryId: id, model: MODEL, dims: 3, textHash: 'x', vector: Float32Array.from([1, 0]) }),
    false,
    'wrong width rejected',
  )
  assert.equal(putEmbedding(db, { memoryId: 0, model: MODEL, dims: 3, textHash: 'x', vector: vec(1) }), false)
  assert.equal(putEmbedding(db, { memoryId: id, model: '', dims: 3, textHash: 'x', vector: vec(1) }), false)

  const loaded = loadEmbeddings(db, { model: MODEL, dims: 3, ids: [id] })
  assert.equal(loaded.size, 1)
  assert.deepEqual([...loaded.get(id)], [0, 1, 0])
  // A different width is not comparable -> no rows.
  assert.equal(loadEmbeddings(db, { model: MODEL, dims: 4, ids: [id] }).size, 0)
  // A different model tag -> no rows.
  assert.equal(loadEmbeddings(db, { model: 'openai:other@3', dims: 3, ids: [id] }).size, 0)
  assert.equal(loadEmbeddings(db, { model: MODEL, dims: 3, ids: [] }).size, 0)
  db.close()
})

test('pendingEmbeddingRows reports new rows first and forgets embedded and stale ones', () => {
  const db = freshDb()
  const older = saveMemory(db, { text: '旧的一条事实' }, 1_000)
  const newer = saveMemory(db, { text: '新的一条事实' }, 2_000)
  let pending = pendingEmbeddingRows(db, MODEL, 10)
  assert.deepEqual(pending.map((row) => row.id), [newer.id, older.id], 'newest first')

  const hash = (id) => String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(id).hash)
  putEmbedding(db, { memoryId: older.id, model: MODEL, dims: 3, textHash: hash(older.id), vector: vec(1) })
  pending = pendingEmbeddingRows(db, MODEL, 10)
  assert.deepEqual(pending.map((row) => row.id), [newer.id], 'an embedded row is no longer pending')

  // Editing the text changes the content hash -> the stored vector is stale.
  db.prepare('UPDATE memory SET hash = ?, text = ? WHERE id = ?').run('edited-hash', '改过的一条事实', older.id)
  pending = pendingEmbeddingRows(db, MODEL, 10)
  assert.deepEqual(pending.map((row) => row.id).sort(), [older.id, newer.id].sort(), 'an edited row is pending again')
  assert.equal(pendingEmbeddingRows(db, MODEL, 1).length, 1, 'limit is honored')
  db.close()
})

test('superseded rows are never queued', () => {
  const db = freshDb()
  const keep = saveMemory(db, { text: '保留的事实' }, 1_000)
  const dead = saveMemory(db, { text: '被取代的事实' }, 2_000)
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(keep.id, dead.id)
  assert.deepEqual(pendingEmbeddingRows(db, MODEL, 10).map((row) => row.id), [keep.id])
  db.close()
})

test('semanticCandidates respects scope, kinds, width and the recency bound', () => {
  const db = freshDb()
  const global = seed(db, '全局偏好：中文回答', { scope: 'global', vector: vec(1, 0, 0) })
  const alpha = seed(db, 'alpha 项目的事实', { scope: 'project', project: 'alpha', vector: vec(0, 1, 0) })
  const beta = seed(db, 'beta 项目的事实', { scope: 'project', project: 'beta', vector: vec(0, 0, 1) })

  const globalOnly = semanticCandidates(db, { model: MODEL, dims: 3, scope: 'global', limit: 10 })
  assert.deepEqual(globalOnly.map((row) => row.id), [global])

  const alphaScope = semanticCandidates(db, { model: MODEL, dims: 3, scope: 'project', project: 'alpha', limit: 10 })
  assert.deepEqual(alphaScope.map((row) => row.id).sort(), [global, alpha].sort(), 'project scope sees globals + its own')

  const keyless = semanticCandidates(db, { model: MODEL, dims: 3, scope: 'project', project: null, limit: 10 })
  assert.deepEqual(keyless.map((row) => row.id), [global], 'a session without a project sees globals only')

  const all = semanticCandidates(db, { model: MODEL, dims: 3, scope: 'all', limit: 10 })
  assert.equal(all.length, 3)
  assert.equal(semanticCandidates(db, { model: MODEL, dims: 3, scope: 'all', limit: 1 }).length, 1)
  assert.equal(semanticCandidates(db, { model: MODEL, dims: 4, scope: 'all', limit: 10 }).length, 0, 'width mismatch')
  assert.equal(semanticCandidates(db, { model: MODEL, dims: 3, scope: 'all', kinds: ['instruction'], limit: 10 }).length, 0)
  assert.ok(beta > 0)
  db.close()
})

test('deleteOtherModels keeps one tag and removes the rest', () => {
  const db = freshDb()
  const id = seed(db, '一条事实')
  putEmbedding(db, { memoryId: id, model: 'openai:old@3', dims: 3, textHash: 'h', vector: vec(0, 1, 0) })
  assert.equal(embeddingCounts(db, MODEL).embedded, 1)
  assert.equal(deleteOtherModels(db, MODEL), 1)
  assert.equal(loadEmbeddings(db, { model: 'openai:old@3', dims: 3, ids: [id] }).size, 0)
  assert.equal(deleteModelEmbeddings(db, MODEL), 1)
  assert.equal(embeddingCounts(db, MODEL).embedded, 0)
  db.close()
})

test('deleting a memory removes its embedding row through the trigger', () => {
  const db = freshDb()
  const id = seed(db, '要被删掉的事实')
  db.prepare('DELETE FROM memory WHERE id = ?').run(id)
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n), 0)
  db.close()
})

test('activeEmbeddedCount keeps the panel numerator inside the live corpus', () => {
  const db = freshDb()
  const kept = seed(db, '还在用的部署事实')
  const retired = seed(db, '已经被取代的部署事实')
  // Superseding does not delete the vector: the retired row keeps its embedding.
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(kept, retired)
  const counts = embeddingCounts(db, MODEL)
  assert.equal(counts.embedded, 2, 'the retired vector still occupies a row')
  assert.equal(counts.total, 1, 'but only one memory is live')
  assert.equal(activeEmbeddedCount(counts), 1, 'the panel counts live rows only')
  // Shapes the worker can report, including the one that used to print 102%.
  assert.equal(activeEmbeddedCount(null), 0)
  assert.equal(activeEmbeddedCount({ total: 3, pending: 1, stale: 0 }), 2)
  assert.equal(activeEmbeddedCount({ total: 3, pending: 1, stale: 1 }), 3, 'a stale row still carries a vector')
  assert.equal(activeEmbeddedCount({ total: 0, embedded: 5, pending: 0, stale: 0 }), 0)
  db.close()
})

test('embeddingCounts separates total, embedded and pending', () => {
  const db = freshDb()
  seed(db, '已经嵌入的事实')
  saveMemory(db, { text: '还没嵌入的事实' })
  const counts = embeddingCounts(db, MODEL)
  assert.equal(counts.total, 2)
  assert.equal(counts.embedded, 1)
  assert.equal(counts.pending, 1)
  assert.equal(embeddingCounts(db, 'openai:none@3').embedded, 0)
  db.close()
})

// ── ANALYSIS-settings-latency.md §9: the rewritten counters must answer exactly
// what the original LEFT JOIN predicate described, on every row state. ─────────

/** The predicate this module used before the rewrite, kept as the oracle. */
function legacyPending(db, model) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM memory m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
        WHERE m.superseded_by IS NULL AND (e.memory_id IS NULL OR e.text_hash <> m.hash)`,
    )
    .get(model)
  return Number(row?.n ?? 0)
}

/** Legacy pending *rows*, same predicate, same order — the oracle for §5.3. */
function legacyPendingRows(db, model) {
  return db
    .prepare(
      `SELECT m.id AS id
         FROM memory m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?
        WHERE m.superseded_by IS NULL AND (e.memory_id IS NULL OR e.text_hash <> m.hash)
        ORDER BY m.updated_at DESC, m.id DESC`,
    )
    .all(model)
    .map((row) => Number(row.id))
}

const hashOf = (db, id) => String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(id).hash)

test('the rewritten counters equal the legacy LEFT JOIN on every row state', () => {
  const db = freshDb()
  const scenarios = [
    () => {}, // empty
    () => saveMemory(db, { text: '从没嵌入的一条' }), // missing only
    () => seed(db, '已经嵌入的一条'), // embedded only
    () => {
      // one of each: missing, embedded, stale, superseded
      seed(db, '已嵌入')
      const staleId = seed(db, '正文后来改过的')
      db.prepare('UPDATE memory SET hash = ? WHERE id = ?').run('stale-hash', staleId)
      const dead = saveMemory(db, { text: '被取代的' })
      db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(staleId, dead.id)
    },
    () => {
      // every row stale
      for (const row of db.prepare('SELECT id FROM memory WHERE superseded_by IS NULL').all()) {
        putEmbedding(db, { memoryId: Number(row.id), model: MODEL, dims: 3, textHash: 'wrong-hash', vector: vec(1) })
      }
    },
  ]
  for (const build of scenarios) {
    build()
    const counts = embeddingCounts(db, MODEL)
    assert.equal(counts.pending, legacyPending(db, MODEL), 'pending must match the legacy predicate')
    assert.equal(pendingEmbeddingRows(db, MODEL, 10_000).length, counts.pending, 'the count and the row list agree')
    assert.equal(
      pendingEmbeddingRows(db, MODEL, 10_000).map((row) => row.id).join(),
      legacyPendingRows(db, MODEL).join(),
      'pending rows must match the legacy predicate, same order',
    )
    // The two rewrite branches must never report the same row twice.
    const ids = pendingEmbeddingRows(db, MODEL, 10_000).map((row) => row.id)
    assert.equal(new Set(ids).size, ids.length, 'UNION deduplicates across the two branches')
    assert.equal(pendingEmbeddingRows(db, MODEL, 3).length, Math.min(3, counts.pending), 'the limit is honored')
  }
  db.close()
})

test('superseded rows are excluded from both total and pending', () => {
  const db = freshDb()
  const keep = saveMemory(db, { text: '保留的事实' })
  const dead = saveMemory(db, { text: '被取代的事实' })
  // Both rows have a vector: the superseded one must still drop out of every
  // corpus counter, and the surviving one must not become "stale" by accident.
  for (const row of [keep, dead]) {
    putEmbedding(db, { memoryId: row.id, model: MODEL, dims: 3, textHash: hashOf(db, row.id), vector: vec(1) })
  }
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(keep.id, dead.id)

  const counts = embeddingCounts(db, MODEL)
  assert.equal(counts.total, 1, 'a superseded row is not part of the corpus')
  assert.equal(counts.stale, 0, 'and it is not stale either')
  assert.equal(counts.pending, 0)
  assert.deepEqual(pendingEmbeddingRows(db, MODEL, 10).map((row) => row.id), [])
  db.close()
})

test('the covering index is created idempotently and survives a second call', () => {
  const db = freshDb()
  const id = seed(db, '索引幂等性')
  const before = embeddingCounts(db, MODEL)
  ensureEmbeddingSchema(db)
  ensureEmbeddingSchema(db)
  const after = embeddingCounts(db, MODEL)
  assert.deepEqual(after, before, 'a second ensureEmbeddingSchema must not change any counter')
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`).get('memory_embeddings_text_hash_idx').n,
    1,
    'exactly one covering index',
  )
  assert.equal(loadEmbeddings(db, { model: MODEL, dims: 3, ids: [id] }).size, 1, 'data survives')
  db.close()
})

test('a missing embedding table degrades to zeros instead of throwing', () => {
  const db = freshDb()
  seed(db, '有表时的一条')
  db.exec('DROP TABLE memory_embeddings')
  assert.equal(hasEmbeddingTable(db), false)
  assert.deepEqual(embeddingCounts(db, MODEL), { total: 1, embedded: 0, pending: 0, stale: 0 })
  assert.deepEqual(pendingEmbeddingRows(db, MODEL, 10), [])
  db.close()
})

test('the vec partial index keeps the coverage count correct', () => {
  const db = freshDb()
  // One row the lexical backfill already covered, one it has not: the partial
  // index must report exactly the covered ones.
  const covered = saveMemory(db, { text: '已经有词法向量的一条' })
  db.prepare('UPDATE memory SET vec = NULL, vec_model = NULL WHERE id = ?').run(covered.id + 1)
  saveMemory(db, { text: '还没有向量的一条' })
  db.prepare('UPDATE memory SET vec = NULL, vec_model = NULL WHERE id = ?').run(covered.id + 1)

  const exists = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`).get('memory_vec_idx').n
  assert.equal(exists, 1, 'memory_vec_idx exists on a fresh v5 database')

  const before = statsOf(db)
  assert.equal(before.total, 2)
  assert.equal(before.vectorized, 1, 'only the row that still carries a vector is counted')

  // Backfilling flips the second row, and the count follows.
  backfillVectors(db, { limit: 10 })
  assert.equal(statsOf(db).vectorized, 2, 'the backfilled row is counted too')
  db.close()
})

