import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BASE_URL,
  KNOWN_MODEL_DIMS,
  createEmbeddingClient,
  embeddingTag,
  isCredentialRef,
  knownDims,
  normalizeEndpoint,
  normalizeModelName,
  resolveDims,
  toUnitVector,
} from '../src/embedding.js'
import { VECTOR_DIMS, VECTOR_MODEL } from '../src/vector.js'

/** A fetch double: records calls, answers with a JSON payload. */
function fakeFetch(payload, options = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null })
    if (options.status !== undefined && options.status !== 200) {
      return { ok: false, status: options.status, async text() { return options.body ?? 'nope' } }
    }
    if (typeof payload === 'function') {
      const value = payload(JSON.parse(init.body))
      return { ok: true, status: 200, async json() { return value } }
    }
    return { ok: true, status: 200, async json() { return payload } }
  }
  return { impl, calls }
}

/** `{ data: [{ embedding }] }` for a list of vectors. */
const vectorsPayload = (vectors) => ({
  data: vectors.map((embedding, index) => ({ embedding, index })),
})

test('normalizeModelName strips org prefix, tag suffix and case', () => {
  assert.equal(normalizeModelName('BAAI/bge-m3'), 'bge-m3')
  assert.equal(normalizeModelName('bge-m3:latest'), 'bge-m3')
  assert.equal(normalizeModelName('  Text-Embedding-3-Small '), 'text-embedding-3-small')
  assert.equal(normalizeModelName('nomic-embed-text:v1.5'), 'nomic-embed-text')
  assert.equal(normalizeModelName(''), '')
  assert.equal(normalizeModelName(undefined), '')
})

test('knownDims matches exactly, by prefix, and gives up otherwise', () => {
  assert.equal(knownDims('text-embedding-3-small'), 1536)
  assert.equal(knownDims('BAAI/bge-m3:latest'), 1024)
  assert.equal(knownDims('text-embedding-3-small-custom'), 1536)
  assert.equal(knownDims('nomic-embed-text'), 768)
  assert.equal(knownDims('totally-unknown-model'), null)
  assert.equal(knownDims(''), null)
  assert.equal(KNOWN_MODEL_DIMS['bge-m3'], 1024)
})

test('resolveDims: explicit wins, then the known table, else unknown', () => {
  assert.deepEqual(resolveDims('bge-m3', 7), { dims: 7, source: 'config' })
  assert.deepEqual(resolveDims('bge-m3', 0), { dims: 1024, source: 'known' })
  assert.deepEqual(resolveDims('bge-m3', undefined), { dims: 1024, source: 'known' })
  assert.deepEqual(resolveDims('mystery', 0), { dims: null, source: null })
  assert.deepEqual(resolveDims('mystery', -5), { dims: null, source: null })
})

test('normalizeEndpoint accepts a base URL, an origin and a full endpoint', () => {
  assert.equal(normalizeEndpoint(''), `${DEFAULT_BASE_URL}/embeddings`)
  assert.equal(normalizeEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/embeddings')
  assert.equal(normalizeEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/embeddings')
  assert.equal(normalizeEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/embeddings')
  assert.equal(normalizeEndpoint('http://host/v1/embeddings'), 'http://host/v1/embeddings')
})

test('embeddingTag carries the width so a width change invalidates rows', () => {
  assert.equal(embeddingTag('hash', '', 384), VECTOR_MODEL)
  assert.equal(embeddingTag('openai', 'bge-m3', 1024), 'openai:bge-m3@1024')
  assert.equal(embeddingTag('openai', 'bge-m3', null), null)
  assert.equal(embeddingTag('openai', '', 1024), null)
  // The same model at two widths must never share a tag.
  assert.notEqual(embeddingTag('openai', 'm', 8), embeddingTag('openai', 'm', 16))
})

test('isCredentialRef distinguishes env var names from literal secrets', () => {
  assert.equal(isCredentialRef('OPENAI_API_KEY'), true)
  assert.equal(isCredentialRef('_x1'), true)
  assert.equal(isCredentialRef('sk-abc123'), false)
  assert.equal(isCredentialRef('a b'), false)
  assert.equal(isCredentialRef(''), false)
})

test('toUnitVector normalizes and keeps zeros at zero', () => {
  const unit = toUnitVector([3, 4])
  assert.equal(unit.length, 2)
  assert.ok(Math.abs(Math.hypot(unit[0], unit[1]) - 1) < 1e-6)
  assert.deepEqual([...toUnitVector([0, 0])], [0, 0])
  assert.ok(unit instanceof Float32Array)
})

test('hash provider is the default and needs no network', async () => {
  const client = createEmbeddingClient({})
  assert.equal(client.provider, 'hash')
  assert.equal(client.available, true)
  assert.equal(client.tag, VECTOR_MODEL)
  assert.equal(client.dims, VECTOR_DIMS)
  const result = await client.embedOne('部署流程用 pnpm')
  assert.equal(result.ok, true)
  assert.equal(result.vector.length, VECTOR_DIMS)
  assert.equal((await client.probe()).ok, true)
})

test('remote client resolves the width from the known table without a probe', () => {
  const { impl, calls } = fakeFetch(vectorsPayload([[1, 0, 0]]))
  const client = createEmbeddingClient({ provider: 'openai', model: 'bge-m3' }, { fetch: impl })
  assert.equal(client.available, true)
  assert.equal(client.dims, 1024)
  assert.equal(client.dimsSource, 'known')
  assert.equal(client.tag, 'openai:bge-m3@1024')
  assert.equal(calls.length, 0, 'a known model must not probe')
})

test('remote client honors an explicit width and rejects a mismatch', async () => {
  const okFetch = fakeFetch(vectorsPayload([[1, 0, 0]]))
  const ok = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 3 }, { fetch: okFetch.impl })
  assert.equal(ok.tag, 'openai:toy@3')
  const embedded = await ok.embed(['hello'])
  assert.equal(embedded.ok, true)
  assert.equal(embedded.vectors[0].length, 3)

  const badFetch = fakeFetch(vectorsPayload([[1, 0]]))
  const bad = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 3 }, { fetch: badFetch.impl })
  const mismatch = await bad.embed(['hello'])
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.error, /dimension-mismatch: model returned 2, configured 3/)
})

test('remote client adopts the width from the first response and caches it', async () => {
  // Unknown model: no knowledge, no explicit width -> the response decides.
  let stored
  const { impl, calls } = fakeFetch(vectorsPayload([[0.6, 0.8]]))
  const client = createEmbeddingClient(
    { provider: 'openai', model: 'mystery', baseUrl: 'http://host/v1' },
    { fetch: impl, metaGet: () => stored, metaSet: (key, value) => { stored = value } },
  )
  assert.equal(client.dims, null)
  assert.equal(client.tag, null)
  const first = await client.embedOne('first text')
  assert.equal(first.ok, true)
  assert.equal(client.dims, 2)
  assert.equal(client.dimsSource, 'probed')
  assert.equal(client.tag, 'openai:mystery@2')
  assert.ok(typeof stored === 'string' && stored.includes('2'), 'probed width is cached in meta')

  // A fresh client (same database) resolves the width from the cache: no probe.
  const second = createEmbeddingClient(
    { provider: 'openai', model: 'mystery', baseUrl: 'http://host/v1' },
    { fetch: impl, metaGet: () => stored, metaSet: () => {} },
  )
  const resolved = await second.ensureDims()
  assert.equal(resolved.ok, true)
  assert.equal(resolved.dims, 2)
  assert.equal(resolved.source, 'cache')
  assert.equal(calls.length, 1, 'only the first client hit the endpoint')
})

test('remote client normalizes returned vectors to unit length', async () => {
  const { impl } = fakeFetch(vectorsPayload([[3, 4]]))
  const client = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 2 }, { fetch: impl })
  const result = await client.embed(['x'])
  assert.equal(result.ok, true)
  const [a, b] = result.vectors[0]
  assert.ok(Math.abs(Math.hypot(a, b) - 1) < 1e-6)
})

test('remote client sends the model, the inputs and the resolved key', async () => {
  const { impl, calls } = fakeFetch(vectorsPayload([[1, 0]]))
  const client = createEmbeddingClient(
    { provider: 'openai', model: 'toy', dims: 2, apiKeyRef: 'MY_EMBED_KEY' },
    { fetch: impl, resolveSecret: (ref) => (ref === 'MY_EMBED_KEY' ? 'secret-value' : null) },
  )
  await client.embed(['a', 'b'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_BASE_URL}/embeddings`)
  assert.deepEqual(calls[0].body, { model: 'toy', input: ['a', 'b'] })
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-value')

  // A literal key (not an identifier) is sent as-is, without the resolver.
  const literal = fakeFetch(vectorsPayload([[1, 0]]))
  let resolverCalls = 0
  const literalClient = createEmbeddingClient(
    { provider: 'openai', model: 'toy', dims: 2, apiKeyRef: 'sk-literal' },
    { fetch: literal.impl, resolveSecret: () => { resolverCalls += 1; return null } },
  )
  await literalClient.embed(['a'])
  assert.equal(resolverCalls, 0)
  assert.equal(literal.calls[0].init.headers.authorization, 'Bearer sk-literal')
})

test('a credential provider answer of { value } is unwrapped, not stringified', async () => {
  const { impl, calls } = fakeFetch(vectorsPayload([[1, 0]]))
  const client = createEmbeddingClient(
    { provider: 'openai', model: 'toy', dims: 2, apiKeyRef: 'MY_KEY' },
    { fetch: impl, resolveSecret: async () => ({ value: 'from-provider', source: 'file' }) },
  )
  await client.embed(['a'])
  assert.equal(calls[0].init.headers.authorization, 'Bearer from-provider')

  // An unconfigured reference means no Authorization header at all.
  const anonymous = fakeFetch(vectorsPayload([[1, 0]]))
  const noKey = createEmbeddingClient(
    { provider: 'openai', model: 'toy', dims: 2, apiKeyRef: 'MISSING_KEY' },
    { fetch: anonymous.impl, resolveSecret: async () => undefined },
  )
  await noKey.embed(['a'])
  assert.equal(anonymous.calls[0].init.headers.authorization, undefined)
})

test('remote client surfaces HTTP failures with the status', async () => {
  const { impl } = fakeFetch(null, { status: 401, body: 'invalid api key' })
  const client = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 2 }, { fetch: impl })
  const result = await client.embed(['x'])
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 401/)
  assert.match(result.error, /vector\.apiKeyRef/, 'the message points at the setting to check')
})

test('remote client reports a timeout instead of hanging', async () => {
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener?.('abort', () => reject(new Error('The operation was aborted')))
      void resolve // never resolves on its own
    })
  const client = createEmbeddingClient(
    { provider: 'openai', model: 'toy', dims: 2, timeoutMs: 500 },
    { fetch: hangingFetch },
  )
  const result = await client.embed(['x'])
  assert.equal(result.ok, false)
  assert.match(result.error, /timeout after 500ms/)
})

test('remote client without a model is unavailable but never throws', async () => {
  const { impl, calls } = fakeFetch(vectorsPayload([[1, 0]]))
  const client = createEmbeddingClient({ provider: 'openai', model: '  ' }, { fetch: impl })
  assert.equal(client.available, false)
  assert.match(String(client.error), /no model configured/)
  const result = await client.embed(['x'])
  assert.equal(result.ok, false)
  assert.match(result.error, /unavailable/)
  assert.equal(calls.length, 0)
})

test('query vectors are cached and the cache is keyed by model', async () => {
  const { impl, calls } = fakeFetch(vectorsPayload([[1, 0]]))
  const client = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 2 }, { fetch: impl })
  await client.embedOne('same query')
  await client.embedOne('same query')
  assert.equal(calls.length, 1, 'the second identical query is served from cache')
  await client.embedOne('other query')
  assert.equal(calls.length, 2)
  assert.equal(await client.embedOne('   ').then((r) => r.ok), false, 'blank text is not embedded')
})

test('a response without data[].embedding is rejected, not silently accepted', async () => {
  const { impl } = fakeFetch({ ok: true })
  const client = createEmbeddingClient({ provider: 'openai', model: 'toy', dims: 2 }, { fetch: impl })
  const result = await client.embed(['x'])
  assert.equal(result.ok, false)
  assert.match(result.error, /no data\[\]\.embedding/)
})
