/**
 * The "vector model" runtime: the built-in lexical embedder or a configured
 * OpenAI-compatible `/embeddings` endpoint.
 *
 * Two providers, one shape. Callers never branch on the provider except where
 * they must (the background worker only backfills an external model; recall
 * keeps its synchronous lexical path):
 *
 *   - `hash`   — the in-process 384-dim lexical feature hash from vector.js.
 *                No model, no network, no key. This is what runs when the user
 *                has not configured anything (ANALYSIS-vector-model.md §4.1).
 *   - `openai` — `POST {baseUrl}/embeddings` with `{ model, input }`, vectors
 *                L2-normalized here so cosine is a dot product.
 *
 * Why a client object instead of a plain function: the identity of a vector
 * (`tag`) depends on the resolved width, and the width may only be known after
 * the provider answers (config → known-model table → cached probe → live probe).
 * The client owns that resolution so every write and every query stamps and
 * reads the same tag.
 *
 * Failure policy: nothing here throws. Every call returns `{ ok, ... }` with a
 * one-line `error`, because a missing embedding must degrade recall to the
 * lexical branch, never break a turn.
 *
 * @module dsh-memory/embedding
 */
import { VECTOR_DIMS, VECTOR_MODEL, embed as embedLexical } from './vector.js'

/** Providers the settings enum accepts. */
export const PROVIDERS = /** @type {const} */ (['hash', 'openai'])

/** Used when `vector.baseUrl` is empty (OpenAI proper). */
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Per-request ceiling; the query path clamps this further (see QUERY_TIMEOUT_MS). */
export const DEFAULT_TIMEOUT_MS = 5_000

/** A pre-step embedding may not cost more than this, whatever the config says. */
export const QUERY_TIMEOUT_MS = 5_000

/** Absolute cosine floor for a semantic candidate (model families differ a lot). */
export const DEFAULT_MIN_COSINE = 0.5

/** Meta key holding the probed-dimension cache (`{ [endpoint|model]: dims }`). */
export const EMBEDDING_DIMS_META_KEY = 'embedding-dims'

/** How many query texts the client remembers (a retried step reuses its vector). */
export const QUERY_CACHE_LIMIT = 32

/** Refuse to buffer an error body larger than this when building a message. */
const MAX_ERROR_BODY = 400

/**
 * Default widths of well-known embedding models.
 *
 * Only a convenience: it saves one probe round trip and makes "读默认维度"
 * work offline. An explicit `vector.dims` always wins, and any model missing
 * here is detected from the first response instead.
 */
export const KNOWN_MODEL_DIMS = /** @type {Record<string, number>} */ ({
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'bge-m3': 1024,
  'bge-large-zh-v1.5': 1024,
  'bge-large-zh': 1024,
  'bge-large-en-v1.5': 1024,
  'bge-base-zh-v1.5': 768,
  'bge-base-en-v1.5': 768,
  'bge-small-zh-v1.5': 512,
  'nomic-embed-text': 768,
  'nomic-embed-text-v1.5': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'all-minilm-l6-v2': 384,
  'jina-embeddings-v3': 1024,
  'jina-embeddings-v2-base-zh': 768,
  'jina-embeddings-v2-base-en': 768,
  'text2vec-large-chinese': 1024,
  'text2vec-base-chinese': 768,
  'm3e-base': 768,
  'm3e-large': 1024,
  'gte-large': 1024,
  'gte-base': 768,
  'snowflake-arctic-embed': 1024,
  'text-embedding-v1': 1536,
  'text-embedding-v2': 1536,
  'text-embedding-v3': 1024,
  'text-embedding-v4': 1024,
  'embed-english-v3.0': 1024,
  'embed-multilingual-v3.0': 1024,
  'voyage-3': 1024,
  'voyage-3-lite': 512,
})

/**
 * Normalize a model id for table lookup: lowercase, drop an `org/` prefix and an
 * Ollama `:tag` suffix. `BAAI/bge-m3:latest` → `bge-m3`.
 * @param {string} model
 * @returns {string}
 */
export function normalizeModelName(model) {
  let value = String(model ?? '').trim().toLowerCase()
  const colon = value.lastIndexOf(':')
  // A colon may also introduce a port in a URL-ish id; only strip a short tail.
  if (colon > 0 && value.length - colon <= 16) value = value.slice(0, colon)
  const slash = value.lastIndexOf('/')
  if (slash >= 0) value = value.slice(slash + 1)
  return value.trim()
}

/**
 * Look up a model's width in {@link KNOWN_MODEL_DIMS}.
 *
 * Exact match first, then the longest known name the id starts with, so
 * `bge-m3-finetuned-2024` and `text-embedding-3-small-custom` still resolve.
 *
 * @param {string} model
 * @returns {number|null}
 */
export function knownDims(model) {
  const name = normalizeModelName(model)
  if (name === '') return null
  const exact = KNOWN_MODEL_DIMS[name]
  if (Number.isFinite(exact)) return Number(exact)
  let best = null
  for (const [key, dims] of Object.entries(KNOWN_MODEL_DIMS)) {
    if (name.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  return best === null ? null : Number(KNOWN_MODEL_DIMS[best])
}

/**
 * Turn a configured base URL into the endpoint actually called.
 *
 * Rules (documented in the settings description):
 *   - empty → the OpenAI default;
 *   - ends with `/embeddings` → used as-is;
 *   - otherwise `/embeddings` is appended, so both `http://host:11434/v1` and
 *     `http://host:11434/v1/` work, as does a bare origin.
 *
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function normalizeEndpoint(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (raw === '') return `${DEFAULT_BASE_URL}/embeddings`
  const withoutSlash = raw.replace(/\/+$/, '')
  if (/\/embeddings$/i.test(withoutSlash)) return withoutSlash
  return `${withoutSlash}/embeddings`
}

/**
 * Resolve a width from configuration or the known-model table.
 * @param {string} model
 * @param {number} [explicitDims] `vector.dims`, 0/absent means auto
 * @returns {{ dims: number|null, source: 'config'|'known'|null }}
 */
export function resolveDims(model, explicitDims) {
  const configured = Number(explicitDims)
  if (Number.isFinite(configured) && configured > 0) return { dims: Math.floor(configured), source: 'config' }
  const known = knownDims(model)
  if (known !== null) return { dims: known, source: 'known' }
  return { dims: null, source: null }
}

/**
 * The identity of a vector: stored next to every embedding and compared on read.
 *
 * The width is part of the tag on purpose — asking the same model for another
 * width produces vectors that may not be compared, and a tag difference is what
 * makes the old rows stale instead of silently mixed.
 *
 * @param {'hash'|'openai'} provider
 * @param {string} model
 * @param {number|null} dims
 * @returns {string|null} null when the width is still unknown
 */
export function embeddingTag(provider, model, dims) {
  if (provider === 'hash') return VECTOR_MODEL
  const width = Number(dims)
  if (!Number.isFinite(width) || width <= 0) return null
  const name = String(model ?? '').trim()
  if (name === '') return null
  return `openai:${name}@${Math.floor(width)}`
}

/**
 * Does `value` look like a credential *reference* (an env var name) rather than
 * a secret? References go through `ctx.credentials`/`process.env`; anything else
 * is treated as a literal key.
 * @param {string} value
 * @returns {boolean}
 */
export function isCredentialRef(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value ?? '').trim())
}

/**
 * L2-normalize in place; a zero vector is returned as zeros (cosine 0).
 * @param {ArrayLike<number>} values
 * @returns {Float32Array}
 */
export function toUnitVector(values) {
  const vector = Float32Array.from(values)
  let sum = 0
  for (let index = 0; index < vector.length; index++) sum += vector[index] * vector[index]
  const norm = Math.sqrt(sum)
  if (norm > 0 && Number.isFinite(norm)) {
    for (let index = 0; index < vector.length; index++) vector[index] /= norm
  }
  return vector
}

/** Error → stable one-line message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Small async-safe LRU: `Map` preserves insertion order, so the head is oldest. */
function createCache(limit) {
  /** @type {Map<string, { vector: Float32Array, dims: number }>} */
  const entries = new Map()
  return {
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      entries.delete(key)
      entries.set(key, hit)
      return hit
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > limit) entries.delete(entries.keys().next().value)
    },
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

/**
 * Built-in provider: wraps vector.js so callers see one interface.
 * @param {{ log?: (level: string, message: string) => void }} [deps]
 */
function createLexicalClient(deps = {}) {
  return {
    provider: /** @type {'hash'} */ ('hash'),
    available: true,
    model: '',
    baseUrl: '',
    endpoint: '',
    dims: VECTOR_DIMS,
    dimsSource: /** @type {'builtin'} */ ('builtin'),
    tag: VECTOR_MODEL,
    error: null,
    async ensureDims() {
      return { ok: true, dims: VECTOR_DIMS, source: 'builtin' }
    },
    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts]
      return { ok: true, vectors: list.map((text) => embedLexical(String(text ?? ''))), dims: VECTOR_DIMS, error: null }
    },
    async embedOne(text) {
      return { ok: true, vector: embedLexical(String(text ?? '')), dims: VECTOR_DIMS, error: null }
    },
    async probe() {
      return { ok: true, dims: VECTOR_DIMS, source: 'builtin', error: null, ms: 0 }
    },
    clearCache() {},
    describe() {
      return { provider: 'hash', model: '', dims: VECTOR_DIMS, dimsSource: 'builtin', tag: VECTOR_MODEL, endpoint: '', available: true, error: null }
    },
    log: deps.log ?? (() => {}),
  }
}

/**
 * OpenAI-compatible provider.
 *
 * @param {{
 *   model?: string, baseUrl?: string, dims?: number, apiKeyRef?: string, timeoutMs?: number,
 * }} config
 * @param {{
 *   fetch?: typeof fetch,
 *   resolveSecret?: (ref: string) => Promise<string|null|undefined> | string|null|undefined,
 *   metaGet?: (key: string) => string|undefined,
 *   metaSet?: (key: string, value: string) => void,
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 * }} [deps]
 */
function createRemoteClient(config = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const log = deps.log ?? (() => {})
  const metaGet = deps.metaGet ?? (() => undefined)
  const metaSet = deps.metaSet ?? (() => {})
  const now = deps.now ?? Date.now
  const model = String(config.model ?? '').trim()
  const baseUrl = String(config.baseUrl ?? '').trim()
  const endpoint = normalizeEndpoint(baseUrl)
  const apiKeyRef = String(config.apiKeyRef ?? '').trim()
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Math.max(500, Math.min(60_000, Number(config.timeoutMs)))
    : DEFAULT_TIMEOUT_MS
  const cacheKey = `${endpoint}|${model}`
  const queryCache = createCache(QUERY_CACHE_LIMIT)

  const initial = resolveDims(model, config.dims)
  /** @type {number|null} */
  let dims = initial.dims
  /** @type {'config'|'known'|'cache'|'probed'|null} */
  let dimsSource = initial.source
  const available = model !== '' && typeof fetchImpl === 'function'
  const unavailableReason = model === ''
    ? 'no model configured'
    : typeof fetchImpl !== 'function'
      ? 'no fetch implementation'
      : null
  if (!available) log('warn', `embedding model unavailable: ${unavailableReason}`)

  /** Read the `{ [cacheKey]: dims }` probe cache; never throws. */
  function readDimsCache() {
    try {
      const raw = metaGet(EMBEDDING_DIMS_META_KEY)
      if (typeof raw !== 'string' || raw === '') return null
      const parsed = JSON.parse(raw)
      const value = Number(parsed?.[cacheKey])
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
    } catch {
      return null
    }
  }

  /** Persist a probed width for the next process; failure is not an error. */
  function writeDimsCache(width) {
    try {
      let parsed = {}
      const raw = metaGet(EMBEDDING_DIMS_META_KEY)
      if (typeof raw === 'string' && raw !== '') {
        const candidate = JSON.parse(raw)
        if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) parsed = candidate
      }
      parsed[cacheKey] = Math.floor(width)
      metaSet(EMBEDDING_DIMS_META_KEY, JSON.stringify(parsed))
    } catch (error) {
      log('debug', `cannot cache embedding dims: ${messageOf(error)}`)
    }
  }

  /** Adopt a width discovered at runtime (probe or first response). */
  function adoptDims(width, source) {
    const next = Math.floor(Number(width))
    if (!Number.isFinite(next) || next <= 0) return
    if (dims !== next) queryCache.clear()
    dims = next
    dimsSource = source
  }

  /**
   * Resolve the API key for this call. References resolve through the host
   * credential service (per operation, never cached — a rotated key reaches the
   * next request), and anything that is not an identifier is used literally.
   */
  async function apiKey() {
    if (apiKeyRef === '') return null
    if (!isCredentialRef(apiKeyRef)) return apiKeyRef
    try {
      const resolved = await deps.resolveSecret?.(apiKeyRef)
      // A credential provider answers `{ value, source }`; index.js already
      // unwraps it, but a direct caller must not end up sending "[object Object]".
      const value =
        typeof resolved === 'string'
          ? resolved
          : resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string'
            ? resolved.value
            : null
      return value === null || value === '' ? null : value
    } catch (error) {
      log('debug', `cannot resolve embedding key ${apiKeyRef}: ${messageOf(error)}`)
      return null
    }
  }

  /**
   * One `/embeddings` call.
   * @param {string[]} texts
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, vectors: Float32Array[], dims: number|null, error: string|null }>}
   */
  async function call(texts, options = {}) {
    if (!available) return { ok: false, vectors: [], dims, error: `unavailable: ${unavailableReason}` }
    if (texts.length === 0) return { ok: true, vectors: [], dims, error: null }
    const controller = new AbortController()
    const deadline = Math.max(500, Math.min(60_000, Number(options.timeoutMs ?? timeoutMs) || timeoutMs))
    const timer = setTimeout(() => controller.abort(), deadline)
    timer?.unref?.()
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' }
    const key = await apiKey()
    if (key !== null) headers.authorization = `Bearer ${key}`
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        // `encoding_format` is deliberately not sent: the OpenAI default is a
        // float array, and several compatible servers reject the parameter.
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = controller.signal.aborted || /abort/i.test(messageOf(error))
      return { ok: false, vectors: [], dims, error: aborted ? `timeout after ${deadline}ms` : messageOf(error) }
    }
    clearTimeout(timer)

    if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      return { ok: false, vectors: [], dims, error: 'invalid fetch response' }
    }
    if (!response.ok) {
      let body = ''
      try {
        body = String(await response.text()).slice(0, MAX_ERROR_BODY).replace(/\s+/g, ' ').trim()
      } catch {
        body = ''
      }
      const hint = response.status === 401 || response.status === 403 ? ' (check vector.apiKeyRef)' : ''
      return { ok: false, vectors: [], dims, error: `HTTP ${response.status}${hint}${body === '' ? '' : `: ${body}`}` }
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      return { ok: false, vectors: [], dims, error: `invalid JSON: ${messageOf(error)}` }
    }
    // OpenAI shape is `{ data: [{ embedding, index }] }`; a few self-hosted
    // servers answer `{ embeddings: [[...]] }` — accept both.
    let items
    if (Array.isArray(payload?.data)) items = payload.data
    else if (Array.isArray(payload?.embeddings)) items = payload.embeddings.map((embedding) => ({ embedding }))
    else return { ok: false, vectors: [], dims, error: 'response has no data[].embedding' }
    if (items.length !== texts.length) {
      return { ok: false, vectors: [], dims, error: `expected ${texts.length} embeddings, got ${items.length}` }
    }
    // `index` is optional but authoritative when present (batches may reorder).
    const ordered = items
      .map((item, position) => ({ item, position }))
      .map((entry) => ({
        embedding: entry.item?.embedding,
        index: Number.isFinite(Number(entry.item?.index)) ? Number(entry.item.index) : entry.position,
      }))
      .sort((left, right) => left.index - right.index)
    /** @type {Float32Array[]} */
    const vectors = []
    for (const entry of ordered) {
      if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
        return { ok: false, vectors: [], dims, error: 'embedding is not a non-empty array' }
      }
      const width = entry.embedding.length
      for (const value of entry.embedding) {
        if (!Number.isFinite(Number(value))) return { ok: false, vectors: [], dims, error: 'embedding contains a non-number' }
      }
      if (dims !== null && width !== dims) {
        return {
          ok: false,
          vectors: [],
          dims,
          error: `dimension-mismatch: model returned ${width}, configured ${dims}`,
        }
      }
      if (dims === null) {
        adoptDims(width, 'probed')
        writeDimsCache(width)
        log('info', `embedding dims resolved from response: ${width} (${model})`)
      }
      vectors.push(toUnitVector(entry.embedding.map(Number)))
    }
    return { ok: true, vectors, dims, error: null }
  }

  const client = {
    provider: /** @type {'openai'} */ ('openai'),
    available,
    model,
    baseUrl,
    endpoint,
    get dims() {
      return dims
    },
    get dimsSource() {
      return dimsSource
    },
    get tag() {
      return embeddingTag('openai', model, dims)
    },
    error: unavailableReason,

    /**
     * Make sure a width is known before anything is stored under a tag.
     * @returns {Promise<{ ok: boolean, dims: number|null, source: string|null, error: string|null }>}
     */
    async ensureDims() {
      if (dims !== null) return { ok: true, dims, source: dimsSource, error: null }
      const cached = readDimsCache()
      if (cached !== null) {
        adoptDims(cached, 'cache')
        return { ok: true, dims, source: 'cache', error: null }
      }
      const probed = await client.probe()
      if (!probed.ok) return { ok: false, dims: null, source: null, error: probed.error }
      return { ok: true, dims: probed.dims, source: 'probed', error: null }
    },

    /** @param {string[]} texts */
    async embed(texts) {
      const list = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : [String(texts ?? '')]
      return call(list)
    },

    /**
     * Embed one query text, with a small cache and the hard pre-step deadline.
     * @param {string} text
     * @param {{ timeoutMs?: number }} [options]
     */
    async embedOne(text, options = {}) {
      const value = String(text ?? '')
      if (value.trim() === '') return { ok: false, vector: null, dims, error: 'empty text' }
      const key = `${model}\u0000${value}`
      const hit = queryCache.get(key)
      if (hit !== undefined && (dims === null || hit.dims === dims)) {
        return { ok: true, vector: hit.vector, dims: hit.dims, error: null }
      }
      const result = await call([value], { timeoutMs: Math.min(Number(options.timeoutMs ?? timeoutMs) || timeoutMs, QUERY_TIMEOUT_MS) })
      if (!result.ok) return { ok: false, vector: null, dims, error: result.error }
      const vector = result.vectors[0] ?? null
      if (vector !== null && result.dims !== null) queryCache.set(key, { vector, dims: result.dims })
      return { ok: true, vector, dims: result.dims, error: null }
    },

    /**
     * One real request whose only purpose is the width (no cache).
     * @returns {Promise<{ ok: boolean, dims: number|null, source: string|null, error: string|null, ms: number }>}
     */
    async probe() {
      const started = now()
      if (!available) return { ok: false, dims: null, source: null, error: `unavailable: ${unavailableReason}`, ms: 0 }
      const result = await call(['dsh-memory dimension probe'], { timeoutMs })
      return {
        ok: result.ok,
        dims: result.ok ? result.dims : null,
        source: result.ok ? 'probed' : null,
        error: result.error,
        ms: Math.max(0, now() - started),
      }
    },

    clearCache() {
      queryCache.clear()
    },

    describe() {
      return {
        provider: 'openai',
        model,
        baseUrl,
        endpoint,
        dims,
        dimsSource,
        tag: client.tag,
        available,
        error: unavailableReason,
        keyRef: apiKeyRef === '' ? null : isCredentialRef(apiKeyRef) ? apiKeyRef : '(literal)',
      }
    },
  }
  return client
}

/**
 * Build the vector-model runtime for one configuration.
 *
 * @param {{
 *   provider?: string, model?: string, baseUrl?: string, dims?: number,
 *   apiKeyRef?: string, timeoutMs?: number,
 * }} [config]
 * @param {{
 *   fetch?: typeof fetch,
 *   resolveSecret?: (ref: string) => Promise<string|null|undefined> | string|null|undefined,
 *   metaGet?: (key: string) => string|undefined,
 *   metaSet?: (key: string, value: string) => void,
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 * }} [deps]
 */
export function createEmbeddingClient(config = {}, deps = {}) {
  return config.provider === 'openai' ? createRemoteClient(config, deps) : createLexicalClient(deps)
}
