import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, getMeta, stats } from '../src/store.js'
import { appendTurn, getCursor, pendingCount } from '../src/l0.js'
import { applyDecision } from '../src/l1.js'
import { createPipeline } from '../src/pipeline.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function fakeLlm(responses) {
  const calls = []
  return {
    available: true,
    calls,
    async complete(request) {
      calls.push(request)
      const next = responses.length > 1 ? responses.shift() : responses[0]
      await Promise.resolve()
      return typeof next === 'function' ? next(request) : next
    },
  }
}

function seedTurn(db, turn, user = `u${turn}`, assistant = `a${turn}`) {
  return appendTurn(db, { sessionId: 's1', turn, project: 'menm', userText: user, assistantText: assistant, toolNames: ['read'] }, turn)
}

test('one batch stores extracted facts, marks L0 and resets the cursor', async () => {
  const db = setup()
  seedTurn(db, 1, '给项目加构建脚本', '用 pnpm build')
  const llm = fakeLlm([
    { ok: true, text: JSON.stringify({ memories: [{ kind: 'work_fact', text: '项目用 pnpm build 构建', priority: 70, scene: '工具链' }] }), usage: { inputTokens: 10, outputTokens: 5 } },
  ])
  const pipeline = createPipeline({ db, llm, log: () => {} })
  const result = await pipeline.runNow('s1')
  assert.equal(result.summary.store, 1)
  assert.equal(pendingCount(db, 's1'), 0)
  assert.equal(getCursor(db, 's1').sinceExtract, 0)
  assert.equal(getMeta(db, 'l1-last-reason'), 'ok')
  assert.equal(Number(getMeta(db, 'l1_tokens_total')), 15)
  const fact = db.prepare('SELECT * FROM memory').get()
  assert.equal(fact.kind, 'work_fact')
  assert.equal(fact.priority, 70)
  assert.equal(fact.scene, '工具链')
  assert.equal(fact.project, 'menm')
  assert.equal(llm.calls.length, 1)
})

test('a fact overlapping an existing row goes through the dedupe call and updates it', async () => {
  const db = setup()
  const seeded = applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目用 pnpm build 构建' }, { project: 'menm', now: 1 })
  seedTurn(db, 2, '构建脚本改成什么了', '还是 pnpm build')
  const llm = fakeLlm([
    { ok: true, text: JSON.stringify({ memories: [{ kind: 'work_fact', text: '项目用 pnpm build 构建，CI 也是', priority: 80, scene: '工具链' }] }), usage: { inputTokens: 10, outputTokens: 5 } },
    { ok: true, text: JSON.stringify([{ i: 0, op: 'update', target_id: seeded.id, text: '项目用 pnpm build 构建，CI 也是' }]), usage: { inputTokens: 8, outputTokens: 4 } },
  ])
  const pipeline = createPipeline({ db, llm, log: () => {} })
  const result = await pipeline.runNow('s1')
  assert.equal(result.summary.update, 1)
  assert.equal(llm.calls.length, 2)
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(seeded.id)
  assert.equal(row.version, 2)
  assert.match(row.text, /CI 也是/)
})

test('unparseable model output is retried and discarded after maxAttempts', async () => {
  const db = setup()
  seedTurn(db, 1, 'u', 'a')
  const llm = fakeLlm([{ ok: true, text: 'sorry, I cannot do that', usage: null }])
  const pipeline = createPipeline({ db, llm, log: () => {}, config: { extraction: { maxAttempts: 3 } } })
  await pipeline.runNow('s1')
  assert.equal(pendingCount(db, 's1'), 1)
  assert.equal(getMeta(db, 'l1-last-reason'), 'parse')
  await pipeline.runNow('s1')
  assert.equal(pendingCount(db, 's1'), 1)
  await pipeline.runNow('s1')
  assert.equal(pendingCount(db, 's1'), 0)
  assert.ok(getMeta(db, 'l1-last-discarded'))
})

test('llm failures bump attempts and leave turns pending for a later retry', async () => {
  const db = setup()
  seedTurn(db, 1, 'u', 'a')
  const llm = { available: true, calls: [], complete: async () => ({ ok: false, error: 'timeout', text: '', usage: null }) }
  const pipeline = createPipeline({ db, llm, log: () => {} })
  const result = await pipeline.runNow('s1')
  assert.equal(result.skipped, true)
  assert.equal(pendingCount(db, 's1'), 1)
  assert.equal(getMeta(db, 'l1-last-reason'), 'timeout')
  const row = db.prepare('SELECT extract_attempts FROM l0_turns').get()
  assert.equal(row.extract_attempts, 1)
})

test('an unavailable llm is a no-op, not an error', async () => {
  const db = setup()
  seedTurn(db, 1, 'u', 'a')
  const llm = { available: false, complete: async () => ({ ok: false }) }
  const pipeline = createPipeline({ db, llm, log: () => {} })
  const result = await pipeline.runNow('s1')
  assert.equal(result.reason, 'llm-unavailable')
  assert.equal(pendingCount(db, 's1'), 1)
})

test('schedule collapses duplicate session requests into one job', async () => {
  const db = setup()
  seedTurn(db, 1, 'u', 'a')
  let calls = 0
  const llm = {
    available: true,
    calls: [],
    async complete() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ok: true, text: JSON.stringify({ memories: [{ kind: 'work_fact', text: '事实一' }] }), usage: null }
    },
  }
  const pipeline = createPipeline({ db, llm, log: () => {} })
  pipeline.schedule('s1', 'threshold')
  pipeline.schedule('s1', 'idle')
  pipeline.schedule('s1', 'manual')
  await pipeline.flush()
  assert.equal(calls, 1)
  assert.equal(stats(db).total, 1)
})

test('dispose stops accepting jobs', async () => {
  const db = setup()
  seedTurn(db, 1, 'u', 'a')
  const llm = fakeLlm([{ ok: true, text: '{"memories":[]}' }])
  const pipeline = createPipeline({ db, llm, log: () => {} })
  pipeline.dispose()
  pipeline.schedule('s1')
  await pipeline.flush()
  assert.equal(llm.calls.length, 0)
  assert.equal(pendingCount(db, 's1'), 1)
})
