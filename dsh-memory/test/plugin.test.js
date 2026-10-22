import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'

/** Minimal cordis-like context that records handlers and tools. */
function fakeCtx() {
  const handlers = new Map()
  const tools = new Map()
  const logs = []
  const ctx = {
    logger: {
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(factory) {
      return factory()
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, handlers, tools, logs }
}

function fakeSession(cwd = 'F:\\work\\demo', id = 'session-1') {
  return { id, header: { cwd }, events: [] }
}

function emitTurn(handlers, session, { user, assistant, tools = [] }) {
  const fire = handlers.get('session/event')
  fire(session, { type: 'turn/start', data: { turn: 1 } })
  fire(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } })
  for (const toolName of tools) fire(session, { type: 'tool/call', data: { turn: 1, step: 1, name: toolName, arguments: '{}' } })
  fire(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: assistant }] } },
  })
  fire(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
}

test('plugin declares its services and loads with a temp database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const { ctx, handlers, tools, logs } = fakeCtx()
  apply(ctx, { dbPath: join(dir, 'memory.db') })
  assert.deepEqual(inject, ['tools', 'agents', 'sessions'])
  assert.equal(name, 'memory')
  assert.ok(handlers.has('session/event'))
  assert.ok(handlers.has('agent/pre-step'))
  assert.deepEqual([...tools.keys()].sort(), ['memory_extract', 'memory_forget', 'memory_save', 'memory_search', 'memory_stats'])
  assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('memory db ready')))
})

test('capture writes one episode per completed turn and skips plugin-injected messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const { ctx, handlers, tools } = fakeCtx()
  apply(ctx, { dbPath: join(dir, 'memory.db') })
  const session = fakeSession()

  emitTurn(handlers, session, {
    user: '给 dsh 加跨会话记忆，用 node:sqlite 存，不要引外部依赖',
    assistant: '方案定了：独立插件 + pre-step 注入 + turn/end 落库。',
    tools: ['write', 'bash'],
  })
  // a plugin-injected context message must not be captured as the user prompt
  handlers.get('session/event')(session, {
    type: 'user/message',
    data: { source: { kind: 'plugin:dsh-memory', form: 'recall' }, content: [{ type: 'text', text: '<memory_context>x</memory_context>' }] },
  })
  handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

  return tools
    .get('memory_stats')
    .execute({}, {})
    .then((result) => {
      assert.match(result.text, /memories=1/)
      assert.match(result.text, /episodes=1/)
      // pass the session so the search runs with the same project key as capture
      return tools.get('memory_search').execute({ query: '跨会话记忆 方案' }, { agent: { session } })
    })
    .then((result) => {
      assert.match(result.text, /found 1 memory record/)
      assert.match(result.text, /node:sqlite/)
        })
})

test('pre-step injects recalled memory once per turn and keeps the user decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const { ctx, handlers, tools } = fakeCtx()
  apply(ctx, { dbPath: join(dir, 'memory.db'), maxItems: 3 })

  // seed one fact through the tool layer
  await tools.get('memory_save').execute(
    { text: '用户偏好：所有命令用 pwsh，不要用 bash', scope: 'global' },
    {},
  )

  const session = fakeSession()
  session.events = [
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我写个脚本命令跑测试' }] } },
  ]
  const preStep = handlers.get('agent/pre-step')
  const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我写个脚本命令跑测试' }], source: { kind: 'user' } }

  const first = await preStep({ agent: { session }, messages: [userMessage], turn: 7, step: 1, signal: { aborted: false } }, async () => ({
    kind: 'enter',
    messages: [userMessage],
  }))
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[0], userMessage)
  assert.match(first.messages[1].content[0].text, /<memory_context/)
  assert.match(first.messages[1].content[0].text, /pwsh/)
  // a global fact matched by both the globals pass and the recall pass is rendered once
  assert.equal(first.messages[1].content[0].text.match(/pwsh/g).length, 1)
  // producer-owned source kind (v4 rejects the retired { kind: 'plugin', plugin } wrapper)
  assert.equal(first.messages[1].source.kind, 'plugin:dsh-memory')
  assert.equal(first.messages[1].source.plugin, undefined)
  assert.equal(first.messages[1].source.form, 'recall')

  // second step in the same turn must not inject again
  const second = await preStep({ agent: { session }, messages: [], turn: 7, step: 2, signal: { aborted: false } }, async () => ({
    kind: 'enter',
    messages: [userMessage],
  }))
  assert.equal(second.messages.length, 1)

  // a rejected step stays rejected
  const rejected = await preStep({ agent: { session }, messages: [userMessage], turn: 8, step: 1, signal: { aborted: false } }, async () => ({
    kind: 'reject',
  }))
  assert.equal(rejected.kind, 'reject')

})

test('memory_forget removes a wrong memory by id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dbPath: join(dir, 'memory.db') })
  const saved = await tools.get('memory_save').execute({ text: '错误结论：CI 会跑测试' }, {})
  const id = Number(saved.text.match(/#(\d+)/)[1])
  const removed = await tools.get('memory_forget').execute({ ids: [id] }, {})
  assert.match(removed.text, /deleted 1 memory/)
  const statsResult = await tools.get('memory_stats').execute({}, {})
  assert.match(statsResult.text, /memories=0/)
})


