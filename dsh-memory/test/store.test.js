import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCHEMA_VERSION,
  openDatabase,
  saveMemory,
  searchFts,
  searchLike,
  forgetMemories,
  getMeta,
  migrate,
  stats,
  listRecent,
  textHash,
} from '../src/store.js'

function freshDb() {
  return openDatabase(':memory:')
}

test('saveMemory inserts once and dedupes identical text', () => {
  const db = freshDb()
  const first = saveMemory(db, { kind: 'fact', text: '用户用 Windows + pwsh，项目根目录 F:\\menm' })
  assert.equal(first.inserted, true)
  const second = saveMemory(db, { kind: 'fact', text: '  用户用 Windows + pwsh，项目根目录 F:\\menm  ' })
  assert.equal(second.inserted, false)
  assert.equal(second.id, first.id)
  const count = db.prepare('SELECT COUNT(*) AS n FROM memory').get().n
  assert.equal(Number(count), 1)
  db.close()
})

test('saveMemory rejects empty text and clamps tags', () => {
  const db = freshDb()
  assert.throws(() => saveMemory(db, { text: '   ' }))
  const { id } = saveMemory(db, { text: 'note', tags: Array.from({ length: 30 }, (_, i) => `t${i}`) })
  const row = db.prepare('SELECT tags FROM memory WHERE id = ?').get(id)
  assert.equal(JSON.parse(row.tags).length, 20)
  db.close()
})

test('FTS5 trigram finds English words and 3+ char CJK substrings', () => {
  const db = freshDb()
  saveMemory(db, { text: 'The deploy script validates LLM connectivity with GET /models' })
  saveMemory(db, { text: '数据库迁移工具需要先备份整个数据目录' })
  saveMemory(db, { text: 'unrelated cooking recipe' })

  const en = searchFts(db, '"deploy" OR "validates"')
  assert.equal(en.length, 1)
  assert.match(en[0].text, /deploy script/)

  const zh = searchFts(db, '"数据"') // 2 chars -> no trigram hit by design
  assert.equal(zh.length, 0)
  const zh3 = searchFts(db, '"数据目"')
  assert.equal(zh3.length, 1)
  db.close()
})

test('searchLike covers 2-char CJK terms', () => {
  const db = freshDb()
  saveMemory(db, { text: '部署前必须先跑 dry-run 校验' })
  const hits = searchLike(db, ['部署'])
  assert.equal(hits.length, 1)
  assert.match(hits[0].text, /dry-run/)
  db.close()
})

test('scope filtering keeps project rows and global rows apart', () => {
  const db = freshDb()
  saveMemory(db, { text: 'global preference: 用中文回复', scope: 'global' })
  saveMemory(db, { text: 'project alpha detail: 使用 pnpm 工作区', scope: 'project', project: 'alpha' })
  saveMemory(db, { text: 'project beta detail: 使用 npm 单包', scope: 'project', project: 'beta' })

  const projectHits = searchLike(db, ['detail'], { scope: 'project', project: 'alpha' })
  const texts = projectHits.map((row) => row.text)
  assert.ok(texts.some((t) => t.includes('alpha')), 'own project row is visible')
  assert.ok(!texts.some((t) => t.includes('beta')), 'other project row is hidden')

  const globalOnly = searchLike(db, ['detail'], { scope: 'global' })
  assert.equal(globalOnly.length, 0)
  db.close()
})

test('forget removes by id and by query; stats reflect it', () => {
  const db = freshDb()
  const a = saveMemory(db, { text: 'temp memory about clipboard' })
  const b = saveMemory(db, { text: 'keep memory about deploy' })
  assert.equal(forgetMemories(db, { ids: [a.id] }), 1)
  assert.equal(forgetMemories(db, { query: 'deploy' }), 1)
  const s = stats(db)
  assert.equal(s.total, 0)
  assert.ok(b.id > 0)
  db.close()
})

test('stats counts kinds and projects; listRecent orders by updated_at', () => {
  const db = freshDb()
  saveMemory(db, { kind: 'fact', text: 'fact one' }, 1000)
  saveMemory(db, { kind: 'episode', text: 'episode one', scope: 'project', project: 'p1' }, 2000)
  const s = stats(db)
  assert.equal(s.total, 2)
  assert.equal(s.facts, 1)
  assert.equal(s.episodes, 1)
  assert.equal(s.projects, 1)
  const recent = listRecent(db, { limit: 5 })
  assert.equal(recent[0].text, 'episode one')
  db.close()
})

test('textHash normalizes whitespace and case', () => {
  assert.equal(textHash('Hello   World'), textHash(' hello world '))
})

test('schema v5 adds the feature index and embedding tables and stays idempotent', () => {
  const db = freshDb()
  assert.equal(SCHEMA_VERSION, 5)
  assert.equal(getMeta(db, 'schema_version'), '5')
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  assert.ok(tables.includes('memory_features'), 'missing memory_features table')
  assert.ok(tables.includes('memory_embeddings'), 'missing memory_embeddings table')
  const objects = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger')").all().map((row) => row.name)
  assert.ok(objects.includes('memory_features_feature_idx'), 'missing feature index')
  assert.ok(objects.includes('memory_features_ad'), 'missing delete trigger')
  assert.ok(objects.includes('memory_embeddings_model_idx'), 'missing embedding model index')
  assert.ok(objects.includes('memory_embeddings_ad'), 'missing embedding delete trigger')

  saveMemory(db, { text: '部署流程用 pnpm' })
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_features').get().n)
  assert.ok(before > 0, 'a save writes feature rows')

  // A second migration pass must not clear, duplicate or downgrade anything.
  migrate(db)
  assert.equal(getMeta(db, 'schema_version'), '5')
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM memory_features').get().n), before)
  db.close()
})

test('stats reports how much of the corpus the feature index covers', () => {
  const db = freshDb()
  saveMemory(db, { text: '部署流程用 pnpm' })
  saveMemory(db, { text: '数据库端口 3306' })
  const s = stats(db)
  assert.equal(s.total, 2)
  assert.equal(s.featureIndexed, 2)
  db.close()
})

test('re-saving a deduplicated row repairs a missing feature index', () => {
  const db = freshDb()
  const first = saveMemory(db, { text: '部署流程用 pnpm' })
  // Simulate a row created before the v4 index existed.
  db.prepare('DELETE FROM memory_features WHERE memory_id = ?').run(first.id)
  const again = saveMemory(db, { text: '部署流程用 pnpm' })
  assert.equal(again.inserted, false)
  assert.equal(again.id, first.id)
  const indexed = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_features WHERE memory_id = ?').get(first.id).n)
  assert.ok(indexed > 0, 'the dedupe path must not leave the row unindexed')
  db.close()
})
