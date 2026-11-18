import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, getMeta, setMeta } from '../src/store.js'
import { applyDecision } from '../src/l1.js'
import { getPersona, listScenes, putPersona, upsertScene } from '../src/profile.js'
import { CONSOLIDATE_LIMITS, JEV_CRITERIA, factsByScene, readGateStats, readPatchStats, applyPersonaPatch, resolveDecisionApiKey, runPersona, runScenes, trimPersonaBody, buildPersonaPrompt, buildScenePrompt } from '../src/consolidate.js'
import { registerDecisionProvider, resetDecisionProviders } from '../src/decision.js'

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
  const legacy = { triggerMode: 'legacy', triggerEveryN: 3, maxChars: 500 }
  await runPersona(db, llm, legacy, { project: 'menm', now: 2 })
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).version, 1)

  const deferred1 = await runPersona(db, llm, legacy, { project: 'menm', now: 3 })
  assert.equal(deferred1.reason, 'deferred')
  const deferred2 = await runPersona(db, llm, legacy, { project: 'menm', now: 4 })
  assert.equal(deferred2.reason, 'deferred')

  const gatedNone = await runPersona(db, llm, legacy, { project: 'menm', now: 5 })
  assert.equal(gatedNone.reason, 'gate:none')
  const gatedConflict = await runPersona(db, llm, legacy, { project: 'menm', now: 6 })
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
  const legacy = { triggerMode: 'legacy', triggerEveryN: 3 }
  const firstGlobal = await runPersona(db, llm, legacy, { scope: 'global', now: 2 })
  const firstProject = await runPersona(db, llm, legacy, { project: 'menm', now: 2 })
  assert.equal(firstGlobal.reason, 'deferred')
  assert.equal(firstProject.reason, 'deferred')
  await runPersona(db, llm, legacy, { scope: 'global', now: 3 })
  assert.equal(getMeta(db, 'l3-batches:@global'), '2')
  assert.equal(getMeta(db, 'l3-batches:menm'), '1')
  const gated = await runPersona(db, llm, legacy, { scope: 'global', now: 4 })
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
  assert.match(llm.calls[0].user, /长度硬性上限：120 字/)
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, '## 用户偏好\n- 中文')

  // A persona inside the bloat band still goes through the normal gate path.
  const gatedLlm = fakeLlm([JSON.stringify({ decision: 'none' })])
  const gated = await runPersona(
    db,
    gatedLlm,
    { triggerMode: 'legacy', triggerEveryN: 50, maxChars: 600, targetChars: 120 },
    { project: 'menm', now: 3 },
  )
  assert.equal(gated.reason, 'deferred')
})

test('the persona prompt asks for the target length and forbids duplication', () => {
  const prompt = buildPersonaPrompt([{ kind: 'work_fact', text: '用 pnpm' }], { body: '旧画像' }, { maxChars: 900, targetChars: 400 })
  assert.match(prompt.user, /长度硬性上限：400 字/)
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

test('an over-long persona is compressed by a second call before any trimming', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  const long = ['## 项目定位', ...Array.from({ length: 20 }, (_, i) => `- 很长的背景说明 ${i}`)].join('\n')
  const short = '## 项目定位\n- 短内容'
  const llm = fakeLlm([JSON.stringify({ body: long }), JSON.stringify({ body: short })])
  const result = await runPersona(db, llm, { force: true, targetChars: 60, maxChars: 400 }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'written')
  assert.equal(llm.calls.length, 2) // generate + compress
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, short)
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.trimmed, false)
  assert.equal(detail.attempts[detail.attempts.length - 1].stage, 'compress')
})

test('trimPersonaBody cuts at a line boundary and marks the cut', () => {
  const body = ['## 用户偏好', '- 第一条偏好', '- 第二条偏好', '- 第三条偏好'].join('\n')
  const full = trimPersonaBody(body, 200)
  assert.deepEqual(full, { text: body, trimmed: false })
  const cut = trimPersonaBody(body, 22)
  assert.equal(cut.trimmed, true)
  assert.ok(cut.text.length <= 22)
  assert.ok(cut.text.startsWith('## 用户偏好'))
  assert.ok(cut.text.endsWith('…'))
  // A single line longer than the limit still yields something bounded.
  assert.ok(trimPersonaBody('长'.repeat(50), 10).text.length <= 10)
  assert.equal(trimPersonaBody('   ', 10).text, '')
})

test('trimPersonaBody keeps every section instead of cutting the tail off', () => {
  const body = [
    '## 项目定位',
    '- 定位一', '- 定位二', '- 定位三',
    '## 架构',
    '- 架构一', '- 架构二',
    '## 操作约定',
    '- 约定一', '- 约定二',
  ].join('\n')
  const cut = trimPersonaBody(body, 45)
  assert.equal(cut.trimmed, true)
  assert.ok(cut.text.length <= 45)
  // Sections that sit at the end must survive: they carry the operational rules.
  for (const header of ['## 项目定位', '## 架构', '## 操作约定']) assert.ok(cut.text.includes(header))
})

test('an over-long persona answer is trimmed to the target before it is stored', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  // The live model wrote 2600 chars when asked for ~700; the stored row must not.
  const long = ['## 用户偏好', ...Array.from({ length: 40 }, (_, i) => `- 第 ${i + 1} 条偏好说明`)].join('\n')
  const llm = fakeLlm([JSON.stringify({ body: long })])
  const result = await runPersona(db, llm, { force: true, targetChars: 120, maxChars: 600 }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'written')
  const stored = getPersona(db, { scope: 'project', project: 'menm' })
  assert.ok(stored.body.length <= 120, `stored ${stored.body.length} chars`)
  assert.ok(stored.body.startsWith('## 用户偏好'))
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.trimmed, true)
  assert.ok(detail.rawChars > detail.chars)
})

// ── default mode: trigger based on the last real write (upstream parity) ─────

test('default mode writes on cold start, then stays quiet below the fact threshold', async () => {
  const db = setup()
  fact(db, '用户偏好中文回答', { kind: 'persona', priority: 90 })
  const llm = fakeLlm([JSON.stringify({ body: '## 用户偏好\n- 中文' })])
  const first = await runPersona(db, llm, { defaultThreshold: 5 }, { project: 'menm', now: 2 })
  assert.equal(first.reason, 'written')
  assert.equal(llm.calls.length, 1) // cold start: no gate call
  assert.equal(getMeta(db, 'l3-persona-time:menm'), '2')

  fact(db, '第二件事', { now: 3 })
  fact(db, '第三件事', { now: 4 })
  const quiet = await runPersona(db, llm, { defaultThreshold: 5 }, { project: 'menm', now: 5 })
  assert.equal(quiet.rewritten, false)
  assert.equal(quiet.reason, 'trigger:below-threshold:2/5')
  assert.equal(llm.calls.length, 1)
  // Deferred batches must not move the baseline, or the delta would reset itself.
  assert.equal(getMeta(db, 'l3-persona-time:menm'), '2')
})

test('default mode rewrites incrementally from the scenes that changed after the watermark', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', body: '## 工具链\n- pnpm', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm 构建', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  for (let i = 0; i < 3; i++) fact(db, `新事实 ${i}`, { scene: '工具链', now: 2 + i })
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm 与新结论', body: '## 工具链\n- 用 pnpm build', now: 6 })
  const llm = fakeLlm([JSON.stringify({ body: '## 项目约定\n- 用 pnpm build' })])
  const result = await runPersona(db, llm, { defaultThreshold: 3 }, { project: 'menm', now: 7 })
  assert.equal(result.reason, 'written')
  assert.equal(result.version, 2)
  assert.match(llm.calls[0].user, /变化场景（自上次画像后有更新/)
  assert.match(llm.calls[0].user, /### 工具链/)
  assert.match(llm.calls[0].user, /修订要求：以变化场景为准/)
  assert.match(llm.calls[0].user, /新增事实（自上次画像后写入）：/)
  assert.equal(getMeta(db, 'l3-persona-time:menm'), '7')
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.match(detail.branch, /^trigger:facts:3>=3$/)
  assert.deepEqual(detail.freshScenes, ['工具链'])
})

test('default mode skips the model entirely when no scene moved', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', body: '## 工具链', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  for (let i = 0; i < 5; i++) fact(db, `新事实 ${i}`, { now: 2 + i })
  const llm = fakeLlm([])
  const result = await runPersona(db, llm, { defaultThreshold: 3 }, { project: 'menm', now: 9 })
  assert.equal(result.reason, 'unchanged')
  assert.equal(llm.calls.length, 0) // the gate is not consulted either
  assert.equal(getMeta(db, 'l3-persona-time:menm'), '1')
})

test('default mode reports unchanged when the model restates the same body', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', body: '## 工具链', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  fact(db, '新事实', { now: 2 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '同一件事换个说法', body: '## 工具链', now: 5 })
  const llm = fakeLlm([JSON.stringify({ body: '## 项目约定\n- pnpm' })])
  const result = await runPersona(db, llm, { defaultThreshold: 1 }, { project: 'menm', now: 6 })
  assert.equal(result.reason, 'unchanged')
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).version, 1)
  assert.equal(getMeta(db, 'l3-persona-time:menm'), '1')
})

test('an oversized persona is rewritten even with nothing new to read', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', body: '## 工具链', now: 1 })
  fact(db, '写入基准之前就有的旧事实', { now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '长'.repeat(300), now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  const llm = fakeLlm([JSON.stringify({ body: '## 项目约定\n- pnpm' })])
  const result = await runPersona(db, llm, { defaultThreshold: 50, targetChars: 120, maxChars: 600 }, { project: 'menm', now: 2 })
  assert.equal(result.reason, 'written')
  assert.equal(llm.calls.length, 1) // bloat outranks the "nothing changed" short-cut
  assert.match(getMeta(db, 'l3-last-compact'), /"chars":300/)
})

// ── jev mode: the gate only adds a rewrite, it never blocks one ──────────────

test('jev mode lets the trigger bypass the gate', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', body: '## 工具链', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  fact(db, '新事实 A', { now: 2 })
  fact(db, '新事实 B', { now: 3 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '新结论', body: '## 新结论', now: 4 })
  const llm = fakeLlm([JSON.stringify({ body: '## 项目约定\n- 新结论' })])
  const result = await runPersona(db, llm, { triggerMode: 'jev', defaultThreshold: 2 }, { project: 'menm', now: 5 })
  assert.equal(result.reason, 'written')
  assert.equal(llm.calls.length, 1) // rewrite only, no gate call
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.match(detail.branch, /^trigger:/)
})

test('jev mode asks the gate with the changed scenes when the trigger is quiet', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '旧摘要', body: '## 旧正文', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- 旧', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  fact(db, '一条新事实', { now: 2 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '新摘要', body: '## 新正文', now: 3 })
  const llm = fakeLlm([
    JSON.stringify({ choice: 'conflict', confidence: 0.82 }),
    JSON.stringify({ body: '## 项目约定\n- 新' }),
  ])
  const result = await runPersona(db, llm, { triggerMode: 'jev', defaultThreshold: 50 }, { project: 'menm', now: 4 })
  assert.equal(result.reason, 'written')
  assert.equal(result.version, 2)
  // The gate reads the scene diff, not a snapshot of the fact pool.
  assert.match(llm.calls[0].user, /自上次画像更新以来发生变化的场景/)
  assert.match(llm.calls[0].user, /### 工具链/)
  assert.match(llm.calls[0].user, /正文：\n## 新正文/)
  assert.doesNotMatch(llm.calls[0].user, /一条新事实/)
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.branch, 'gate:conflict')
})

test('jev mode defers without a gate call when no scene changed', async () => {
  const db = setup()
  putPersona(db, { scope: 'project', project: 'menm', body: '## 项目约定\n- pnpm', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  fact(db, '一条新事实', { now: 2 })
  const llm = fakeLlm([])
  const result = await runPersona(db, llm, { triggerMode: 'jev', defaultThreshold: 50 }, { project: 'menm', now: 3 })
  assert.equal(result.reason, 'gate:not_applicable')
  assert.equal(llm.calls.length, 0)
})


// ── jev mode as a configured backend ────────────────────────────────────────

test('jev mode without a usable judge backend fails closed, with no call', async () => {
  const db = setup()
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '旧', body: '旧正文', now: 1 })
  putPersona(db, { scope: 'project', project: 'menm', body: '项目约定：旧', now: 1 })
  setMeta(db, 'l3-persona-time:menm', '1')
  fact(db, '一条新事实', { now: 2 })
  upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '新', body: '新正文', now: 3 })
  const llm = fakeLlm([])
  const result = await runPersona(
    db,
    llm,
    { triggerMode: 'jev', defaultThreshold: 50, jev: { provider: 'jev', endpoint: '', model: '', apiKeyRef: '' } },
    { project: 'menm', now: 4 },
  )
  assert.equal(result.reason, 'gate:invalid_config')
  assert.equal(llm.calls.length, 0)
  assert.deepEqual(readGateStats(db), { called: 0, hit: 0, deferred: 0, unavailable: 1 })
  const log = JSON.parse(getMeta(db, 'l3-gate-log'))
  assert.equal(log[log.length - 1].action, 'unavailable')
  assert.equal(log[log.length - 1].reason, 'invalid_config')
})

test('jev mode drives any registered provider through the choice protocol', async () => {
  resetDecisionProviders()
  const seen = []
  registerDecisionProvider('stub', () => ({
    name: 'stub',
    model: 'stub-1',
    maxChoiceOptions: 8,
    isUsable: () => true,
    async askChoices(state, questions) {
      seen.push({ state, questions })
      return new Map([[questions[0].id, { id: questions[0].id, choice: 'boundary_change' }]])
    },
  }))
  try {
    const db = setup()
    upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '旧', body: '旧正文', now: 1 })
    putPersona(db, { scope: 'project', project: 'menm', body: '项目约定：旧', now: 1 })
    setMeta(db, 'l3-persona-time:menm', '1')
    fact(db, '一条新事实', { now: 2 })
    upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '新', body: '新正文', now: 3 })
    const llm = fakeLlm([JSON.stringify({ body: '项目约定：新' })])
    const result = await runPersona(
      db,
      llm,
      { triggerMode: 'jev', defaultThreshold: 50, jev: { provider: 'stub' } },
      { project: 'menm', now: 4 },
    )
    assert.equal(result.reason, 'written')
    assert.equal(seen.length, 1)
    assert.match(seen[0].state, /自上次画像更新以来发生变化的场景/)
    assert.match(seen[0].state, /新正文/)
    assert.deepEqual(Object.keys(seen[0].questions[0].criteria).sort(), Object.keys(JEV_CRITERIA).sort())
    assert.equal(getMeta(db, 'l3-last-reason'), 'menm:written')
    assert.deepEqual(readGateStats(db), { called: 1, hit: 1, deferred: 0, unavailable: 0 })
  } finally {
    resetDecisionProviders()
  }
})

test('a non-committal judge label is counted as a deferral', async () => {
  resetDecisionProviders()
  registerDecisionProvider('stub', () => ({
    name: 'stub',
    model: 'stub-1',
    maxChoiceOptions: 8,
    isUsable: () => true,
    async askChoices(state, questions) {
      return new Map([[questions[0].id, { id: questions[0].id, choice: 'reinforcement' }]])
    },
  }))
  try {
    const db = setup()
    upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '旧', body: '旧正文', now: 1 })
    putPersona(db, { scope: 'project', project: 'menm', body: '项目约定：旧', now: 1 })
    setMeta(db, 'l3-persona-time:menm', '1')
    fact(db, '一条新事实', { now: 2 })
    upsertScene(db, { scope: 'project', project: 'menm', name: '工具链', summary: '新', body: '新正文', now: 3 })
    const llm = fakeLlm([])
    const result = await runPersona(
      db,
      llm,
      { triggerMode: 'jev', defaultThreshold: 50, jev: { provider: 'stub' } },
      { project: 'menm', now: 4 },
    )
    assert.equal(result.reason, 'gate:reinforcement')
    assert.equal(llm.calls.length, 0)
    assert.deepEqual(readGateStats(db), { called: 1, hit: 0, deferred: 1, unavailable: 0 })
  } finally {
    resetDecisionProviders()
  }
})

test('the judge key is resolved from the credential service, the environment, or a literal', async () => {
  assert.equal(await resolveDecisionApiKey('', undefined), '')
  assert.equal(
    await resolveDecisionApiKey('sk-literal-with-dashes', async () => {
      throw new Error('no service')
    }),
    'sk-literal-with-dashes',
  )
  assert.equal(await resolveDecisionApiKey('MY_KEY', async () => 'from-service'), 'from-service')
  process.env.DSH_MEMORY_TEST_JEV_KEY = 'from-env'
  try {
    assert.equal(await resolveDecisionApiKey('DSH_MEMORY_TEST_JEV_KEY', undefined), 'from-env')
  } finally {
    delete process.env.DSH_MEMORY_TEST_JEV_KEY
  }
})

test('a scene requestPersona flag fires the persona on the next batch (P1)', async () => {
  const db = setup()
  fact(db, '构建用 pnpm', { scene: '工具链' })
  fact(db, 'Node 版本 24', { scene: '工具链' })
  const scenes = fakeLlm([JSON.stringify({ summary: 'pnpm 与 Node 24', body: '## 要点\n- pnpm build' })])
  await runScenes(db, scenes, { minFacts: 2 }, { project: 'menm', now: 2 })
  const first = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建。' })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 50 }, { project: 'menm', now: 3 })
  assert.equal(getMeta(db, 'l3-persona-request:menm'), undefined)

  // A new fact rewrites the scene, and the scene agent flags the persona.
  fact(db, 'Node 改到 26', { scene: '工具链', now: 4 })
  const flagged = fakeLlm([JSON.stringify({ summary: 'Node 26', body: '## 要点\n- Node 26', requestPersona: true })])
  await runScenes(db, flagged, { minFacts: 2 }, { project: 'menm', now: 5 })
  assert.notEqual(getMeta(db, 'l3-persona-request:menm'), undefined)

  const llm = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建，Node 26。' })])
  const result = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 50 }, { project: 'menm', now: 6 })
  assert.equal(result.reason, 'written')
  assert.equal(llm.calls.length, 1)
  assert.equal(getMeta(db, 'l3-persona-request:menm'), undefined)
})

test('the first scene block fires the persona once, not on every batch (P3)', async () => {
  const db = setup()
  fact(db, '用 pnpm 构建', { project: 'menm' })
  const warm = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建。' })])
  await runPersona(db, warm, { triggerMode: 'current', defaultThreshold: 500 }, { project: 'menm', now: 1 })

  fact(db, 'pnpm build 出 dist', { scene: '工具链', now: 2 })
  fact(db, 'Node 24', { scene: '工具链', now: 2 })
  const scenes = fakeLlm([JSON.stringify({ summary: 'pnpm', body: '## 要点\n- pnpm build' })])
  await runScenes(db, scenes, { minFacts: 2 }, { project: 'menm', now: 3 })
  assert.notEqual(getMeta(db, 'l3-first-scene:menm'), undefined)

  const llm = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建，产物在 dist。' })])
  const first = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 500 }, { project: 'menm', now: 4 })
  assert.equal(first.reason, 'written')
  assert.equal(getMeta(db, 'l3-first-scene:menm'), undefined)

  const second = await runPersona(db, fakeLlm([]), { triggerMode: 'current', defaultThreshold: 500 }, { project: 'menm', now: 5 })
  assert.equal(second.reason, 'trigger:below-threshold:0/500')
})

test('a patch replaces the superseded sentence instead of keeping both versions', async () => {
  const db = setup()
  fact(db, '向量是 384 维', { project: 'menm' })
  const first = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 召回用 384 维词法向量。' })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 1 })

  fact(db, '向量改 4096 维', { project: 'menm', now: 2 })
  const llm = fakeLlm([
    JSON.stringify({ mode: 'patch', edits: [{ old: '- 召回用 384 维词法向量。', new: '- 召回用 4096 维向量。' }] }),
  ])
  const result = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 3 })
  assert.equal(result.reason, 'written')
  const body = getPersona(db, { scope: 'project', project: 'menm' }).body
  assert.match(body, /4096/)
  assert.doesNotMatch(body, /384/)
  assert.equal(getMeta(db, 'l3-patch-stats'), JSON.stringify({ writes: 1, patches: 1, edits: 1, hits: 1, misses: 0 }))
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.mode, 'patch')
  assert.equal(detail.patch.hit, 1)
})

test('a patch whose old text is not in the body is discarded, not guessed at', async () => {
  const db = setup()
  fact(db, '向量是 384 维', { project: 'menm' })
  const first = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 召回用 384 维词法向量。' })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 1 })
  const before = getPersona(db, { scope: 'project', project: 'menm' }).body

  fact(db, '向量改 4096 维', { project: 'menm', now: 2 })
  const llm = fakeLlm([
    JSON.stringify({ mode: 'patch', edits: [{ old: '- 这句话画像里根本没有。', new: '- 新句' }] }),
  ])
  const result = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 3 })
  assert.equal(result.reason, 'patch-miss')
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).body, before)
  const detail = JSON.parse(getMeta(db, 'l3-last-detail'))
  assert.equal(detail.misses[0].reason, 'not-found')
})

test('a "none" answer leaves the persona and its version alone', async () => {
  const db = setup()
  fact(db, '向量是 384 维', { project: 'menm' })
  const first = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 召回用 384 维词法向量。' })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 1 })
  const version = getPersona(db, { scope: 'project', project: 'menm' }).version

  fact(db, '向量改 4096 维', { project: 'menm', now: 2 })
  const llm = fakeLlm([JSON.stringify({ mode: 'none' })])
  const result = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 3 })
  assert.equal(result.reason, 'unchanged')
  assert.equal(getPersona(db, { scope: 'project', project: 'menm' }).version, version)
  assert.equal(JSON.parse(getMeta(db, 'l3-last-detail')).mode, 'none')
})

test('a consumed request signal does not survive a restatement', async () => {
  const db = setup()
  fact(db, '构建用 pnpm', { project: 'menm' })
  const first = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建。' })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 1 })
  setMeta(db, 'l3-persona-request:menm', '1')

  fact(db, 'Node 24', { project: 'menm', now: 2 })
  const llm = fakeLlm([JSON.stringify({ body: '## 环境与工具\n- 用 pnpm 构建。' })])
  const result = await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 3 })
  assert.equal(result.reason, 'unchanged')
  assert.equal(getMeta(db, 'l3-persona-request:menm'), undefined)
})

test('applyPersonaPatch replaces the first occurrence and reports every miss', () => {
  const body = `## 环境与工具
- 召回用 384 维词法向量。
- 构建用 pnpm。`
  const applied = applyPersonaPatch(body, [
    { old: '- 召回用 384 维词法向量。', new: '- 召回用 4096 维向量。' },
    { old: '- 这句话不存在。', new: '- 新句' },
    { old: '   ', new: 'x' },
  ])
  assert.equal(applied.hit, 1)
  assert.match(applied.text, /4096/)
  assert.doesNotMatch(applied.text, /384/)
  assert.deepEqual(applied.misses.map((m) => m.reason), ['not-found', 'empty-old'])
})

test('readPatchStats stays silent until a patch is written, then counts hits and misses', async () => {
  const db = setup()
  assert.equal(readPatchStats(db), null)
  fact(db, '向量是 384 维', { project: 'menm' })
  const first = fakeLlm([JSON.stringify({ body: `## 环境与工具
- 召回用 384 维词法向量。` })])
  await runPersona(db, first, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 1 })
  assert.equal(readPatchStats(db), null)

  fact(db, '向量改 4096 维', { project: 'menm', now: 2 })
  const llm = fakeLlm([
    JSON.stringify({
      mode: 'patch',
      edits: [
        { old: '- 召回用 384 维词法向量。', new: '- 召回用 4096 维向量。' },
        { old: '- 不存在的句子。', new: '- 新句' },
      ],
    }),
  ])
  await runPersona(db, llm, { triggerMode: 'current', defaultThreshold: 1 }, { project: 'menm', now: 3 })
  assert.deepEqual(readPatchStats(db), { writes: 1, patches: 1, edits: 2, hits: 1, misses: 1 })
})

test('a run of empty scene answers stops the batch instead of walking every group', async () => {
  const db = setup()
  for (let i = 0; i < 8; i++) {
    fact(db, `事实 ${i}-a`, { scene: `场景${i}` })
    fact(db, `事实 ${i}-b`, { scene: `场景${i}` })
    fact(db, `事实 ${i}-c`, { scene: `场景${i}` })
  }
  const llm = fakeLlm(Array(20).fill('{}'))
  const result = await runScenes(db, llm, { minFacts: 1 }, { project: 'menm', now: 2 })
  assert.equal(result.updated, 0)
  assert.ok(llm.calls.length <= CONSOLIDATE_LIMITS.sceneFailures, `calls=${llm.calls.length}`)
})

test('the batch never exceeds sceneAttempts model calls', async () => {
  const db = setup()
  for (let i = 0; i < 10; i++) {
    fact(db, `事实 ${i}-a`, { scene: `场景${i}` })
    fact(db, `事实 ${i}-b`, { scene: `场景${i}` })
    fact(db, `事实 ${i}-c`, { scene: `场景${i}` })
  }
  const answers = []
  for (let i = 0; i < 12; i++) answers.push(i % 2 === 0 ? JSON.stringify({ summary: `S${i}`, body: 'B' }) : '{}')
  const llm = fakeLlm(answers)
  await runScenes(db, llm, { minFacts: 1 }, { project: 'menm', now: 2 })
  assert.ok(llm.calls.length <= CONSOLIDATE_LIMITS.sceneAttempts, `calls=${llm.calls.length}`)
})

test('the scene with the biggest backlog is asked about first', async () => {
  const db = setup()
  for (let i = 0; i < 5; i++) fact(db, `大欠账事实 ${i}`, { scene: '大欠账' })
  fact(db, '小欠账事实', { scene: '小欠账' })
  const llm = fakeLlm([JSON.stringify({ summary: '大', body: '大' })])
  const result = await runScenes(db, llm, { minFacts: 1 }, { project: 'menm', now: 2 })
  assert.equal(result.updated, 1)
  assert.ok(llm.calls[0].user.includes('场景：大欠账'), llm.calls[0].user.slice(0, 40))
  assert.equal(listScenes(db, { project: 'menm', now: 2 })[0].name, '大欠账')
})

test('a throwing scene call is counted and does not abort the rest of the batch', async () => {
  const db = setup()
  for (let i = 0; i < 4; i++) fact(db, `抛错事实 ${i}`, { scene: '会抛错' })
  for (let i = 0; i < 3; i++) fact(db, `正常事实 ${i}`, { scene: '正常' })
  let n = 0
  const llm = {
    available: true,
    calls: [],
    async complete() {
      n += 1
      if (n === 1) throw new Error('boom')
      return { ok: true, text: JSON.stringify({ summary: '正常摘要', body: '正常正文' }), usage: null }
    },
  }
  const result = await runScenes(db, llm, { minFacts: 1 }, { project: 'menm', now: 2 })
  assert.equal(result.updated, 1)
  assert.equal(n, 2)
  assert.equal(listScenes(db, { project: 'menm', now: 2 })[0].name, '正常')
})

test('factsByScene keeps a per-scene quota instead of one global window', () => {
  const db = setup()
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 25; j++) fact(db, `场景${i}事实${j}`, { scene: `场景${i}` })
  }
  const groups = factsByScene(db, { project: 'menm' })
  assert.equal(groups.size, 20)
  for (const list of groups.values()) assert.ok(list.length <= CONSOLIDATE_LIMITS.sceneFacts)
  assert.equal(groups.get('场景0').length, CONSOLIDATE_LIMITS.sceneFacts)
})
