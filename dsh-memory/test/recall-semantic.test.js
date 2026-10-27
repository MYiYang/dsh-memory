import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory } from '../src/store.js'
import { putEmbedding } from '../src/embedding-store.js'
import { recall } from '../src/recall.js'

const MODEL = 'openai:toy@3'

function freshDb() {
  return openDatabase(':memory:')
}

/** Save a global fact and attach a 3-dim embedding under {@link MODEL}. */
function seed(db, text, vector, options = {}) {
  const saved = saveMemory(
    db,
    { text, scope: options.scope ?? 'global', project: options.project ?? null, kind: options.kind ?? 'fact' },
    options.now,
  )
  if (vector !== null) {
    const row = db.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id)
    putEmbedding(db, {
      memoryId: saved.id,
      model: options.model ?? MODEL,
      dims: 3,
      textHash: String(row.hash),
      vector: Float32Array.from(vector),
    })
  }
  return saved.id
}

/** Recall options that exercise the semantic channel. */
function semanticOptions(queryVector, overrides = {}) {
  return {
    scope: 'global',
    minScore: 0,
    touch: false,
    vector: {
      enabled: true,
      weight: 0.4,
      scanLimit: 100,
      minCosine: 0.5,
      queryVector: Float32Array.from(queryVector),
      model: MODEL,
      ...overrides,
    },
  }
}

test('a memory with no wording in common is recalled by the configured model', () => {
  const db = freshDb()
  const build = seed(db, '构建用 pnpm', [1, 0, 0])
  const dbPort = seed(db, '数据库端口 3306', [0, 1, 0])
  // The query shares no term (Chinese or Latin) with either memory.
  const result = recall(db, 'compile the project', semanticOptions([1, 0, 0]))
  const ids = result.items.map((row) => row.id)
  assert.deepEqual(ids, [build], 'only the semantically close row is nominated')
  assert.ok(!ids.includes(dbPort))
  assert.match(result.strategy, /\+sem$/, `strategy should mark the semantic channel (was ${result.strategy})`)
  db.close()
})

test('the floor minCosine decides what counts as related', () => {
  const db = freshDb()
  // cos([0.8, 0.6, 0], [1, 0, 0]) = 0.8
  seed(db, '部署脚本先 dry-run', [0.8, 0.6, 0])
  const loose = recall(db, 'compile the project', semanticOptions([1, 0, 0], { minCosine: 0.5 }))
  assert.equal(loose.items.length, 1, 'cos 0.8 clears a 0.5 floor')
  const strict = recall(db, 'compile the project', semanticOptions([1, 0, 0], { minCosine: 0.9 }))
  assert.equal(strict.items.length, 0, 'cos 0.8 is below a 0.9 floor')
  db.close()
})

test('a closer vector outranks a weaker one when everything else is equal', () => {
  const db = freshDb()
  const now = 1_700_000_000_000
  const near = seed(db, '部署流程用 pnpm', [1, 0, 0], { now })
  const far = seed(db, '发布流程走 Release', [0.8, 0.6, 0], { now })
  const result = recall(db, 'compile the project', semanticOptions([1, 0, 0], { minCosine: 0.5 }))
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map((row) => row.id), [near, far], 'cos 1.0 ranks above cos 0.8')
  assert.ok(result.items[0].score > result.items[1].score)
  db.close()
})

test('a lexical hit without a vector keeps its text score and gains nothing', () => {
  const db = freshDb()
  // No embedding stored for this row: it can only be recalled lexically.
  const plain = seed(db, '数据库端口 3306', null)
  const withSemantic = recall(db, '数据库端口', semanticOptions([0, 1, 0]))
  const withoutVector = recall(db, '数据库端口', { scope: 'global', minScore: 0, touch: false })
  assert.deepEqual(withSemantic.items.map((row) => row.id), [plain])
  assert.deepEqual(withoutVector.items.map((row) => row.id), [plain])
  assert.ok(
    Math.abs(withSemantic.items[0].score - withoutVector.items[0].score) < 1e-9,
    'cosine 0 contributes exactly nothing (the floor maps it to 0)',
  )
  db.close()
})

test('without a query vector the lexical channel still runs (regression)', () => {
  const db = freshDb()
  const saved = saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  // `enabled: true` but no queryVector/model -> the old behaviour, unchanged.
  const result = recall(db, '部署流程', { scope: 'global', minScore: 0, touch: false, vector: { enabled: true } })
  assert.deepEqual(result.items.map((row) => row.id), [saved.id])
  assert.match(result.strategy, /\+vec$/)
  assert.ok(!result.strategy.includes('+sem'))
  db.close()
})

test('vector.enabled === false disables both channels', () => {
  const db = freshDb()
  seed(db, '构建用 pnpm', [1, 0, 0])
  const result = recall(db, 'compile the project', {
    scope: 'global',
    minScore: 0,
    touch: false,
    vector: { enabled: false, queryVector: Float32Array.from([1, 0, 0]), model: MODEL, weight: 0.4 },
  })
  assert.equal(result.items.length, 0)
  assert.equal(result.strategy, 'fts', 'the query has Latin terms, so the lexical base is fts')
  db.close()
})

test('a wrong-width query vector is ignored instead of throwing', () => {
  const db = freshDb()
  seed(db, '构建用 pnpm', [1, 0, 0])
  const result = recall(db, 'compile the project', {
    scope: 'global',
    minScore: 0,
    touch: false,
    vector: { enabled: true, weight: 0.4, minCosine: 0.5, queryVector: Float32Array.from([1, 0]), model: MODEL },
  })
  // The scan stores 3-dim rows; the 2-dim query matches none of them.
  assert.equal(result.items.length, 0)
  db.close()
})

test('rows embedded by another model are invisible to this one', () => {
  const db = freshDb()
  seed(db, '构建用 pnpm', [1, 0, 0], { model: 'openai:old@3' })
  const result = recall(db, 'compile the project', semanticOptions([1, 0, 0]))
  assert.equal(result.items.length, 0, 'a tag mismatch yields no candidates')
  db.close()
})
