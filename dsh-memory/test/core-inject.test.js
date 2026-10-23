import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { openDatabase, saveMemory, coreMemories, CORE_PRIORITY } from '../src/store.js'
import { renderStableBlock } from '../src/recall.js'

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'dsh-memory-core-')), 'memory.db')

/** Minimal cordis ctx: only what `apply` touches in these tests. */
function fakeCtx() {
  const handlers = new Map()
  const tools = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(factory) {
      const cleanup = factory()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, handlers, tools }
}

test('coreMemories returns pinned rows plus standing persona/instruction rows, project-scoped', () => {
  const db = openDatabase(tmpDb())
  const now = Date.now()
  const pinnedGlobal = saveMemory(db, { text: '称用户为「官人」，语气温柔', kind: 'fact', scope: 'global', pinned: true }, now)
  const hardRule = saveMemory(db, { text: '不要自动 git push', kind: 'instruction', scope: 'project', project: 'demo' }, now)
  db.prepare("UPDATE memory SET priority = ? WHERE id = ?").run(92, hardRule.id)
  const softPref = saveMemory(db, { text: '偏好中文注释', kind: 'persona', scope: 'project', project: 'demo' }, now)
  db.prepare("UPDATE memory SET priority = ? WHERE id = ?").run(60, softPref.id)
  const projectFact = saveMemory(db, { text: '端口是 3000', kind: 'work_fact', scope: 'project', project: 'demo' }, now)
  db.prepare("UPDATE memory SET priority = ? WHERE id = ?").run(95, projectFact.id)
  const otherProject = saveMemory(db, { text: '别的项目规则', kind: 'instruction', scope: 'project', project: 'other' }, now)
  db.prepare("UPDATE memory SET priority = ? WHERE id = ?").run(99, otherProject.id)
  const replaced = saveMemory(db, { text: '旧规则：称「你」', kind: 'instruction', scope: 'global', pinned: true }, now)
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(pinnedGlobal.id, replaced.id)

  const rows = coreMemories(db, { project: 'demo' })
  const ids = rows.map((row) => row.id)
  assert.deepEqual(ids, [pinnedGlobal.id, hardRule.id], 'pinned global first, then the 92-priority rule')
  assert.ok(!ids.includes(softPref.id), 'a 60-priority persona is not a standing rule')
  assert.ok(!ids.includes(projectFact.id), 'high-priority project facts are recall-only')
  assert.ok(!ids.includes(otherProject.id), 'other projects stay invisible')
  assert.ok(!ids.includes(replaced.id), 'superseded rows never inject')

  // Without a project only global rows apply.
  assert.deepEqual(coreMemories(db, { project: null }).map((row) => row.id), [pinnedGlobal.id])
  // `includePinned: false` keeps the standing-rule branch only.
  assert.deepEqual(coreMemories(db, { project: 'demo', includePinned: false }).map((row) => row.id), [hardRule.id])
  assert.equal(CORE_PRIORITY, 85)
  db.close()
})

test('renderStableBlock puts standing rules first and keeps them inside the budget', () => {
  const cores = [
    { id: 1, kind: 'fact', pinned: 1, text: '称用户为「官人」，每轮都这样称呼' },
    { id: 2, kind: 'instruction', pinned: 0, text: '不要自动 git push' },
  ]
  const block = renderStableBlock({
    cores,
    personas: [{ scope: 'project', version: 1, body: '项目约定：'.padEnd(600, 'x') }],
    scenes: ['- 工具链（热度 2.0，3 条）: pnpm'],
    maxChars: 400,
  })
  assert.match(block, /^<memory_context type="stable"/)
  const coreIndex = block.indexOf('长期约定')
  const personaIndex = block.indexOf('项目画像')
  assert.ok(coreIndex > 0, 'core section rendered')
  assert.ok(personaIndex === -1 || coreIndex < personaIndex, 'core section comes before the persona')
  assert.match(block, /【置顶】称用户为「官人」/)
  assert.match(block, /【规则】不要自动 git push/)
  assert.ok(!block.includes('【偏好】'), 'badges follow the row kind')
  assert.ok(block.length <= 400 + 200, 'budget keeps the block bounded')

  // Pinned rule survives even when the persona alone would spend the budget.
  const tight = renderStableBlock({ cores, personas: [{ scope: 'project', version: 1, body: 'y'.repeat(400) }], maxChars: 300 })
  assert.match(tight, /官人/)

  // The 60% core cap is hard: long rules are clipped, never allowed to eat the block.
  const fat = renderStableBlock({
    cores: Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'instruction', pinned: 0, text: `规则${i}:` + 'z'.repeat(400) })),
    maxChars: 300,
  })
  const coreSection = fat.slice(fat.indexOf('### 长期约定'), fat.indexOf('</memory_context>'))
  assert.ok(coreSection.length <= 180 + 1, `core section stayed inside the 60% cap (was ${coreSection.length})`)
  assert.match(coreSection, /规则0/, 'the first rule is never dropped')
  assert.ok(fat.endsWith('</memory_context>'))

  // No cores and no personas -> no block at all.
  assert.equal(renderStableBlock({}), '')
})

test('a greeting-only turn injects the pinned global preference (pre-step wiring)', async () => {
  const dbPath = tmpDb()
  const seed = openDatabase(dbPath)
  saveMemory(seed, {
    text: '称用户为「官人」，每轮都这样称呼；语气温柔体贴',
    kind: 'fact',
    scope: 'global',
    pinned: true,
  })
  seed.close()

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dbPath, capture: false, extraction: { enabled: false } })

  const preStep = handlers.get('agent/pre-step')
  assert.equal(typeof preStep, 'function')
  const session = { id: 'session-greeting', header: { cwd: 'F:\\work\\demo' }, events: [] }
  const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你好啊' }] }]
  const decision = await preStep({ agent: { session }, messages, turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))

  assert.equal(decision.kind, 'enter')
  const injected = decision.messages.map((message) => message.content[0].text).join('\n')
  assert.match(injected, /长期约定/)
  assert.match(injected, /官人/)
  assert.equal(decision.messages[0].source.kind, 'plugin:dsh-memory', 'injected as context, not as a user instruction')

  // Second turn of the same session must not pay for the stable block again.
  const again = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '今天做什么' }] }], turn: 2, step: 1, signal: {} },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const second = again.messages.map((message) => message.content[0].text).join('\n')
  assert.ok(!second.includes('长期约定'), 'stable block is once per session')

  // A query that *does* match the pinned row must still inject it once: the
  // stable block renders it first, the global/dynamic passes skip it.
  const matching = await preStep(
    {
      agent: { session: { id: 'session-matching', header: { cwd: 'F:\\work\\demo' }, events: [] } },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '官人今天做什么' }] }],
      turn: 1,
      step: 1,
      signal: {},
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const injectedMatching = matching.messages.map((message) => message.content[0].text).join('\n')
  const occurrences = injectedMatching.split('称用户为「官人」').length - 1
  assert.equal(occurrences, 1, 'the pinned preference is injected exactly once per turn')
})

test('a turn without text (attachment only) still injects the standing rules', async () => {
  const dbPath = tmpDb()
  const seed = openDatabase(dbPath)
  saveMemory(seed, { text: '称用户为「官人」，每轮都这样称呼', kind: 'fact', scope: 'global', pinned: true })
  seed.close()

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dbPath, capture: false, extraction: { enabled: false } })
  const session = { id: 'session-image', header: { cwd: 'F:\\work\\demo' }, events: [] }
  const messages = [{ source: { kind: 'user' }, content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } }] }]
  const decision = await handlers.get('agent/pre-step')({ agent: { session }, messages, turn: 1, step: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))

  const injected = decision.messages.map((message) => message.content[0].text).join('\n')
  assert.match(injected, /长期约定/, 'the stable half does not depend on the text of the prompt')
  assert.match(injected, /官人/)
})

test('the global channel is re-checked every turn instead of closing after a miss', async () => {
  const dbPath = tmpDb()
  const seed = openDatabase(dbPath)
  // Not pinned and not a core kind: only the lexical global pass can surface it.
  saveMemory(seed, { text: '生产库只读，不要写', kind: 'fact', scope: 'global' })
  seed.close()

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dbPath, capture: false, extraction: { enabled: false } })
  const preStep = handlers.get('agent/pre-step')
  const session = { id: 'session-reopen', header: { cwd: 'F:\\work\\demo' }, events: [] }
  const enter = async () => ({ kind: 'enter', messages: [] })

  // Turn 1: a greeting matches nothing -> no global injected.
  const first = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你好啊' }] }], turn: 1, step: 1, signal: {} },
    enter,
  )
  const firstText = (first.messages ?? []).map((message) => message.content[0].text).join('\n')
  assert.ok(!firstText.includes('生产库只读'))

  // Turn 2: the same session, now the query matches -> the global fact shows up.
  const second = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '生产库能不能写' }] }], turn: 2, step: 1, signal: {} },
    enter,
  )
  const secondText = (second.messages ?? []).map((message) => message.content[0].text).join('\n')
  assert.match(secondText, /生产库只读/, 'a first-turn miss must not close the global channel for the session')

  // Turn 3: already delivered by the global pass -> never duplicated within the
  // same turn, even though the dynamic pass may legitimately re-deliver it.
  const third = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '生产库能写吗' }] }], turn: 3, step: 1, signal: {} },
    enter,
  )
  const thirdText = (third.messages ?? []).map((message) => message.content[0].text).join('\n')
  assert.ok(thirdText.split('生产库只读').length - 1 <= 1, 'a global row is never injected twice in one turn')
  assert.ok(!thirdText.includes('以下是用户/团队的长期偏好与约定'), 'the global section is not repeated for the session')
})

test('the stable block seeds the session set so a standing rule is never shown twice', async () => {
  const dbPath = tmpDb()
  const seed = openDatabase(dbPath)
  saveMemory(seed, { text: '称呼与语气偏好：每轮称「官人」，自称「妾身」', kind: 'fact', scope: 'global', pinned: true })
  seed.close()

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dbPath, capture: false, extraction: { enabled: false } })
  const preStep = handlers.get('agent/pre-step')
  const session = { id: 'session-seed', header: { cwd: 'F:\\work\\demo' }, events: [] }
  const enter = async () => ({ kind: 'enter', messages: [] })
  const ask = (text, turn) =>
    preStep({ agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }], turn, step: 1, signal: {} }, enter)

  const first = await ask('你好啊', 1)
  const firstText = (first.messages ?? []).map((message) => message.content[0].text).join('\n')
  assert.match(firstText, /长期约定/)

  // Turn 2 mentions the preference explicitly: the dynamic pass may legitimately
  // return the row, but the globals section must not render it a second time.
  const second = await ask('官人这个称呼怎么设置', 2)
  const secondText = (second.messages ?? []).map((message) => message.content[0].text).join('\n')
  assert.ok(!secondText.includes('以下是用户/团队的长期偏好与约定'), 'core rows are seeded into the session set')
  assert.ok(secondText.split('称呼与语气偏好').length - 1 <= 1, 'no duplicated block for the same row')
})

test('an attachment-only later turn does not answer the previous question again', async () => {
  const dbPath = tmpDb()
  const seed = openDatabase(dbPath)
  saveMemory(seed, { text: '生产库只读，不要写', kind: 'fact', scope: 'global', pinned: true })
  seed.close()

  const { ctx, handlers } = fakeCtx()
  apply(ctx, { dbPath, capture: false, extraction: { enabled: false } })
  const preStep = handlers.get('agent/pre-step')
  // The session log still carries the previous turn's question.
  const session = {
    id: 'session-attach',
    header: { cwd: 'F:\\work\\demo' },
    events: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '生产库能不能写' }] } },
    ],
  }
  const enter = async () => ({ kind: 'enter', messages: [] })
  const first = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '你好啊' }] }], turn: 1, step: 1, signal: {} },
    enter,
  )
  assert.match((first.messages ?? []).map((m) => m.content[0].text).join('\n'), /长期约定/)

  const second = await preStep(
    {
      agent: { session },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAA' } }] }],
      turn: 2,
      step: 1,
      signal: {},
    },
    enter,
  )
  assert.equal(second.messages.length, 0, 'no recall should be driven by an older question')
})
