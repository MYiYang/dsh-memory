import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, getMeta, setMeta } from '../src/store.js'
import { applyDecision } from '../src/l1.js'
import { getPersona, listScenes } from '../src/profile.js'
import { buildPersonaPrompt, buildScenePrompt, runPersona, runScenes } from '../src/consolidate.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function fakeLlm(texts) {
  const calls = []
  return {
    available: true,
    calls,
    async complete(request) {
      calls.push(request)
      const text = texts.shift() ?? '{}'
      return { ok: true, text, usage: { inputTokens: 5, outputTokens: 3 } }
    },
  }
}

function fact(db, text, { kind = 'work_fact', scene = null, priority = 60, project = 'menm' } = {}) {
  return applyDecision(db, { op: 'store', kind, text, priority, scene }, { project, now: 1 })
}

test('runScenes rewrites a scene once its facts are enough, then skips unchanged sets', async () => {
  const db = setup()
  fact(db, '用 pnpm build 构建', { scene: '工具链' })
  fact(db, 'Node 版本 24', { scene: '工具链' })
  fact(db, '数据库是 MySQL 8.0', { scene: '数据库' })
  const llm = fakeLlm([JSON.stringify({ summary: 'pnpm 与 Node 24', body: '## 要点\n- pnpm build' })])
  const first = await runScenes(db, llm, { minFacts: 2 }, { project: 'menm', now: 2 })
  assert.deepEqual(first, { updated: 1, skipped: 1 })
  const scenes = listScenes(db, { project: 'menm', now: 2 })
  assert.equal(scenes.length, 1)
  assert.equal(scenes[0].name, '工具链')
  assert.equal(scenes[0].fact_count, 2)
  assert.equal(scenes[0].summary, 'pnpm 与 Node 24')

  const second = await runScenes(db, llm, { minFacts: 2 }, { project: 'menm', now: 3 })
  assert.equal(second.updated, 0)
  assert.equal(llm.calls.length, 1)
  assert.match(llm.calls[0].user, /场景：工具链/)
})

test('runScenes tolerates a bad model answer and leaves the old scene intact', async () => {
  const db = setup()
  fact(db, '用 pnpm build 构建', { scene: '工具链' })
  fact(db, 'Node 版本 24', { scene: '工具链' })
  const llm = fakeLlm(['not json at all'])
  const result = await runScenes(db, llm, { minFacts: 1 }, { project: 'menm', now: 2 })
  assert.equal(result.updated, 0)
  assert.equal(listScenes(db, { project: 'menm', now: 2 }).length, 0)
})

test('runPersona generates the first persona without a gate call', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  fact(db, '项目用 pnpm', { kind: 'work_fact' })
  const llm = fakeLlm([JSON.stringify({ body: '## 用户偏好\n- 中文\n## 环境与工具\n- pnpm' })])
  const result = await runPersona(db, llm, { triggerEveryN: 10, maxChars: 500 }, { project: 'menm', now: 2 })
  assert.equal(result.rewritten, true)
  assert.equal(result.version, 1)
  assert.equal(llm.calls.length, 1)
  const persona = getPersona(db, { scope: 'project', project: 'menm' })
  assert.match(persona.body, /pnpm/)
  assert.equal(getMeta(db, 'l3-batches'), '0')
})

test('runPersona defers until triggerEveryN and only rewrites on a gate conflict', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  const llm = fakeLlm([
    JSON.stringify({ body: '## 用户偏好\n- 中文' }), // initial persona
    JSON.stringify({ decision: 'none' }), // gate after threshold
    JSON.stringify({ decision: 'conflict' }), // gate keeps the old persona
    JSON.stringify({ body: '## 用户偏好\n- 中文（偶尔英文）' }),
  ])
  await runPersona(db, llm, { triggerEveryN: 3, maxChars: 500 }, { project: 'menm', now: 2 })
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).version, 1)

  const deferred1 = await runPersona(db, llm, { triggerEveryN: 3 }, { project: 'menm', now: 3 })
  assert.equal(deferred1.reason, 'deferred')
  const deferred2 = await runPersona(db, llm, { triggerEveryN: 3 }, { project: 'menm', now: 4 })
  assert.equal(deferred2.reason, 'deferred')

  const gatedNone = await runPersona(db, llm, { triggerEveryN: 3 }, { project: 'menm', now: 5 })
  assert.equal(gatedNone.reason, 'gate:none')
  const gatedConflict = await runPersona(db, llm, { triggerEveryN: 3 }, { project: 'menm', now: 6 })
  assert.equal(gatedConflict.rewritten, true)
  assert.equal(gatedConflict.version, 2)
  assert.match(getPersona(db, { scope: 'project', project: 'menm' }).body, /偶尔英文/)
  assert.equal(getMeta(db, 'l3-batches'), '0')
})

test('prompt builders include existing content and bounded fact lines', () => {
  const scenePrompt = buildScenePrompt('工具链', [{ kind: 'work_fact', text: '用 pnpm' }], { summary: '旧摘要' })
  assert.match(scenePrompt.user, /场景：工具链/)
  assert.match(scenePrompt.user, /现有摘要：旧摘要/)
  const personaPrompt = buildPersonaPrompt([{ kind: 'persona', scope: 'global', text: '中文' }], { body: '旧画像' }, 800)
  assert.match(personaPrompt.user, /现有画像：/)
  assert.match(personaPrompt.user, /不超过 800 字/)
})
