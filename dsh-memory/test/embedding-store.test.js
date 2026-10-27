import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory } from '../src/store.js'
import {
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
