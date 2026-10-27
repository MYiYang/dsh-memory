import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'
import { openDatabase } from '../src/store.js'
import { recall } from '../src/recall.js'

/**
 * Toy embedding model: a text maps to the *topic* it is about, not to its
 * wording. `构建 / build / compile` is topic A, everything else topic B — which
 * is what lets a query with no shared term match a memory.
 */
function toyVector(text) {
  return /构建|build|compile|打包/i.test(String(text)) ? [1, 0, 0] : [0, 1, 0]
}

/** Minimal OpenAI-compatible `/v1/embeddings` endpoint on a random port. */
function startEmbeddingServer() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      requests.push({ url: req.url, payload })
      const inputs = Array.isArray(payload.input) ? payload.input : [String(payload.input ?? '')]
      const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: toyVector(text) }))
      const out = JSON.stringify({ object: 'list', data, model: payload.model, usage: { prompt_tokens: 1, total_tokens: 1 } })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(out)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port })
    })
  })
}

/** Minimal cordis ctx: only what `apply` touches here. */
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

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** Run the pre-step handler of one turn and return the injected text. */
async function inject(handlers, session, text, turn) {
  const preStep = handlers.get('agent/pre-step')
  const decision = await preStep(
    { agent: { session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }], turn, step: 1, signal: {} },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return (decision.messages ?? []).map((message) => message.content?.[0]?.text ?? '').join('\n')
}

test('a configured model backfills saved memories and the next turn recalls by meaning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-semantic-'))
  const dbPath = join(dir, 'memory.db')
  const { server, requests, port } = await startEmbeddingServer()
  try {
    const { ctx, handlers, tools } = fakeCtx()
    apply(ctx, {
      dbPath,
      settingsPath: join(dirname(dbPath), 'settings.json'),
      capture: false,
      extraction: { enabled: false },
      vector: {
        provider: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'toy-embed',
        dims: 3,
        minCosine: 0.5,
        weight: 0.4,
      },
    })

    const saved = await tools.get('memory_save').execute({ text: '构建用 pnpm', scope: 'global' }, {})
    assert.match(saved.text, /saved memory/)

    const db = openDatabase(dbPath)
    const backfilled = await waitFor(() => Number(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n) === 1)
    assert.equal(backfilled, true, 'the worker embedded the saved row')
    const stored = db.prepare('SELECT model, dims FROM memory_embeddings').get()
    assert.equal(stored.model, 'openai:toy-embed@3', 'stored under the resolved tag')
    assert.equal(stored.dims, 3)

    // The lexical channel cannot find it: the query shares no term with the memory.
    const lexicalOnly = recall(db, 'compile the project', { scope: 'global', minScore: 0, touch: false })
    assert.equal(lexicalOnly.items.length, 0)

    const session = { id: 'session-semantic', header: { cwd: 'F:\\work\\demo' }, events: [] }
    const injected = await inject(handlers, session, 'compile the project', 1)
    assert.match(injected, /构建用 pnpm/, 'the memory is injected through the configured model')
    assert.ok(
      requests.some((request) => (request.payload.input ?? []).includes('compile the project')),
      'the query itself was embedded',
    )

    // The endpoint goes down: the turn must still work, on the lexical channel.
    await new Promise((resolve) => server.close(resolve))
    const fallback = await inject(handlers, { id: 'session-down', header: { cwd: 'F:\\work\\demo' } }, '构建用 pnpm', 1)
    assert.match(fallback, /构建用 pnpm/, 'a dead embedding endpoint degrades to lexical recall')
    db.close()
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
})

test('the built-in algorithm still runs when nothing is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-hash-'))
  const dbPath = join(dir, 'memory.db')
  const { ctx, handlers, tools } = fakeCtx()
  apply(ctx, {
    dbPath,
    settingsPath: join(dirname(dbPath), 'settings.json'),
    capture: false,
    extraction: { enabled: false },
  })
  await tools.get('memory_save').execute({ text: '部署流程用 pnpm', scope: 'global' }, {})
  const db = openDatabase(dbPath)
  // No table rows: the default configuration never talks to a provider.
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n), 0)
  const injected = await inject(handlers, { id: 'session-hash', header: { cwd: 'F:\\work\\demo' } }, '部署流程', 1)
  assert.match(injected, /部署流程用 pnpm/, 'lexical recall is unchanged')
  db.close()
})
