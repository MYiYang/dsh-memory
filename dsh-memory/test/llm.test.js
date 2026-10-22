import test from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient, resolveModel } from '../src/llm.js'

function chunksFor(text, usage = { inputTokens: 11, outputTokens: 7 }) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function fakeCtx(options = {}) {
  const calls = []
  const service = {
    stream(request) {
      calls.push(request)
      return (async function* stream() {
        for (const chunk of options.chunks ?? chunksFor('hello')) yield chunk
        if (options.throwError) throw new Error(options.throwError)
      })()
    },
  }
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'llm') return options.noService ? undefined : service
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => options.selection ?? { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } }
        }
        return undefined
      },
    },
  }
}

test('resolveModel prefers explicit config over the host default', () => {
  const { ctx } = fakeCtx()
  assert.deepEqual(resolveModel(ctx, {}), {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  })
  const override = resolveModel(ctx, { provider: 'p', model: 'm' })
  assert.equal(override.provider, 'p')
  assert.equal(override.model, 'm')
})

test('complete streams text and usage through the llm service', async () => {
  const { ctx, calls } = fakeCtx()
  const client = createLlmClient(ctx, {})
  assert.equal(client.available, true)
  const result = await client.complete({ system: 'sys', user: 'hi', maxTokens: 64, sessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'hello')
  assert.equal(result.usage.outputTokens, 7)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'workbuddy')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(calls[0].system, 'sys')
  assert.equal(calls[0].messages[0].content[0].text, 'hi')
  assert.equal(calls[0].sessionId, 's1')
})

test('a model error finish chunk becomes ok=false with the failure message', async () => {
  const { ctx } = fakeCtx({
    chunks: [
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 500', code: 'http_500' } } },
    ],
  })
  const client = createLlmClient(ctx, {})
  const result = await client.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'upstream 500')
})

test('a thrown stream error is captured, never propagated', async () => {
  const { ctx } = fakeCtx({ throwError: 'socket hang up' })
  const client = createLlmClient(ctx, {})
  const result = await client.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.error, /socket hang up/)
})

test('missing llm service or selection disables the client with one warning', async () => {
  const logs = []
  const { ctx } = fakeCtx({ noService: true })
  const client = createLlmClient(ctx, {}, (level, message) => logs.push([level, message]))
  assert.equal(client.available, false)
  assert.equal(logs.length, 1)
  assert.match(logs[0][1], /no llm service/)
  const result = await client.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'llm-unavailable')

  const noSelection = fakeCtx({ selection: { provider: '', model: '' } })
  const second = createLlmClient(noSelection.ctx, {})
  assert.equal(second.available, false)
})
