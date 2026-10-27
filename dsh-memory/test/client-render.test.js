/**
 * Render the real settings page (`client.js`) without a browser.
 *
 * Why: the page is a bundle of plain `createElement` calls against a dictionary
 * keyed by host field keys, and it has no build step — so a typo in the vector
 * model card would only show up when a human opens 设置 → 记忆. This harness
 * evaluates the real bundle in a `vm` context with a ~40-line hook runtime and a
 * fake `fetch` that answers `/memory/api/state`, then asserts on the produced
 * text.
 *
 * It is deliberately not a DOM implementation: `createElement` returns plain
 * objects and the renderer concatenates text nodes, which is enough to prove
 * "the page renders this state" and "the dictionary covers these keys".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Flatten a rendered element tree to text. */
function toText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return toText(node.type(node.props))
    return (node.children ?? []).map(toText).join('')
  }
  return ''
}

/**
 * A minimal React: hooks by slot index, effects queued per pass, re-render while
 * a setter changed something.
 */
function createHookRuntime() {
  const slots = []
  let cursor = 0
  let effects = []
  let dirty = false
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (next) => {
          const value = typeof next === 'function' ? next(slots[index]) : next
          if (!Object.is(value, slots[index])) {
            slots[index] = value
            dirty = true
          }
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn) {
      const index = cursor++
      slots[index] = fn
      return fn
    },
    useMemo(fn) {
      const index = cursor++
      if (!(index in slots)) slots[index] = fn()
      return slots[index]
    },
    useEffect(fn) {
      effects.push(fn)
    },
  }
  return {
    React,
    /** Render until no setter fired (effects run between passes). */
    async render(Component) {
      let output = ''
      for (let pass = 0; pass < 20; pass++) {
        cursor = 0
        effects = []
        dirty = false
        output = toText(Component({}))
        for (const effect of effects) {
          const cleanup = effect()
          void cleanup
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
        if (!dirty) return output
      }
      return output
    },
  }
}

/** The `state` answer the fake host returns for `POST /memory/api/state`. */
function pageState(runtimeVector) {
  const field = (key, type, value, live = true) => ({
    key,
    type,
    live,
    default: value,
    value,
    source: 'default',
  })
  return {
    plugin: { name: 'dsh-memory-layered', version: '0.8.0', dbReady: true, startedAt: 1 },
    storage: { home: 'C:\\Users\\me', dir: 'C:\\Users\\me\\.dsh\\memory', dbPath: 'C:\\Users\\me\\.dsh\\memory\\memory.db', settingsPath: 'C:\\Users\\me\\.dsh\\memory\\settings.json', settingsExists: false, files: [], totalBytes: 0, error: null },
    stats: { total: 40, facts: 20, episodes: 5, l0Pending: 1, scenes: 2, personas: 1, tokensSpent: 1234, dbBytes: 2048 },
    runtime: {
      extraction: { available: false, provider: null, model: null, scheduled: false },
      skills: { enabled: true, dir: '' },
      vector: runtimeVector,
    },
    groups: [
      {
        id: 'vector',
        fields: [
          field('vector.enabled', 'boolean', true),
          { key: 'vector.provider', type: 'enum', live: true, default: 'hash', value: 'openai', source: 'settings', options: ['hash', 'openai'] },
          field('vector.model', 'text', 'toy-embed'),
          field('vector.dims', 'number', 8),
        ],
      },
    ],
  }
}

/** Evaluate the real bundle and render the settings section for one state. */
async function renderPage(runtimeVector) {
  let loaded
  const document = {
    baseURI: 'http://127.0.0.1:64427/',
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', id: '' }),
    head: { appendChild: () => {} },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          loaded = definition
        },
      },
    },
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: pageState(runtimeVector) }) }),
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    URL,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(typeof loaded, 'object')
  assert.equal(loaded.id, 'dsh-memory-layered')

  const runtime = createHookRuntime()
  const plugin = loaded.factory((id) => {
    if (id === 'react') return runtime.React
    throw new Error(`unexpected require: ${id}`)
  })

  let dictionaries = null
  const t = (key) => (dictionaries !== null && typeof dictionaries.zh?.[key] === 'string' ? dictionaries.zh[key] : key)
  const locale = {
    bind: () => t,
    subscribe: () => () => {},
    register: (namespace, value) => {
      dictionaries = value
      return () => {}
    },
  }
  let component = null
  const ctx = {
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale,
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, candidate) => {
        assert.equal(definition.name, 'settings.section')
        assert.equal(definition.id, 'memory')
        component = candidate
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(typeof component, 'function')
  return runtime.render(component)
}

test('the page renders a configured vector model with its width and coverage', async () => {
  const html = await renderPage({
    enabled: true,
    provider: 'openai',
    model: 'toy-embed',
    dims: 8,
    dimsSource: 'config',
    tag: 'openai:toy-embed@8',
    endpoint: 'http://127.0.0.1:11434/v1/embeddings',
    available: true,
    keyRef: 'MY_KEY',
    embedded: 12,
    pending: 28,
    total: 40,
    lastError: null,
  })
  assert.match(html, /向量模型/, 'the group and the runtime line use the zh dictionary')
  assert.match(html, /openai:toy-embed@8/, 'the resolved tag is shown')
  assert.match(html, /@8/, 'the width is shown next to the tag')
  assert.match(html, /已嵌入 12\/40/)
  assert.match(html, /待回填 28/)
  // Field labels come from the dictionary, not the raw keys.
  assert.match(html, /外部嵌入接口/, 'the enum option is localized')
  assert.ok(!html.includes('vector.provider: '), 'no missing-dictionary key leaked')
})

test('a failing endpoint is visible instead of silent', async () => {
  const html = await renderPage({
    enabled: true,
    provider: 'openai',
    model: 'toy-embed',
    dims: null,
    dimsSource: null,
    tag: null,
    endpoint: 'http://127.0.0.1:9/v1/embeddings',
    available: true,
    keyRef: null,
    embedded: 0,
    pending: 40,
    total: 40,
    lastError: 'HTTP 401 (check vector.apiKeyRef): invalid api key',
  })
  assert.match(html, /HTTP 401/)
})

test('the built-in provider shows no vector-model status line', async () => {
  const html = await renderPage({ enabled: true, provider: 'hash', model: null, dims: 384, dimsSource: 'builtin', tag: 'hash-ngram-v1-384', endpoint: null, available: true, keyRef: null, embedded: 0, pending: 0, total: 0, lastError: null })
  assert.match(html, /向量模型/, 'the settings group itself still renders')
  assert.ok(!html.includes('已嵌入'), 'no status line for the built-in algorithm')
})
