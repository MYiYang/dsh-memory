import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory } from '../src/store.js'
import { embeddingCounts, putEmbedding } from '../src/embedding-store.js'
import {
  EMBED_BATCH_SIZE,
  EMBED_DEBOUNCE_MS,
  EMBED_IDLE_MS,
  EMBED_RETRY_BASE_MS,
  createEmbeddingWorker,
} from '../src/embed-worker.js'

const TAG = 'openai:toy@3'

/**
 * A client double with the same shape the worker consumes: a mutable tag/dims
 * (the worker reads them per pass), `ensureDims()` and `embed()`.
 */
function fakeClient(options = {}) {
  const calls = []
  const client = {
    provider: options.provider ?? 'openai',
    available: options.available !== false,
    model: options.model ?? 'toy',
    dims: options.dims === undefined ? 3 : options.dims,
    tag: options.tag === undefined ? TAG : options.tag,
    error: options.error ?? null,
    async ensureDims() {
      if (this.dims === null) return { ok: false, dims: null, error: 'dims unknown' }
      return { ok: true, dims: this.dims, source: 'probed', error: null }
    },
    async embed(texts) {
      calls.push([...texts])
      if (typeof options.fail === 'string') return { ok: false, vectors: [], dims: this.dims, error: options.fail }
      return { ok: true, vectors: texts.map(() => Float32Array.from([1, 0, 0])), dims: this.dims, error: null }
    },
  }
  return { client, calls }
}

function freshDb() {
  return openDatabase(':memory:')
}

/** Seed `count` memories, newest last. */
function seedRows(db, count, prefix = '记忆') {
  const ids = []
  for (let index = 0; index < count; index++) {
    ids.push(saveMemory(db, { text: `${prefix} ${index} 部署流程用 pnpm` }, 1_000 + index).id)
  }
  return ids
}

test('one pass embeds pending rows in batches and stops when nothing is left', async () => {
  const db = freshDb()
  seedRows(db, EMBED_BATCH_SIZE + 3)
  const { client, calls } = fakeClient()
  const worker = createEmbeddingWorker({ db, getClient: () => client })

  const first = await worker.drainOnce()
  assert.equal(first.ok, true)
  assert.equal(first.embedded, EMBED_BATCH_SIZE + 3)
  assert.deepEqual(calls.map((batch) => batch.length), [EMBED_BATCH_SIZE, 3], 'one request per batch')
  assert.equal(embeddingCounts(db, TAG).embedded, EMBED_BATCH_SIZE + 3)
  assert.equal(embeddingCounts(db, TAG).pending, 0)

  const second = await worker.drainOnce()
  assert.equal(second.embedded, 0, 'nothing left to do')
  assert.equal(calls.length, 2, 'no request without pending rows')
  worker.dispose()
  db.close()
})

test('a failing client records the error, keeps the rows pending and recovers', async () => {
  const db = freshDb()
  seedRows(db, 4)
  let fail = 'HTTP 500: boom'
  const { client } = fakeClient()
  const failing = {
    ...client,
    embed: async () => ({ ok: false, vectors: [], dims: 3, error: fail }),
  }
  const delays = []
  const worker = createEmbeddingWorker({
    db,
    getClient: () => failing,
    setTimeout: (fn, ms) => {
      delays.push(ms)
      return { unref() {} }
    },
    clearTimeout: () => {},
  })

  const failed = await worker.drainOnce()
  assert.equal(failed.ok, false)
  assert.match(String(failed.error), /HTTP 500/)
  assert.equal(worker.state().lastError, 'HTTP 500: boom')
  assert.equal(worker.state().failures, 1)
  assert.equal(embeddingCounts(db, TAG).pending, 4, 'rows stay pending after a failure')
  // The retry was scheduled with the first backoff step.
  assert.ok(delays.includes(EMBED_RETRY_BASE_MS), `expected a ${EMBED_RETRY_BASE_MS}ms retry, saw ${delays.join(',')}`)

  // A later pass with a healthy endpoint clears the streak.
  const healthy = createEmbeddingWorker({ db, getClient: () => client })
  const recovered = await healthy.drainOnce()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.embedded, 4)
  assert.equal(healthy.state().lastError, null)
  assert.equal(healthy.state().failures, 0)
  worker.dispose()
  healthy.dispose()
  db.close()
})

test('a new tag prunes the previous model rows and re-embeds', async () => {
  const db = freshDb()
  const ids = seedRows(db, 2)
  // Rows embedded by an older model must not survive a model switch.
  for (const id of ids) {
    const hash = String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(id).hash)
    putEmbedding(db, { memoryId: id, model: 'openai:old@3', dims: 3, textHash: hash, vector: Float32Array.from([1, 0, 0]) })
  }
  const { client } = fakeClient()
  const worker = createEmbeddingWorker({ db, getClient: () => client })
  const result = await worker.drainOnce()
  assert.equal(result.ok, true)
  assert.equal(result.tag, TAG)
  const models = db.prepare('SELECT DISTINCT model FROM memory_embeddings').all().map((row) => row.model)
  assert.deepEqual(models, [TAG])
  assert.equal(embeddingCounts(db, TAG).embedded, 2)
  worker.dispose()
  db.close()
})

test('a broken new model never deletes the previous model rows', async () => {
  const db = freshDb()
  const ids = seedRows(db, 1)
  const hash = String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(ids[0]).hash)
  putEmbedding(db, { memoryId: ids[0], model: 'openai:old@3', dims: 3, textHash: hash, vector: Float32Array.from([1, 0, 0]) })
  const { client } = fakeClient({ fail: 'HTTP 401: bad key' })
  const worker = createEmbeddingWorker({ db, getClient: () => client, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} })
  const result = await worker.drainOnce()
  assert.equal(result.ok, false)
  const models = db.prepare('SELECT DISTINCT model FROM memory_embeddings').all().map((row) => row.model)
  assert.deepEqual(models, ['openai:old@3'], 'a misconfigured model must not destroy working vectors')
  worker.dispose()
  db.close()
})

test('the built-in provider and an unavailable client are skipped without work', async () => {
  const db = freshDb()
  seedRows(db, 2)
  const builtin = createEmbeddingWorker({ db, getClient: () => fakeClient({ provider: 'hash', tag: null, dims: 384 }).client })
  assert.deepEqual(await builtin.drainOnce(), { ok: true, skipped: 'builtin' })
  builtin.dispose()

  const unavailable = createEmbeddingWorker({
    db,
    getClient: () => fakeClient({ available: false, error: 'no model configured' }).client,
  })
  const skipped = await unavailable.drainOnce()
  assert.equal(skipped.ok, false)
  assert.equal(skipped.skipped, 'unavailable')
  assert.equal(embeddingCounts(db, TAG).embedded, 0)
  unavailable.dispose()

  const missing = createEmbeddingWorker({ db, getClient: () => null })
  assert.deepEqual(await missing.drainOnce(), { ok: true, skipped: 'builtin' })
  missing.dispose()
  db.close()
})

test('an unknown width is resolved before any row is written', async () => {
  const db = freshDb()
  seedRows(db, 1)
  let resolved = false
  const { client } = fakeClient({ dims: null })
  client.ensureDims = async () => {
    resolved = true
    client.dims = 3
    return { ok: true, dims: 3, source: 'probed', error: null }
  }
  const worker = createEmbeddingWorker({ db, getClient: () => client })
  const result = await worker.drainOnce()
  assert.equal(resolved, true)
  assert.equal(result.ok, true)
  assert.equal(embeddingCounts(db, TAG).embedded, 1)
  worker.dispose()
  db.close()
})

test('a width that cannot be resolved fails the pass but keeps the rows', async () => {
  const db = freshDb()
  seedRows(db, 1)
  const { client } = fakeClient({ dims: null })
  const worker = createEmbeddingWorker({ db, getClient: () => client, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} })
  const result = await worker.drainOnce()
  assert.equal(result.ok, false)
  assert.match(String(worker.state().lastError), /dims unknown/)
  assert.equal(embeddingCounts(db, TAG).pending, 1)
  worker.dispose()
  db.close()
})

test('hasVectors() tells the pre-step whether a round trip can help', async () => {
  const db = freshDb()
  const { client } = fakeClient()
  const worker = createEmbeddingWorker({ db, getClient: () => client })
  seedRows(db, 1)
  assert.equal(worker.hasVectors(), false)
  await worker.drainOnce()
  assert.equal(worker.hasVectors(), true)
  assert.equal(worker.state().counts.embedded, 1)
  assert.equal(worker.state().counts.total, 1)
  worker.dispose()
  db.close()
})

test('note() debounces, a sooner nudge shortens the wait, dispose() silences', async () => {
  const db = freshDb()
  seedRows(db, 1)
  const { client } = fakeClient()
  const scheduled = []
  const worker = createEmbeddingWorker({
    db,
    getClient: () => client,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {}, cleared: false }
      scheduled.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      handle.cleared = true
    },
  })

  worker.note()
  worker.note()
  assert.equal(scheduled.length, 1, 'two nudges inside the debounce window schedule one pass')
  assert.equal(scheduled[0].ms, EMBED_DEBOUNCE_MS)

  // An idle poll that is already scheduled must not swallow a fresh nudge:
  // saving a memory has to become semantically recallable within seconds.
  worker.note(EMBED_IDLE_MS)
  assert.equal(scheduled.length, 1, 'a later request does not postpone the pending pass')
  worker.note(200)
  assert.equal(scheduled.length, 2, 'a sooner request replaces the pending pass')
  assert.equal(scheduled[0].cleared, true)
  assert.equal(scheduled[1].ms, 200)

  worker.dispose()
  assert.equal(scheduled[1].cleared, true)
  assert.deepEqual(await worker.drainOnce(), { ok: false, skipped: 'disposed' })
  worker.note()
  assert.equal(scheduled.length, 2, 'a disposed worker schedules nothing')
  assert.equal(EMBED_IDLE_MS > EMBED_DEBOUNCE_MS, true)
  db.close()
})
