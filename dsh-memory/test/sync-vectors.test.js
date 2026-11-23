/**
 * Vector sync: codec round-trip, trigger capture, segment push/pull, snapshot
 * bootstrap and the "off means off" contract.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { ensureEmbeddingSchema, putEmbedding } from '../src/embedding-store.js'
import { setSyncEnabled } from '../src/sync/schema.js'
import { createSyncEngine } from '../src/sync/engine.js'
import { decodeVector, encodeVector, normalizeCodec } from '../src/sync/vectors.js'

const MODEL = 'test:tiny@8'
const DIMS = 8

function tempDir(prefix = 'dsh-sync-vec-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function newDb(dir, name) {
  const db = openDatabase(join(dir, `${name}.db`))
  ensureEmbeddingSchema(db)
  setSyncEnabled(db, true)
  return db
}

function vectorOf(seed) {
  const vector = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i += 1) vector[i] = Math.sin(seed * (i + 1)) * 0.1
  return vector
}

function configFor(dir, overrides = {}) {
  return {
    dbPath: join(dir, 'a.db'),
    sync: {
      enabled: true,
      mode: 'manual',
      remote: 'local',
      local: { dir: join(dir, 'remote') },
      s3: { endpoint: '', bucket: '', region: 'us-east-1', pathStyle: true, prefix: 'v1' },
      ...overrides,
    },
  }
}

/** Every file under `<remote>/v1/<workspace>/…`, as slash-separated relative paths. */
function remoteFiles(dir) {
  const out = []
  const walk = (base, prefix) => {
    for (const name of readdirSync(base)) {
      const full = join(base, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, rel)
      else out.push(rel)
    }
  }
  walk(join(dir, 'remote'), '')
  return out
}

test('codec round-trip: f32 is byte-exact, f16/i8 stay within tolerance', () => {
  const vector = vectorOf(3)
  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
  for (const codec of ['f32', 'f16', 'i8']) {
    const back = decodeVector(encodeVector(blob, DIMS, codec), DIMS, codec)
    assert.equal(back.length, blob.length, `${codec} width`)
    if (codec === 'f32') {
      assert.equal(Buffer.compare(back, blob), 0, 'f32 must be byte-exact')
      continue
    }
    const got = new Float32Array(back.buffer, back.byteOffset, DIMS)
    let maxError = 0
    for (let i = 0; i < DIMS; i += 1) maxError = Math.max(maxError, Math.abs(vector[i] - got[i]))
    assert.ok(maxError < 0.002, `${codec} max error ${maxError} is too large`)
  }
})

test('vectors config normalizes to a known codec or off', () => {
  assert.equal(normalizeCodec('f32'), 'f32')
  assert.equal(normalizeCodec('F16'), 'f16')
  assert.equal(normalizeCodec('i8'), 'i8')
  assert.equal(normalizeCodec(''), 'off')
  assert.equal(normalizeCodec('off'), 'off')
  assert.equal(normalizeCodec('f64'), 'off')
})

test('a vector write marks a dirty row but never enters the oplog', () => {
  const dir = tempDir()
  const db = newDb(dir, 'a')
  const memory = saveMemory(db, { text: '带向量的一条事实', scope: 'global' })
  assert.equal(putEmbedding(db, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: 'h1', vector: vectorOf(1) }), true)

  const dirty = db.prepare('SELECT row_key AS key FROM sync_emb_dirty').all().map((row) => String(row.key))
  assert.equal(dirty.length, 1)
  assert.ok(dirty[0].endsWith(`|${MODEL}`), dirty[0])
  const logged = db.prepare("SELECT COUNT(*) AS n FROM sync_oplog WHERE tbl = 'memory_embeddings'").get()
  assert.equal(Number(logged.n), 0, 'a 16 KB blob must not be written into the oplog')
  db.close()
})

test('two devices converge on vectors over segments', async () => {
  const dir = tempDir()
  const dbA = newDb(dir, 'a')
  const dbB = newDb(dir, 'b')
  const memory = saveMemory(dbA, { text: '设备甲的一条带向量事实', scope: 'global' })
  putEmbedding(dbA, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: 'h1', vector: vectorOf(2) })

  const engineA = createSyncEngine({ db: dbA, config: configFor(dir, { vectors: 'f32' }) })
  const engineB = createSyncEngine({ db: dbB, config: { ...configFor(dir, { vectors: 'f32' }), dbPath: join(dir, 'b.db') } })

  const pushed = await engineA.syncNow()
  assert.ok(Number(pushed.embPushed) >= 1, `expected a vector segment, got ${JSON.stringify(pushed)}`)

  const pulled = await engineB.syncNow()
  assert.ok(Number(pulled.embPulled) >= 1, `expected a vector pull, got ${JSON.stringify(pulled)}`)

  const rows = dbB.prepare('SELECT model, dims, vec FROM memory_embeddings').all()
  assert.equal(rows.length, 1)
  assert.equal(String(rows[0].model), MODEL)
  assert.equal(Number(rows[0].dims), DIMS)
  const source = dbA.prepare('SELECT vec FROM memory_embeddings').get()
  assert.equal(Buffer.compare(Buffer.from(rows[0].vec), Buffer.from(source.vec)), 0, 'f32 payload must survive as-is')
  dbA.close()
  dbB.close()
})

test('a snapshot carries the vectors, so a fresh device never recomputes them', async () => {
  const dir = tempDir()
  const dbA = newDb(dir, 'a')
  const engineA = createSyncEngine({ db: dbA, config: configFor(dir, { vectors: 'f32' }) })
  for (let i = 0; i < 3; i += 1) {
    const memory = saveMemory(dbA, { text: `事实 ${i}`, scope: 'global' })
    putEmbedding(dbA, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: `h${i}`, vector: vectorOf(i + 10) })
  }
  const published = await engineA.publishSnapshot()
  assert.equal(published.published, true)
  assert.equal(published.embOps, 3, `snapshot should carry 3 vectors, got ${JSON.stringify(published)}`)

  const dbB = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: dbB, config: { ...configFor(dir, { vectors: 'f32' }), dbPath: join(dir, 'b.db') } })
  const result = await engineB.syncNow()
  assert.equal(result.bootstrap?.parts, published.parts)

  const restored = dbB.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get()
  assert.equal(Number(restored.n), 3, 'every vector must arrive with the snapshot')
  const sample = dbB.prepare('SELECT vec FROM memory_embeddings ORDER BY memory_id LIMIT 1').get()
  assert.ok(sample.vec !== null && sample.vec !== undefined)
  dbA.close()
  dbB.close()
})

test('vectors=off publishes truth only and never creates an emb object', async () => {
  const dir = tempDir()
  const dbA = newDb(dir, 'a')
  const memory = saveMemory(dbA, { text: '只有真相也要能同步', scope: 'global' })
  putEmbedding(dbA, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: 'h1', vector: vectorOf(4) })

  const engine = createSyncEngine({ db: dbA, config: configFor(dir) })
  const result = await engine.syncNow()
  assert.equal(result.embPushed ?? 0, 0)
  const files = remoteFiles(dir)
  assert.ok(files.some((file) => file.endsWith('.jsonl.br')), 'a truth segment should exist')
  assert.equal(files.filter((file) => file.includes('/emb/')).length, 0, `no vector objects expected: ${files.join(', ')}`)
  dbA.close()
})

test('verify reports vector coverage and counts an uploaded row', async () => {
  const dir = tempDir()
  const dbA = newDb(dir, 'a')
  const memory = saveMemory(dbA, { text: '对账要看得见向量', scope: 'global' })
  putEmbedding(dbA, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: 'h1', vector: vectorOf(5) })

  const engine = createSyncEngine({ db: dbA, config: configFor(dir, { vectors: 'f32' }) })
  await engine.publishSnapshot()
  const report = await engine.verify()
  assert.ok(report.emb !== null && report.emb !== undefined, 'verify should carry an emb section')
  assert.equal(report.emb.local, 1)
  assert.equal(report.emb.remote, 1)
  assert.equal(report.emb.missing, 0)
  assert.equal(report.emb.codec, 'f32')
  dbA.close()
})

test('turning vectors on publishes a snapshot even when nothing was deleted', async () => {
  const dir = tempDir()
  const db = newDb(dir, 'a')
  const memory = saveMemory(db, { text: '存量向量也要能上云', scope: 'global' })
  putEmbedding(db, { memoryId: memory.id, model: MODEL, dims: DIMS, textHash: 'h1', vector: vectorOf(6) })

  // First snapshot is published with vectors off: truth only, no embParts.
  const off = createSyncEngine({ db, config: configFor(dir) })
  const before = await off.publishSnapshot()
  assert.equal(before.published, true)
  assert.equal(before.embParts ?? 0, 0)
  assert.equal(remoteFiles(dir).filter((file) => file.includes('emb')).length, 0)

  // The switch flips on. No tombstone exists, so `maybeRepublishSnapshot` would
  // never fire — the engine has to notice on its own.
  const on = createSyncEngine({ db, config: configFor(dir, { vectors: 'f32' }) })
  const result = await on.syncNow()
  assert.ok(result.vectorSnapshot !== undefined, `expected a vector republish, got ${JSON.stringify(result)}`)
  assert.ok(Number(result.vectorSnapshot.embOps) >= 1)

  const files = remoteFiles(dir)
  assert.ok(
    files.some((file) => /emb-\d+\.jsonl\.br$/.test(file)),
    `a snapshot vector part should exist: ${files.join(', ')}`,
  )
  const again = await on.syncNow()
  assert.equal(again.vectorSnapshot, undefined, 'the republish must happen once, not every cycle')
  db.close()
})
