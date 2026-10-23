import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, getMeta, setMeta } from '../src/store.js'
import { applyDecision } from '../src/l1.js'
import { getPersona, listScenes, putPersona, upsertScene } from '../src/profile.js'
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

/** A fake whose answers are whole response objects (for ok:false / max-tokens cases). */
function fakeLlmSeq(responses) {
  const calls = []
  return {
    available: true,
    calls,
    async complete(request) {
      calls.push(request)
      const next = responses.shift() ?? { ok: true, text: '{}', usage: null }
      return { ok: false, text: '', reason: null, error: null, usage: null, ...next }
    },
  }
}

function fact(db, text, { kind = 'work_fact', scene = null, priority = 60, project = 'menm', scope, now = 1 } = {}) {
  return applyDecision(db, { op: 'store', kind, text, priority, scene }, { project, now, scope })
}

test('runScenes rewrites a scene once its facts are enough, then skips unchanged sets', async () => {
  const db = setup()
  fact(db, '用 pnpm build 构建', { scene: '工具链' })
  fact(db, 'Node 版本 24', { scene: '工具链' })
  fact(db, '数据库是 MySQL 8.0', { scene: '数据库' })
  const llm = fakeLlm([JSON.stringify({ summary: 'pnpm 与 Node 24', body: '## 要点\n- pnpm build' })])
  const first = await runScenes(db, llm, { minFacts: 2 }, { project: 'menm', now: 2 })
  assert.deepEqual(first, { updated: 1, skipped: 1, pruned: 0 })
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
  assert.equal(getMeta(db, 'l3-batches:menm'), '0')
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
  assert.equal(getMeta(db, 'l3-batches:menm'), '0')
})

test('prompt builders include existing content and bounded fact lines', () => {
  const scenePrompt = buildScenePrompt('工具链', [{ kind: 'work_fact', text: '用 pnpm' }], { summary: '旧摘要' })
  assert.match(scenePrompt.user, /场景：工具链/)
  assert.match(scenePrompt.user, /现有摘要：旧摘要/)
  const personaPrompt = buildPersonaPrompt([{ kind: 'persona', scope: 'global', text: '中文' }], { body: '旧画像' }, 800)
  assert.match(personaPrompt.user, /现有画像：/)
  assert.match(personaPrompt.user, /不超过 800 字/)
  assert.match(personaPrompt.user, /目标画像：项目画像/)
  const globalPrompt = buildPersonaPrompt([{ kind: 'persona', scope: 'global', text: '中文' }], {}, 800, 'global')
  assert.match(globalPrompt.user, /目标画像：全局画像/)
  assert.doesNotMatch(globalPrompt.system, /项目画像/)
})

test('runScenes prunes past maxScenes even when the batch rewrote nothing', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '热场景', heatDelta: 9, now: 1 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '温场景', heatDelta: 4, now: 1 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '冷场景', heatDelta: 0, now: 1 })
  const llm = fakeLlm([])
  const result = await runScenes(db, llm, { minFacts: 2, maxScenes: 2 }, { project: 'menm', now: 2 })
  assert.deepEqual(result, { updated: 0, skipped: 0, pruned: 1 })
  assert.equal(llm.calls.length, 0)
  const names = listScenes(db, { project: 'menm', now: 2 }).map((row) => row.name)
  assert.equal(names.length, 2)
  assert.ok(names.includes('热场景'))
  assert.ok(!names.includes('冷场景'))
})

test('runScenes prunes the global bucket separately from the project bucket', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '项目场景', now: 1 })
  upsertScene(db, { scope: 'global', project: null, name: '全局热', heatDelta: 9, now: 1 })
  upsertScene(db, { scope: 'global', project: null, name: '全局冷', now: 1 })
  const llm = fakeLlm([])
  const result = await runScenes(db, llm, { minFacts: 2, maxScenes: 1 }, { project: 'menm', now: 2 })
  assert.equal(result.pruned, 1) // one global row; the single project scene stays
  assert.ok(listScenes(db, { project: 'menm', now: 2 }).some((row) => row.name === '项目场景'))
  assert.ok(!listScenes(db, { project: 'menm', now: 2 }).some((row) => row.name === '全局冷'))
})

test('runPersona(global) reads only global facts and leaves the project persona alone', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90, scope: 'global' })
  fact(db, '项目用 pnpm 构建')
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  const llm = fakeLlm([JSON.stringify({ body: '## 用户偏好\n- 中文' })])
  const result = await runPersona(db, llm, { triggerEveryN: 10, maxChars: 500 }, { scope: 'global', project: 'menm', now: 2 })
  assert.equal(result.rewritten, true)
  assert.equal(result.version, 1)
  assert.equal(llm.calls.length, 1)
  assert.match(llm.calls[0].user, /目标画像：全局画像/)
  assert.match(llm.calls[0].user, /用户偏好中文回答/)
  assert.doesNotMatch(llm.calls[0].user, /项目用 pnpm 构建/)
  assert.equal(getPersona(db, { scope: 'global' }).body, '## 用户偏好\n- 中文')
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, '## 项目约定\n- pnpm')
  assert.equal(getMeta(db, 'l3-batches:@global'), '0')
  assert.equal(getMeta(db, 'l3-batches:menm'), undefined)
})

test('global and project persona batch counters advance independently', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90, scope: 'global' })
  fact(db, '项目用 pnpm 构建')
  putPersona(db, { scope: 'global', body: '## 用户偏好\n- 中文', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  const llm = fakeLlm([JSON.stringify({ decision: 'none' })])
  const firstGlobal = await runPersona(db, llm, { triggerEveryN: 3 }, { scope: 'global', now: 2 })
  const firstProject = await runPersona(db, llm, { triggerEveryN: 3 }, { project: 'menm', now: 2 })
  assert.equal(firstGlobal.reason, 'deferred')
  assert.equal(firstProject.reason, 'deferred')
  await runPersona(db, llm, { triggerEveryN: 3 }, { scope: 'global', now: 3 })
  assert.equal(getMeta(db, 'l3-batches:@global'), '2')
  assert.equal(getMeta(db, 'l3-batches:menm'), '1')
  const gated = await runPersona(db, llm, { triggerEveryN: 3 }, { scope: 'global', now: 4 })
  assert.equal(gated.reason, 'gate:none')
  assert.equal(llm.calls.length, 1) // the gate ran once, for the global persona only
  assert.equal(getMeta(db, 'l3-batches:menm'), '1')
})

test('a project persona without a project key is refused instead of writing a ghost row', async () => {
  const db = setup()
  fact(db, '项目用 pnpm 构建')
  const llm = fakeLlm([JSON.stringify({ body: '## 项目约定\n- pnpm' })])
  const result = await runPersona(db, llm, { triggerEveryN: 10 }, { now: 2 })
  assert.deepEqual(result, { rewritten: false, reason: 'no-project' })
  assert.equal(llm.calls.length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM l3_persona').get().n, 0)
  assert.equal(getMeta(db, 'l3-batches:global'), undefined)
  assert.equal(getMeta(db, 'l3-batches:@global'), undefined)
})

test('runScenes remembers a pruned scene and only rebuilds it on fresh evidence', async () => {
  const db = setup()
  // 工具链 is pre-seeded so it is hotter than the new 数据库 scene: with
  // maxScenes=1 the cap evicts 数据库, the scene written last in the batch.
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', heatDelta: 5, now: 1 })
  fact(db, '用 pnpm build 构建', { scene: '工具链', priority: 70 })
  fact(db, 'Node 版本 24', { scene: '工具链', priority: 70 })
  fact(db, '数据库是 MySQL 8.0', { scene: '数据库' })
  fact(db, '连接池大小 10', { scene: '数据库' })
  const llm = fakeLlm([
    JSON.stringify({ summary: '工具链摘要', body: '## 工具链' }),
    JSON.stringify({ summary: '数据库摘要', body: '## 数据库' }),
    JSON.stringify({ summary: '数据库新摘要', body: '## 数据库 v2' }),
  ])

  const first = await runScenes(db, llm, { minFacts: 2, maxScenes: 1 }, { project: 'menm', now: 2 })
  assert.deepEqual(first, { updated: 2, skipped: 0, pruned: 1 })
  assert.equal(llm.calls.length, 2)
  assert.deepEqual(listScenes(db, { project: 'menm', now: 2 }).map((row) => row.name), ['工具链'])
  const marker = JSON.parse(getMeta(db, 'l2-evicted:menm'))
  assert.deepEqual(Object.keys(marker), ['数据库'])
  assert.equal(marker['数据库'], 2)

  // Second batch, same facts: the evicted scene must not cost an LLM call.
  const second = await runScenes(db, llm, { minFacts: 2, maxScenes: 1 }, { project: 'menm', now: 3 })
  assert.deepEqual(second, { updated: 0, skipped: 2, pruned: 0 })
  assert.equal(llm.calls.length, 2)
  assert.equal(listScenes(db, { project: 'menm', now: 3 }).length, 1)

  // A newer fact is fresh evidence: the scene is rebuilt and the marker cleared.
  fact(db, '只读副本用于报表', { scene: '数据库', priority: 40, now: 4 })
  const third = await runScenes(db, llm, { minFacts: 2, maxScenes: 2 }, { project: 'menm', now: 5 })
  assert.deepEqual(third, { updated: 1, skipped: 1, pruned: 0 })
  assert.equal(llm.calls.length, 3)
  const rebuilt = listScenes(db, { project: 'menm', now: 5 }).find((row) => row.name === '数据库')
  assert.equal(rebuilt.summary, '数据库新摘要')
  assert.equal(rebuilt.fact_count, 3)
  assert.equal(getMeta(db, 'l2-evicted:menm'), undefined)
})

test('an expired eviction marker does not block the rebuild forever', async () => {
  const db = setup()
  fact(db, '用 pnpm build 构建', { scene: '工具链' })
  fact(db, 'Node 版本 24', { scene: '工具链' })
  // Evicted 91 days ago: older than the 90-day retention of the marker.
  setMeta(db, 'l2-evicted:menm', JSON.stringify({ 工具链: 1 }))
  const llm = fakeLlm([JSON.stringify({ summary: '摘要', body: '正文' })])
  const now = 1 + 91 * 86_400_000
  const result = await runScenes(db, llm, { minFacts: 2 }, { project: 'menm', now })
  assert.equal(result.updated, 1)
  assert.equal(llm.calls.length, 1)
  assert.equal(getMeta(db, 'l2-evicted:menm'), undefined)
})

test('the eviction marker keeps the newest 200 entries and drops the oldest', async () => {
  const db = setup()
  /** @type {Record<string, number>} */
  const marker = {}
  for (let i = 0; i < 200; i++) marker[`场景${String(i).padStart(3, '0')}`] = 1_000 + i
  setMeta(db, 'l2-evicted:menm', JSON.stringify(marker))
  upsertScene(db, { scope: 'project', project: 'menm', name: '热场景', heatDelta: 9, now: 1 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '冷场景', now: 1 })
  const llm = fakeLlm([])
  const result = await runScenes(db, llm, { minFacts: 2, maxScenes: 1 }, { project: 'menm', now: 2_000 })
  assert.equal(result.pruned, 1)
  const stored = JSON.parse(getMeta(db, 'l2-evicted:menm'))
  assert.equal(Object.keys(stored).length, 200)
  assert.equal(stored['场景000'], undefined)
  assert.equal(stored['场景001'], 1_001)
  assert.equal(stored['冷场景'], 2_000)
})

test('an oversized persona is compacted on the spot, without asking the gate', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  // 300 chars against a 120-char target: 1.4× bloat, so the batch count and the
  // gate are both irrelevant — the profile does not fit the stable block.
  putPersona(db, { scope: 'project', project: 'menm', body: '长'.repeat(300), now: 1 })
  const llm = fakeLlm([JSON.stringify({ body: '## 用户偏好\n- 中文' })])
  const result = await runPersona(db, llm, { triggerEveryN: 50, maxChars: 600, targetChars: 120 }, { project: 'menm', now: 2 })
  assert.equal(result.rewritten, true)
  assert.equal(result.version, 2)
  assert.equal(llm.calls.length, 1) // rewrite only: no gate call
  assert.match(llm.calls[0].user, /约 120 字/)
  assert.match(llm.calls[0].user, /硬上限 600 字/)
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, '## 用户偏好\n- 中文')

  // A persona inside the bloat band still goes through the normal gate path.
  const gatedLlm = fakeLlm([JSON.stringify({ decision: 'none' })])
  const gated = await runPersona(db, gatedLlm, { triggerEveryN: 50, maxChars: 600, targetChars: 120 }, { project: 'menm', now: 3 })
  assert.equal(gated.reason, 'deferred')
})

test('the persona prompt asks for the target length and forbids duplication', () => {
  const prompt = buildPersonaPrompt([{ kind: 'work_fact', text: '用 pnpm' }], { body: '旧画像' }, { maxChars: 900, targetChars: 400 })
  assert.match(prompt.user, /约 400 字/)
  assert.match(prompt.user, /硬上限 900 字/)
  assert.match(prompt.user, /压缩要求/)
  // Without a target the old contract still holds.
  assert.match(buildPersonaPrompt([], {}, 800).user, /不超过 800 字/)
})

test('force rewrites the persona regardless of the batch threshold', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 用户偏好\n- 中文', now: 1 })
  const llm = fakeLlm([JSON.stringify({ body: '## 用户偏好\n- 中文（强制）' })])
  const result = await runPersona(db, llm, { triggerEveryN: 50, force: true }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'written')
  assert.equal(result.version, 2)
  assert.equal(llm.calls.length, 1) // no gate call
  assert.equal(getMeta(db, 'l3-last-reason'), 'menm:written')
  assert.match(getMeta(db, 'l3-last-detail'), /"forced":true/)
})

test('an unusable persona answer is recorded instead of failing silently', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 用户偏好\n- 中文', now: 1 })
  const llm = fakeLlm(['这段不是 JSON'])
  const result = await runPersona(db, llm, { force: true }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'empty')
  assert.equal(getMeta(db, 'l3-last-reason'), 'menm:empty')
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  // Three escalating attempts, all recorded: the diagnosis must survive the call.
  assert.equal(detail.attempts.length, 3)
  assert.equal(detail.attempts[0].effort, 'low')
  assert.ok(detail.attempts[1].tokens > detail.attempts[0].tokens)
  assert.equal(detail.attempts[2].effort, 'default')
  // The old persona must survive a failed rewrite untouched.
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, '## 用户偏好\n- 中文')
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).version, 1)
})

test('an empty max-tokens answer is retried with a bigger budget', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  const llm = fakeLlmSeq([
    { ok: false, text: '', reason: 'max-tokens', error: null, usage: { inputTokens: 7, outputTokens: 0 } },
    { ok: true, text: JSON.stringify({ body: '## 用户偏好\n- 中文' }), usage: { inputTokens: 7, outputTokens: 5 } },
  ])
  const result = await runPersona(db, llm, { force: true, personaMaxTokens: 400 }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'written')
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].reasoningEffort, 'low')
  assert.ok(llm.calls[1].maxTokens > llm.calls[0].maxTokens)
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.attempts.length, 2)
  assert.equal(detail.attempts[0].finish, 'max-tokens')
  // Retry accounting: both calls' usage landed on the shared counter.
  assert.equal(getMeta(db, 'l1_tokens_total'), '19')
})
