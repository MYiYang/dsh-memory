import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../src/store.js'
import { applyDecision } from '../src/l1.js'
import {
  EXTRACT_LIMITS,
  applyDecisions,
  buildDedupePrompt,
  buildExtractionPrompt,
  extractJsonSlice,
  normalizeMemoryItem,
  parseDedupe,
  parseExtraction,
  parseJsonLoose,
  repairJson,
  stripNoise,
  withCandidates,
} from '../src/extract.js'

function memoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

test('stripNoise removes reasoning blocks and markdown fences', () => {
  const raw = '前言<think>internal</think>\n```json\n{"memories":[]}\n```\n结束'
  const cleaned = stripNoise(raw).replace(/\n{2,}/g, '\n')
  assert.equal(cleaned, '前言\n{"memories":[]}\n结束')
})

test('extractJsonSlice is string-aware and repairJson fixes usual slips', () => {
  const text = 'ok {"memories":[{"text":"a { b }","priority":60,},]} done'
  assert.equal(extractJsonSlice(text), '{"memories":[{"text":"a { b }","priority":60,},]}')
  const repaired = repairJson("{'a': 1, priority: 70,}")
  assert.equal(JSON.parse(repaired).priority, 70)
  assert.equal(parseJsonLoose('garbage only'), null)
})

test('parseExtraction normalizes kinds, clamps priority, clips text and dedupes', () => {
  const long = 'x'.repeat(EXTRACT_LIMITS.text + 50)
  const raw = JSON.stringify({
    memories: [
      { kind: 'persona', text: '偏好 pwsh', priority: 150, scene: '工具链' },
      { kind: 'bogus', text: '未知类型', priority: -3 },
      { kind: 'work_fact', text: long, priority: 60 },
      { kind: 'work_fact', text: '偏好 pwsh', priority: 10 },
      { kind: '', text: '   ', priority: 50 },
    ],
  })
  const result = parseExtraction(raw)
  assert.equal(result.reason, 'ok')
  assert.equal(result.memories.length, 3)
  assert.equal(result.memories[0].kind, 'persona')
  assert.equal(result.memories[0].priority, 100)
  assert.equal(result.memories[1].kind, 'work_fact')
  assert.equal(result.memories[1].priority, 0)
  assert.equal(result.memories[2].text.length, EXTRACT_LIMITS.text)
  assert.equal(result.memories.filter((m) => m.text === '偏好 pwsh').length, 1)
})

test('parseExtraction reports closed reasons for empty, parse and filtered outputs', () => {
  assert.deepEqual(parseExtraction('{"memories":[]}'), { memories: [], reason: 'empty' })
  assert.deepEqual(parseExtraction('sorry, no json here'), { memories: [], reason: 'parse' })
  assert.deepEqual(parseExtraction('{"memories":[{"text":""}]}'), { memories: [], reason: 'filtered' })
})

test('parseExtraction enforces the batch cap', () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({ kind: 'work_fact', text: `事实 ${i}` }))
  const result = parseExtraction(JSON.stringify({ memories }), { maxMemories: 3 })
  assert.equal(result.memories.length, 3)
})

test('buildExtractionPrompt wraps the transcript and states the cap', () => {
  const prompt = buildExtractionPrompt('用户: 你好\n助手: 你好', { maxMemories: 4 })
  assert.match(prompt.system, /只输出 JSON/)
  assert.match(prompt.user, /<conversation>/)
  assert.match(prompt.user, /最多抽取 4 条/)
})

test('parseDedupe validates ops and drops out-of-range indexes', () => {
  const raw = JSON.stringify([
    { i: 0, op: 'update', target_id: '12', text: '新文本' },
    { i: 1, op: 'merge', target_id: 5, merge_ids: [6, 'x', 7] },
    { i: 9, op: 'store' },
    { i: 2, op: 'explode' },
    { i: -1, op: 'store' },
  ])
  const decisions = parseDedupe(raw, 3)
  assert.equal(decisions.length, 2)
  assert.deepEqual(decisions[0], { index: 0, op: 'update', targetId: 12, mergeIds: [], text: '新文本' })
  assert.deepEqual(decisions[1], { index: 1, op: 'merge', targetId: 5, mergeIds: [6, 7], text: null })
})

test('buildDedupePrompt groups new facts with their candidates', () => {
  const prompt = buildDedupePrompt([
    { fact: { kind: 'work_fact', text: '用 pnpm', priority: 70, scene: null }, candidates: [{ id: 7, kind: 'work_fact', text: '用 pnpm 构建' }] },
  ])
  assert.match(prompt.system, /记忆去重器/)
  assert.match(prompt.user, /"candidates":\[\{"id":7/)
})

test('applyDecisions falls back to heuristics and applies explicit merge', () => {
  const db = memoryDb()
  const seed = applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目使用 Node 24 与 pnpm' }, { project: 'menm', now: 1 })
  const other = applyDecision(db, { op: 'store', kind: 'work_fact', text: '构建命令是 pnpm build' }, { project: 'menm', now: 2 })

  const plan = withCandidates(db, [
    { kind: 'work_fact', text: '项目使用 Node 24 与 pnpm 构建', priority: 70, scene: '工具链' },
    { kind: 'work_fact', text: '数据库是 MySQL 8.0', priority: 60, scene: '数据库' },
  ], { project: 'menm' })
  assert.ok(plan[0].candidates.length >= 1)
  assert.equal(plan[1].candidates.length, 0)

  const summary = applyDecisions(db, plan, [
    { index: 0, op: 'update', targetId: seed.id, mergeIds: [], text: '项目使用 Node 24 与 pnpm 构建' },
    { index: 1, op: 'merge', targetId: other.id, mergeIds: [seed.id], text: '数据库是 MySQL 8.0' },
  ], { project: 'menm', now: 10 })
  assert.equal(summary.update, 1)
  assert.equal(summary.merge, 1)
  const merged = db.prepare('SELECT * FROM memory WHERE id = ?').get(other.id)
  assert.equal(merged.text, '数据库是 MySQL 8.0')
  assert.equal(merged.version, 2)
  const absorbed = db.prepare('SELECT superseded_by FROM memory WHERE id = ?').get(seed.id)
  assert.equal(absorbed.superseded_by, other.id)
})

test('normalizeMemoryItem rejects empty or non-object entries', () => {
  assert.equal(normalizeMemoryItem(null), null)
  assert.equal(normalizeMemoryItem({ text: '   ' }), null)
  assert.equal(normalizeMemoryItem({ text: 'ok', kind: 'work_task', priority: 42 }).priority, 42)
})
