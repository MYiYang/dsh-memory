import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  DECISION_FAILURE_REASONS,
  DecisionProviderError,
  buildChoicePrompt,
  createDecisionProvider,
  createHttpDecisionProvider,
  createLlmDecisionProvider,
  hasDecisionProvider,
  isLoopbackHost,
  listDecisionProviders,
  parseChoiceResponse,
  parseDecisionEndpoint,
  registerDecisionProvider,
  resetDecisionProviders,
} from '../src/decision.js'

const QUESTION = {
  id: 'memory_change',
  instructions: '比较变化场景与现有画像，只返回一个标签。',
  criteria: { conflict: '推翻', boundary_change: '范围变了', new_rule: '新规则', reinforcement: '复述', none: '无关' },
}

function fakeLlm(responses) {
  const calls = []
  return {
    available: true,
    model: 'fake-judge',
    calls,
    async complete(request) {
      calls.push(request)
      const next = responses.shift() ?? { ok: true, text: '{}', usage: null }
      return { ok: false, text: '', reason: null, error: null, usage: null, ...next }
    },
  }
}

test('the registry ships the two built-in providers and refuses unknown names', () => {
  resetDecisionProviders()
  assert.deepEqual(listDecisionProviders(), ['jev', 'llm'])
  assert.equal(hasDecisionProvider('llm'), true)
  assert.equal(hasDecisionProvider('nope'), false)
  assert.throws(() => createDecisionProvider('nope'), (error) => {
    assert.ok(error instanceof DecisionProviderError)
    assert.equal(error.reason, 'invalid_config')
    return true
  })
})

test('registerDecisionProvider validates the name and needs an explicit override', () => {
  resetDecisionProviders()
  assert.throws(() => registerDecisionProvider('Bad Name', () => ({})), /invalid provider name/)
  assert.throws(() => registerDecisionProvider('jev', () => ({})), /already registered/)
  registerDecisionProvider('custom', () => ({ name: 'custom' }))
  assert.equal(createDecisionProvider('custom').name, 'custom')
  registerDecisionProvider('jev', () => ({ name: 'jev2' }), { override: true })
  assert.equal(createDecisionProvider('jev').name, 'jev2')
  resetDecisionProviders()
  assert.deepEqual(listDecisionProviders(), ['jev', 'llm'])
})

test('the local provider asks the model once and validates the label', async () => {
  const llm = fakeLlm([
    { ok: true, text: JSON.stringify({ choice: 'conflict', confidence: 0.7 }), usage: { inputTokens: 11, outputTokens: 3 } },
  ])
  const provider = createLlmDecisionProvider({}, { llm })
  assert.equal(provider.isUsable(), true)
  const answers = await provider.askChoices('现状：画像说 A', [QUESTION])
  const answer = answers.get('memory_change')
  assert.equal(answer.choice, 'conflict')
  assert.equal(answer.confidence, 0.7)
  assert.deepEqual(answer.usage, { inputTokens: 11, outputTokens: 3 })
  // The prompt carries the criteria, so the model cannot invent a label.
  assert.match(llm.calls[0].system, /conflict/)
  assert.match(llm.calls[0].user, /现状：画像说 A/)
})

test('the local provider rejects an unusable client, a missing choice and an invented label', async () => {
  const unusable = createLlmDecisionProvider({}, {})
  assert.equal(unusable.isUsable(), false)
  await assert.rejects(() => unusable.askChoices('s', [QUESTION]), /no llm client/)

  const missing = createLlmDecisionProvider({}, { llm: fakeLlm([{ ok: true, text: '{}' }]) })
  await assert.rejects(() => missing.askChoices('s', [QUESTION]), (error) => error.reason === 'missing_answer')

  const invented = createLlmDecisionProvider({}, { llm: fakeLlm([{ ok: true, text: JSON.stringify({ choice: 'maybe' }) }]) })
  await assert.rejects(() => invented.askChoices('s', [QUESTION]), (error) => error.reason === 'invalid_choice')

  const failed = createLlmDecisionProvider({}, { llm: fakeLlm([{ ok: false, error: 'model down' }]) })
  await assert.rejects(() => failed.askChoices('s', [QUESTION]), (error) => error.reason === 'fetch_failed')
})

test('a model answer wrapped in prose still parses', () => {
  // The first JSON object carries no usable label, so the parser falls back to
  // the last choice literal in the text — the model's actual answer.
  const text = ['{"thought":"先把判断标准想一遍"}', '最终：{"choice":"boundary_change"}'].join(String.fromCharCode(10))
  assert.equal(parseChoiceResponse(text, QUESTION).choice, 'boundary_change')
  // A bare answer keeps working unchanged.
  assert.equal(parseChoiceResponse('{"choice":"conflict"}', QUESTION).choice, 'conflict')
})

test('endpoint validation allows https and loopback http only', () => {
  assert.equal(parseDecisionEndpoint('https://api.example.com/v1/systemone').hostname, 'api.example.com')
  assert.equal(parseDecisionEndpoint('http://127.0.0.1:8080/judge').hostname, '127.0.0.1')
  assert.equal(parseDecisionEndpoint('http://localhost:9000/judge').hostname, 'localhost')
  assert.equal(parseDecisionEndpoint('http://api.example.com/judge'), null)
  assert.equal(parseDecisionEndpoint('ftp://api.example.com/judge'), null)
  assert.equal(parseDecisionEndpoint(''), null)
  assert.equal(parseDecisionEndpoint('not a url'), null)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('example.com'), false)
})

test('the remote provider sends the upstream wire format', async () => {
  const seen = []
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { memory_change: { type: 'choice', choice: 'new_rule', confidence: 0.9 } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const provider = createHttpDecisionProvider(
    { endpoint: 'https://api.example.com/v1/systemone', apiKey: 'sk-test', model: 'jev-latest', timeoutMs: 3_000 },
    { fetcher },
  )
  assert.equal(provider.isUsable(), true)
  const answers = await provider.askChoices('状态正文', [QUESTION])
  assert.equal(answers.get('memory_change').choice, 'new_rule')
  assert.equal(answers.get('memory_change').confidence, 0.9)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.example.com/v1/systemone')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(seen[0].init.body)
  assert.equal(body.model, 'jev-latest')
  assert.equal(body.state, '状态正文')
  assert.equal(body.questions.memory_change.type, 'choice')
  assert.equal(body.questions.memory_change.instructions, QUESTION.instructions)
  assert.deepEqual(body.questions.memory_change.criteria, QUESTION.criteria)
})

test('the remote provider maps transport and payload failures to stable reasons', async () => {
  const calls = []
  const failing = (status, body) => async () => {
    calls.push(status)
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
  const build = (fetcher) =>
    createHttpDecisionProvider({ endpoint: 'https://api.example.com/x', apiKey: 'k', model: 'm' }, { fetcher })

  await assert.rejects(
    () => build(failing(500, '{}')).askChoices('s', [QUESTION]),
    (error) => error.reason === 'http_error' && error.status === 500,
  )
  await assert.rejects(
    () => build(failing(200, 'not json')).askChoices('s', [QUESTION]),
    (error) => error.reason === 'non_json',
  )
  await assert.rejects(
    () => build(failing(200, JSON.stringify({ model: 'x' }))).askChoices('s', [QUESTION]),
    (error) => error.reason === 'invalid_response',
  )
  await assert.rejects(
    () => build(failing(200, JSON.stringify({ answers: { memory_change: {} } }))).askChoices('s', [QUESTION]),
    (error) => error.reason === 'missing_answer',
  )
  await assert.rejects(
    () => build(failing(200, JSON.stringify({ answers: { memory_change: { choice: 'invented' } } }))).askChoices('s', [QUESTION]),
    (error) => error.reason === 'invalid_choice',
  )
  await assert.rejects(
    () => build(async () => { throw new Error('ECONNREFUSED') }).askChoices('s', [QUESTION]),
    (error) => error.reason === 'fetch_failed',
  )
  assert.ok(DECISION_FAILURE_REASONS.includes('http_error'))
})

test('an incomplete remote config is unusable and says why', async () => {
  const cases = [
    [{ endpoint: '', apiKey: 'k', model: 'm' }, /endpoint/],
    [{ endpoint: 'http://api.example.com/x', apiKey: 'k', model: 'm' }, /https/],
    [{ endpoint: 'https://api.example.com/x', apiKey: '', model: 'm' }, /apiKeyRef/],
    [{ endpoint: 'https://api.example.com/x', apiKey: 'k', model: '' }, /model/],
  ]
  for (const [params, message] of cases) {
    const provider = createHttpDecisionProvider(params, { fetcher: async () => new Response('{}') })
    assert.equal(provider.isUsable(), false)
    await assert.rejects(() => provider.askChoices('s', [QUESTION]), (error) => {
      assert.equal(error.reason, 'invalid_config')
      assert.match(error.message, message)
      return true
    })
  }
})

test('a loopback judge works over plain http end to end', async () => {
  const seen = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(raw) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ answers: { memory_change: { type: 'choice', choice: 'conflict' } } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const provider = createHttpDecisionProvider(
      { endpoint: `http://127.0.0.1:${port}/v1/systemone`, apiKey: 'local-key', model: 'jev-latest' },
      {},
    )
    const answers = await provider.askChoices('本地状态', [QUESTION])
    assert.equal(answers.get('memory_change').choice, 'conflict')
    assert.equal(seen[0].url, '/v1/systemone')
    assert.equal(seen[0].auth, 'Bearer local-key')
    assert.equal(seen[0].body.state, '本地状态')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('buildChoicePrompt lists every label with its criteria', () => {
  const prompt = buildChoicePrompt('状态', QUESTION)
  for (const label of Object.keys(QUESTION.criteria)) assert.match(prompt.system, new RegExp(label))
  assert.match(prompt.system, /choice/)
  assert.equal(prompt.user, '状态')
})
