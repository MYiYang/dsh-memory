import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory, searchFts, searchLike, forgetMemories, stats, listRecent, textHash } from '../src/store.js'

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
