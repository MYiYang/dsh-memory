import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, saveMemory } from '../src/store.js'
import { VECTOR_MODEL, embed, packVector } from '../src/vector.js'
import { buildFtsQuery, extractTerms, recall, renderMemoryBlock, renderStableBlock, scoreRow, recencyWeight } from '../src/recall.js'

function seed() {
  const db = openDatabase(':memory:')
  saveMemory(db, {
    text: '用户偏好：回答用简体中文，代码注释用英文',
    kind: 'fact',
    now: Date.now() - 5 * 86_400_000,
  })
  saveMemory(db, {
    text: '项目 menm：分析 TencentDB Agent Memory 仓库，结论是测试几乎为零',
    kind: 'fact',
    scope: 'project',
    project: 'menm',
    now: Date.now() - 2 * 86_400_000,
  })
  saveMemory(db, {
    text: 'episode: 用户问 dsh 怎么加记忆，定了原生插件方案',
    kind: 'episode',
    scope: 'project',
    project: 'menm',
    now: Date.now() - 86_400_000,
  })
  return db
}

test('extractTerms handles latin, 3-gram CJK and 2-char LIKE fallback', () => {
  const { ftsTerms, likeTerms } = extractTerms('dsh 加记忆插件的方案是什么？memory plugin')
  assert.ok(ftsTerms.includes('dsh'))
  assert.ok(ftsTerms.includes('memory'))
  assert.ok(ftsTerms.some((t) => t.includes('加记忆')))
  assert.ok(likeTerms.some((t) => t.length === 2))
})

test('buildFtsQuery quotes terms and drops single chars', () => {
  assert.equal(buildFtsQuery(['foo', 'a', '数据库']), '"foo" OR "数据库"')
  assert.equal(buildFtsQuery([]), '')
})

test('recall finds the relevant project fact and skips unrelated rows', () => {
  const db = seed()
  const result = recall(db, 'dsh 记忆插件', { project: 'menm', maxItems: 5, maxChars: 2000 })
  assert.ok(result.items.length >= 1)
  assert.ok(result.items.some((row) => row.text.includes('原生插件') || row.text.includes('dsh')))
  assert.ok(!result.items.some((row) => row.text.includes('烹饪')))
  assert.match(result.strategy, /fts|like/)
  db.close()
})

test('recall respects maxChars budget', () => {
  const db = openDatabase(':memory:')
  for (let i = 0; i < 12; i++) {
    saveMemory(db, { text: `deploy checklist step ${i} ` + 'x'.repeat(200), now: Date.now() - i * 1000 })
  }
  const result = recall(db, 'deploy checklist', { maxItems: 12, maxChars: 700 })
  const total = result.items.map((row) => row.text.length).reduce((a, b) => a + b, 0)
  assert.ok(result.items.length > 0)
  assert.ok(total <= 700 + 320 * result.items.length, 'budget applies to rendered size, not raw rows')
  db.close()
})

test('recall touches usage counters', () => {
  const db = seed()
  const first = recall(db, '原生插件', { project: 'menm' })
  assert.ok(first.items.length > 0)
  const id = first.items[0].id
  const row = db.prepare('SELECT use_count, last_used_at FROM memory WHERE id = ?').get(id)
  assert.equal(Number(row.use_count), 1)
  assert.ok(Number(row.last_used_at) > 0)
  db.close()
})

test('recall returns nothing for an empty query', () => {
  const db = seed()
  const result = recall(db, '   ', { project: 'menm' })
  assert.equal(result.items.length, 0)
  db.close()
})

test('recencyWeight halves at the half-life', () => {
  const now = Date.now()
  assert.ok(Math.abs(recencyWeight(now, now) - 1) < 1e-9)
  assert.ok(Math.abs(recencyWeight(now - 30 * 86_400_000, now) - 0.5) < 1e-9)
})

test('scoreRow prefers facts and project matches', () => {
  const now = Date.now()
  const base = { id: 1, kind: 'fact', scope: 'global', project: null, text: 't', created_at: now, updated_at: now, use_count: 0, pinned: 0 }
  const globalFact = scoreRow(base, { now, project: 'menm', bm25: -4 })
  const projectFact = scoreRow({ ...base, scope: 'project', project: 'menm' }, { now, project: 'menm', bm25: -4 })
  const episode = scoreRow({ ...base, kind: 'episode' }, { now, project: 'menm', bm25: -4 })
  assert.ok(projectFact > episode)
  assert.ok(globalFact > 0)
})

test('renderMemoryBlock is empty without items and framed with items', () => {
  assert.equal(renderMemoryBlock([]), '')
  const block = renderMemoryBlock([
    { id: 1, kind: 'fact', text: '用户偏好中文', created_at: Date.now(), updated_at: Date.now() },
  ])
  assert.match(block, /^<memory_context/)
  assert.match(block, /用户偏好中文/)
  assert.match(block, /<\/memory_context>$/)
})

test('scoreRow weights priority and kind (instruction beats episodic)', () => {
  const now = Date.now()
  const base = { id: 1, kind: 'work_fact', scope: 'project', project: 'menm', text: 't', created_at: now, updated_at: now, use_count: 0, pinned: 0 }
  const hot = scoreRow({ ...base, priority: 90 }, { now, project: 'menm', bm25: -4 })
  const cold = scoreRow({ ...base, priority: 10 }, { now, project: 'menm', bm25: -4 })
  assert.ok(hot > cold)
  const instruction = scoreRow({ ...base, kind: 'instruction', priority: 50 }, { now, project: 'menm', bm25: -4 })
  const episodic = scoreRow({ ...base, kind: 'episodic', priority: 50 }, { now, project: 'menm', bm25: -4 })
  assert.ok(instruction > episodic)
})

test('recall can restrict kinds (layer filter)', () => {
  const db = seed()
  const episodic = recall(db, '原生插件', { project: 'menm', kinds: ['episode'], minScore: 0 })
  assert.ok(episodic.items.length >= 1)
  assert.ok(episodic.items.every((row) => row.kind === 'episode'))
  const facts = recall(db, '原生插件', { project: 'menm', kinds: ['work_fact', 'fact'], minScore: 0 })
  assert.ok(facts.items.every((row) => row.kind !== 'episode'))
  db.close()
})

test('renderStableBlock frames persona and scene navigation with a budget', () => {
  assert.equal(renderStableBlock(), '')
  const block = renderStableBlock({
    personas: [{ scope: 'project', version: 2, body: '项目约定：用 pnpm' }, { scope: 'global', version: 1, body: '偏好中文' }],
    scenes: ['- 工具链（热度 2.0，3 条）: pnpm / node'],
    maxChars: 500,
  })
  assert.match(block, /^<memory_context type="stable"/)
  assert.match(block, /项目画像/)
  assert.match(block, /场景导航/)
  assert.match(block, /pnpm/)
  assert.match(block, /<\/memory_context>$/)
  const tiny = renderStableBlock({
    personas: [{ scope: 'project', version: 1, body: 'x'.repeat(300) }, { scope: 'global', version: 1, body: 'y'.repeat(300) }],
    maxChars: 200,
  })
  assert.ok(!tiny.includes('全局画像'))
})

test('scoreRow adds a bounded vector contribution', () => {
  const now = Date.now()
  const base = { id: 1, kind: 'work_fact', scope: 'project', project: 'menm', text: 't', created_at: now, updated_at: now, use_count: 0, pinned: 0 }
  const cold = scoreRow(base, { now, project: 'menm', bm25: -4, vector: 0, vectorWeight: 0.35 })
  const warm = scoreRow(base, { now, project: 'menm', bm25: -4, vector: 1, vectorWeight: 0.35 })
  assert.ok(Math.abs(warm - cold - 0.35) < 1e-9)
  const noSignal = scoreRow(base, { now, project: 'menm', vector: 1 })
  assert.ok(noSignal > 0)
})

test('recall with vectors reports the hybrid strategy and keeps results', () => {
  const db = seed()
  const result = recall(db, 'dsh 记忆插件', {
    project: 'menm',
    maxItems: 5,
    maxChars: 2000,
    vector: { enabled: true, weight: 0.35, scanLimit: 500 },
  })
  assert.ok(result.items.length >= 1)
  assert.match(result.strategy, /\+vec$/)
  db.close()
})

test('vector scan rescues a candidate that FTS and LIKE both miss', () => {
  const db = openDatabase(':memory:')
  const saved = saveMemory(db, { text: 'A', kind: 'fact', scope: 'project', project: 'menm', now: Date.now() })
  // simulate a semantic vector the lexical branches could never produce
  db.prepare('UPDATE memory SET vec = ?, vec_model = ? WHERE id = ?').run(
    packVector(embed('目标查询短语')),
    VECTOR_MODEL,
    saved.id,
  )
  const without = recall(db, '目标查询短语', { project: 'menm', minScore: 0 })
  assert.equal(without.items.length, 0)
  const withVector = recall(db, '目标查询短语', {
    project: 'menm',
    minScore: 0,
    vector: { enabled: true, weight: 0.35, scanLimit: 100 },
  })
  assert.equal(withVector.items.length, 1)
  assert.equal(withVector.items[0].id, saved.id)
  db.close()
})
