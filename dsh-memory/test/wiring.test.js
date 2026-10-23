import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { openDatabase, saveMemory } from '../src/store.js'
import { appendTurn, pendingCount } from '../src/l0.js'

function fakeCtx(extractionBatches = [], extras = {}) {
  const handlers = new Map()
  const tools = new Map()
  const calls = []
  let batch = 0
  const service = {
    stream(request) {
      calls.push(request)
      const system = String(request.system ?? '')
      let text
      if (system.includes('记忆整理器')) text = JSON.stringify({ memories: extractionBatches[batch++] ?? [] })
      else if (system.includes('场景归并器')) text = JSON.stringify(extras.scene ?? { summary: '场景摘要', body: '## 要点\n- 事实' })
      else if (system.includes('画像整理器')) text = JSON.stringify({ body: extras.persona ?? '## 用户偏好\n- 中文' })
      else if (system.includes('判断这批新事实')) text = JSON.stringify({ decision: 'none' })
      else text = '{}'
      return (async function* stream() {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
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
    get(name) {
      if (name === 'llm') return service
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, handlers, tools, calls }
}

function emitTurn(handlers, session, { turn, user, assistant }) {
  const fire = handlers.get('session/event')
  fire(session, { type: 'turn/start', seq: turn * 10, data: { turn } })
  fire(session, { type: 'user/message', seq: turn * 10 + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } })
  fire(session, { type: 'assistant/message', seq: turn * 10 + 2, data: { message: { content: [{ type: 'text', text: assistant }] } } })
  fire(session, { type: 'turn/end', seq: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

test('turn/end writes L0 and a threshold trigger extracts facts end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring-'))
  const dbPath = join(dir, 'memory.db')
  const { ctx, handlers } = fakeCtx([
    [{ kind: 'work_fact', text: '项目用 pnpm 构建', priority: 70, scene: '工具链' }],
    [{ kind: 'instruction', text: '不要自动 git push', priority: 90, scene: '发布' }],
  ])
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 1, idleMs: 60_000, provider: 'fake', model: 'fake' },
    scenes: { enabled: false },
    persona: { enabled: false },
  })
  const session = { id: 'session-wire', header: { cwd: 'F:\\work\\demo' }, events: [] }
  emitTurn(handlers, session, { turn: 1, user: '构建用什么', assistant: 'pnpm build' })

  const db = openDatabase(dbPath)
  const extracted = await waitFor(() => pendingCount(db, 'session-wire') === 0)
  assert.equal(extracted, true, 'extraction should consume the pending L0 turn')
  const l0 = db.prepare('SELECT * FROM l0_turns').all()
  assert.equal(l0.length, 1)
  assert.equal(l0[0].project, 'demo')
  assert.equal(l0[0].user_text, '构建用什么')
  const facts = db.prepare("SELECT * FROM memory WHERE kind = 'work_fact'").all()
  assert.equal(facts.length, 1)
  assert.equal(facts[0].priority, 70)

  emitTurn(handlers, session, { turn: 2, user: '推送前要确认吗', assistant: '不要自动 push' })
  const second = await waitFor(() =>
    db.prepare("SELECT COUNT(*) AS n FROM l0_turns WHERE extracted_at IS NULL").get().n === 0 &&
    db.prepare("SELECT COUNT(*) AS n FROM memory WHERE kind = 'instruction'").get().n === 1,
  )
  assert.equal(second, true)
  const statsRow = db.prepare("SELECT value FROM meta WHERE key = 'l1-last-reason'").get()
  assert.equal(statsRow.value, 'ok')
})

test('memory_extract tool forces a run and reports status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring2-'))
  const dbPath = join(dir, 'memory.db')
  const { ctx, handlers, tools } = fakeCtx([[{ kind: 'work_fact', text: '数据库是 MySQL', priority: 60 }]])
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 100, idleMs: 60_000, provider: 'fake', model: 'fake' },
    scenes: { enabled: false },
    persona: { enabled: false },
  })
  const session = { id: 'session-tool', header: { cwd: 'F:\\work\\demo' }, events: [] }
  emitTurn(handlers, session, { turn: 1, user: '数据库是什么', assistant: 'MySQL' })
  const result = await tools.get('memory_extract').execute({}, { agent: { session } })
  assert.match(result.text, /extract reason=ok/)
})

test('memory_compact rewrites the persona on demand, bypassing the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring6-'))
  const dbPath = join(dir, 'memory.db')
  const { ctx, tools, calls } = fakeCtx([], { persona: '## 用户偏好\n- 中文（刷新手）' })
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 100, idleMs: 60_000, provider: 'fake', model: 'fake' },
    scenes: { enabled: false },
    // The batch threshold is far away, so only `force` can explain a rewrite.
    persona: { enabled: true, triggerEveryN: 100, targetChars: 120, maxChars: 400 },
  })
  const db = openDatabase(dbPath)
  saveMemory(db, { kind: 'persona', text: '用户偏好中文回答', priority: 90, project: 'demo' })
  // Oversized on purpose: the compact path must not need the JEV gate either.
  const { putPersona } = await import('../src/profile.js')
  putPersona(db, { scope: 'project', project: 'demo', body: '长'.repeat(500), now: 1 })

  const session = { id: 'session-compact', header: { cwd: 'F:\\work\\demo' }, events: [] }
  const result = await tools.get('memory_compact').execute({ scope: 'project' }, { agent: { session } })
  assert.match(result.text, /project=\{"rewritten":true/)
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].system), /画像整理器/)
  const stored = db.prepare("SELECT * FROM l3_persona WHERE scope = 'project' AND project = 'demo'").get()
  assert.equal(stored.version, 2)
  assert.match(stored.body, /中文（刷新手）/)
})

test('memory_extract all drains the backlog of inactive sessions after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring5-'))
  const dbPath = join(dir, 'memory.db')
  // Two sessions that will never receive another turn in this process: their
  // pending turns must still be recoverable through the maintenance tool.
  const seed = openDatabase(dbPath)
  appendTurn(seed, { sessionId: 'old-a', turn: 1, project: 'menm', userText: '旧会话 A 的问题', assistantText: '旧会话 A 的结论' }, 1)
  appendTurn(seed, { sessionId: 'old-b', turn: 1, project: 'menm', userText: '旧会话 B 的问题', assistantText: '旧会话 B 的结论' }, 2)
  seed.close()

  const { ctx, tools } = fakeCtx([
    [{ kind: 'work_fact', text: '旧会话 A 的事实', priority: 60 }],
    [{ kind: 'work_fact', text: '旧会话 B 的事实', priority: 60 }],
  ])
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 100, idleMs: 60_000, provider: 'fake', model: 'fake' },
    scenes: { enabled: false },
    persona: { enabled: false },
  })

  const result = await tools.get('memory_extract').execute({ all: true }, {})
  assert.match(result.text, /sessions=2/)
  assert.match(result.text, /pending=0\/2/)
  const db = openDatabase(dbPath)
  assert.equal(pendingCount(db, 'old-a'), 0)
  assert.equal(pendingCount(db, 'old-b'), 0)
  const facts = db.prepare("SELECT text FROM memory WHERE source = 'extract' ORDER BY text").all().map((row) => row.text)
  assert.deepEqual(facts, ['旧会话 A 的事实', '旧会话 B 的事实'])
})

test('enabled L2/L3 turns facts into a scene block and a persona', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring3-'))
  const dbPath = join(dir, 'memory.db')
  const { ctx, handlers } = fakeCtx(
    [[
      { kind: 'work_fact', text: '用 pnpm build 构建', priority: 70, scene: '工具链' },
      { kind: 'work_fact', text: 'Node 版本 24', priority: 60, scene: '工具链' },
      { kind: 'instruction', text: '不要自动 git push', priority: 90, scene: '发布' },
    ]],
    { scene: { summary: 'pnpm 与 Node 24', body: '## 要点\n- pnpm build' }, persona: '## 项目约定\n- pnpm' },
  )
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 1, idleMs: 60_000, provider: 'fake', model: 'fake', maxMemories: 5 },
    scenes: { enabled: true, minFacts: 2 },
    persona: { enabled: true, triggerEveryN: 10 },
  })
  const session = { id: 'session-l23', header: { cwd: 'F:\\work\\demo' }, events: [] }
  emitTurn(handlers, session, { turn: 1, user: '构建与发布约定', assistant: 'pnpm build，不自动 push' })

  const db = openDatabase(dbPath)
  const done = await waitFor(() => {
    const scenes = db.prepare('SELECT COUNT(*) AS n FROM l2_scenes').get().n
    const personas = db.prepare('SELECT COUNT(*) AS n FROM l3_persona').get().n
    return scenes > 0 && personas > 0
  })
  assert.equal(done, true, 'scene and persona should be written')
  const scene = db.prepare("SELECT * FROM l2_scenes WHERE name = '工具链'").get()
  assert.equal(scene.fact_count, 2)
  assert.match(scene.summary, /Node 24/)
  const persona = db.prepare("SELECT * FROM l3_persona WHERE scope = 'project'").get()
  assert.match(persona.body, /pnpm/)
})

test('enabled L3 also maintains the global persona next to the project one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring4-'))
  const dbPath = join(dir, 'memory.db')
  // The global persona pool is global rows only, so seed one before the plugin
  // opens the database. Without it this job would stop at `no-facts`.
  const seed = openDatabase(dbPath)
  saveMemory(seed, { text: '用户偏好中文回答', kind: 'persona', scope: 'global', project: null })
  seed.close()
  const { ctx, handlers } = fakeCtx(
    [[{ kind: 'work_fact', text: '用 pnpm build 构建', priority: 70, scene: '工具链' }]],
    { persona: '## 用户偏好\n- 中文\n## 项目约定\n- pnpm' },
  )
  apply(ctx, {
    dbPath,
    capture: false,
    extraction: { everyN: 1, idleMs: 60_000, provider: 'fake', model: 'fake' },
    scenes: { enabled: false },
    persona: { enabled: true, triggerEveryN: 10 },
  })
  const session = { id: 'session-global-l3', header: { cwd: 'F:\\work\\demo' }, events: [] }
  emitTurn(handlers, session, { turn: 1, user: '构建与语气偏好', assistant: 'pnpm build，中文回答' })

  const db = openDatabase(dbPath)
  const done = await waitFor(() => db.prepare('SELECT COUNT(*) AS n FROM l3_persona').get().n >= 2)
  assert.equal(done, true, 'project and global persona should both be written')
  const global = db.prepare("SELECT * FROM l3_persona WHERE scope = 'global'").get()
  assert.match(global.body, /中文/)
  const project = db.prepare("SELECT * FROM l3_persona WHERE scope = 'project'").get()
  assert.equal(project.project, 'demo')
  // Each scope keeps its own batch counter; a rewrite resets only its own.
  const counters = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'l3-batches:%'").all()
  const keys = counters.map((row) => row.key).sort()
  assert.deepEqual(keys, ['l3-batches:demo', 'l3-batches:@global'].sort())
  for (const row of counters) assert.equal(row.value, '0')
})
