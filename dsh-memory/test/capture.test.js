import test from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../src/store.js'
import { buildEpisodeText, captureTurn, clip, extractText, firstLine } from '../src/capture.js'

test('extractText handles strings, anthropic blocks and tool noise', () => {
  assert.equal(extractText('hello'), 'hello')
  assert.equal(
    extractText([
      { type: 'text', text: 'first' },
      { type: 'thinking', thinking: 'secret' },
      { type: 'tool_use', name: 'bash' },
      { type: 'text', text: 'second' },
    ]),
    'first\nsecond',
  )
  assert.equal(extractText([{ type: 'tool_result', content: 'noise' }]), '')
  assert.equal(extractText({ content: [{ type: 'output_text', text: 'nested' }] }), 'nested')
  assert.equal(extractText(undefined), '')
})

test('clip keeps head and marks truncation', () => {
  assert.equal(clip('abcdef', 10), 'abcdef')
  assert.equal(clip('abcdef', 4), 'abc…')
})

test('buildEpisodeText skips trivial turns', () => {
  assert.equal(buildEpisodeText({ userText: 'ok', assistantText: '好的' }), null)
  assert.equal(buildEpisodeText({ userText: '', assistantText: '' }), null)
})

test('buildEpisodeText includes user, assistant and tool names', () => {
  const text = buildEpisodeText({
    userText: '帮我查一下部署脚本怎么校验 LLM',
    assistantText: '脚本用 GET /models 探活，不消耗 token。',
    toolNames: ['bash', 'bash', 'read'],
  })
  assert.match(text, /^用户: 帮我查一下/)
  assert.match(text, /助手: 脚本用 GET/)
  assert.match(text, /工具: bash, read/)
})

test('captureTurn persists an episode and dedupes the same exchange', () => {
  const db = openDatabase(':memory:')
  const first = captureTurn(db, {
    sessionId: 'session-1',
    project: 'menm',
    userText: '给 dsh 加记忆插件，用 node:sqlite 存',
    assistantText: '方案定了：pre-step 注入 + 每轮结束落库，零依赖。',
    toolNames: ['write', 'bash'],
  })
  assert.ok(first && first.inserted)
  const second = captureTurn(db, {
    sessionId: 'session-1',
    project: 'menm',
    userText: '给 dsh 加记忆插件，用 node:sqlite 存',
    assistantText: '方案定了：pre-step 注入 + 每轮结束落库，零依赖。',
    toolNames: ['write', 'bash'],
  })
  assert.equal(second.inserted, false)
  assert.equal(second.id, first.id)
  const row = db.prepare('SELECT kind, scope, project, source, title FROM memory WHERE id = ?').get(first.id)
  assert.equal(row.kind, 'episode')
  assert.equal(row.scope, 'project')
  assert.equal(row.source, 'turn')
  assert.match(row.title, /给 dsh 加记忆插件/)
  db.close()
})

test('captureTurn without a project stores a global episode title', () => {
  const db = openDatabase(':memory:')
  const saved = captureTurn(db, {
    userText: '记录一下：以后所有 shell 命令都用 pwsh 而不是 bash',
    assistantText: '好的，已记下这条偏好。',
  })
  assert.ok(saved)
  const row = db.prepare('SELECT scope, project FROM memory WHERE id = ?').get(saved.id)
  assert.equal(row.scope, 'global')
  assert.equal(row.project, null)
  db.close()
})

test('firstLine returns the first non-empty trimmed line', () => {
  assert.equal(firstLine('\n\n  hello world  \nsecond'), 'hello world')
  assert.equal(firstLine(''), '')
})
