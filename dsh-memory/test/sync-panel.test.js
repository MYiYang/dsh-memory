/**
 * Render the sidebar panel for real (vm + a small hook runtime + fake fetch).
 *
 * The settings page already has such a harness; this one covers the second
 * surface the bundle registers — the `sidebar.panellist` icon and the `main`
 * panel keyed `memory`. It exists because a broken panel would take the whole
 * client bundle down with it, including the settings page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let lastTree = null
let outputs = []

function toText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join(' ')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      const output = node.type(node.props)
      // The first function component expanded in a pass is the panel itself;
      // its output is the tree the assertions walk. Every expansion is kept so
      // a test can also inspect a nested component (the inline data browser).
      if (lastTree === null) lastTree = output
      outputs.push({ name: node.type.name || 'anonymous', tree: output })
      return toText(output)
    }
    return (node.children ?? []).map(toText).join(' ')
  }
  return ''
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findAll(root, predicate) {
  const hits = []
  walk(root, (node) => {
    if (node.type !== undefined && predicate(node)) hits.push(node)
  })
  return hits
}

function createRuntime() {
  let hooks = []
  let cursor = 0
  let dirty = false
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (!Object.is(value, hooks[index])) {
          hooks[index] = value
          dirty = true
        }
      }]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const prev = hooks[index]
      const changed = prev === undefined || deps === undefined || deps.some((dep, i) => !Object.is(dep, prev[i]))
      hooks[index] = deps ?? []
      if (changed) effects.push(fn)
    },
    useCallback(fn, deps) {
      const index = cursor++
      const prev = hooks[index]
      if (prev === undefined || deps === undefined || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))) {
        hooks[index] = { fn, deps }
        return fn
      }
      return prev.fn
    },
    useMemo(fn4, deps) { return fn4() },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
  }

  async function render(element) {
    let text = ""
    for (let pass = 0; pass < 6; pass++) {
      cursor = 0
      dirty = false
      effects = []
      lastTree = null
      outputs = []
      text = toText(element)
      for (const effect of effects) effect()
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (!dirty) break
    }
    return text
  }

  return { React, render, tree: () => lastTree, outputs: () => outputs }
}

function loadPlugin(answers) {
  let loaded
  const document = {
    baseURI: 'http://127.0.0.1:1/',
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  const requests = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
    document,
    fetch: async (url, init) => {
      const method = String(url).split('/').pop()
      const body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
      requests.push({ method, body })
      const value = answers[method] ?? {}
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    },
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    URL,
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  assert.equal(loaded?.id, 'dsh-memory-layered')
  const runtime = createRuntime()
  const plugin = loaded.factory((id) => {
    if (id === 'react') return runtime.React
    throw new Error(`unexpected require: ${id}`)
  })
  return { plugin, runtime, requests }
}

test('the sidebar icon and the memory panel register', async () => {
  const { plugin } = loadPlugin({})
  const registered = new Map()
  plugin.apply({
    effect: (factory) => factory(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, candidate) => {
        registered.set(definition.name + (definition.key ? ':' + definition.key : definition.id ? ':' + definition.id : ''), candidate)
        return () => {}
      },
    },
  })
  assert.ok(registered.has('settings.section:memory'), 'settings section missing')
  assert.ok(registered.has('sidebar.panellist:memory'), 'sidebar entry missing')
  assert.ok(registered.has('main:memory'), 'main panel missing')
  assert.equal(typeof registered.get('sidebar.panellist:memory'), 'function')
  assert.equal(typeof registered.get('main:memory'), 'function')
})

test('the panel renders the memory manager and the sync counters', async () => {
  const { plugin, runtime } = loadPlugin({
    memories: DATA_ANSWERS.memories,
    syncStatus: {
      available: true, enabled: true, state: 'closed', endpoint: 'http://minio:9000', bucket: 'dsh-m',
      backlog: { ops: 3 }, peers: [{ peer: 'a' }, { peer: 'b' }], lastPushAt: 1, lastPullAt: 2,
    },
  })
  const registered = new Map()
  plugin.apply({
    effect: (factory) => factory(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, candidate) => { registered.set(definition.key ?? definition.id, candidate); return () => {} },
    },
  })
  const Panel = registered.get('memory')
  const html = await runtime.render(runtime.React.createElement(Panel, { defaultTab: 'memories' }))
  assert.match(html, /部署流程/, 'memory title should render')
  assert.match(html, /Memory data/, 'the embedded data window renders')
  assert.match(html, /记忆/, 'panel title should render')
})

test('the sync tab renders instead of blanking the page', async () => {
  const { plugin, runtime } = loadPlugin({
    memories: { items: [], total: 0, page: 1, pages: 1, facets: { kinds: [], scopes: [], projects: [], total: 0 } },
    syncStatus: {
      available: true, enabled: true, state: 'closed', endpoint: 'http://minio:9000', bucket: 'dsh-m',
      backlog: { ops: 3 }, peers: [{ peer: 'a' }], lastPushAt: Date.now(), lastPullAt: Date.now(),
    },
  })
  const registered = new Map()
  plugin.apply({
    effect: (factory) => factory(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, candidate) => { registered.set(definition.key ?? definition.id, candidate); return () => {} },
    },
  })
  const Panel = registered.get('memory')
  const html = await runtime.render(runtime.React.createElement(Panel, { defaultTab: 'sync' }))
  assert.match(html, /状态/, 'sync state row should render')
  assert.match(html, /上次推送/, 'last push row should render')
  assert.match(html, /待推送/, 'backlog row should render')
})

/** Render the panel once with a fixed set of host answers. */
async function renderPanel(answers, props) {
  const { plugin, runtime, requests } = loadPlugin(answers)
  const registered = new Map()
  plugin.apply({
    effect: (factory) => factory(),
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (name, callback) => callback(),
      register: (definition, candidate) => {
        registered.set(definition.key ?? definition.id, candidate)
        return () => {}
      },
    },
  })
  const element = runtime.React.createElement(registered.get('memory'), props ?? {})
  const html = await runtime.render(element)
  return { html, runtime, requests, element, tree: runtime.tree() }
}

const DB_ROWS = [
  {
    id: 7, kind: 'work_fact', title: '部署流程', text: '部署流程用 pnpm',
    project: 'demo', scope: 'project', source: 'manual', tags: ['部署'], pinned: false,
    priority: 50, version: 1, supersededBy: null, createdAt: 1, updatedAt: 2, useCount: 2,
  },
]

const DATA_ANSWERS = {
  memories: {
    items: DB_ROWS,
    total: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
    sort: 'updated',
    includeSuperseded: false,
    facets: {
      kinds: [{ kind: 'work_fact', count: 1 }],
      scopes: [{ scope: 'project', count: 1 }],
      projects: [{ project: 'demo', count: 1 }],
      total: 1,
    },
  },
  syncStatus: { available: false },
}

/** The inline data browser's tree from the last render pass. */
function browserTree(runtime) {
  const trees = runtime.outputs().filter((entry) => entry.name === 'MemoryDataBrowser').map((entry) => entry.tree)
  return trees.length === 0 ? null : trees[trees.length - 1]
}

test('the panel embeds the same data manager as Settings → 记忆数据', async () => {
  const { html, runtime } = await renderPanel(DATA_ANSWERS, { defaultTab: 'memories' })
  const view = browserTree(runtime)
  assert.ok(view !== null, 'MemoryDataBrowser output not found')
  assert.equal(findAll(view, (node) => node.props?.className === 'dm_modal dm_modalInline').length, 1, 'inline shell missing')
  assert.match(html, /Memory data/, 'the embedded window keeps its title')
  assert.match(html, /部署流程/, 'list rows render')
  assert.match(html, /New memory/, 'create action is available')
  const selects = findAll(view, (node) => node.type === 'select')
  assert.deepEqual(selects.map((node) => node.props['aria-label']), ['Kind', 'Scope', 'Project'], 'the three filters')
  assert.equal(findAll(view, (node) => node.type === 'input' && node.props.className === 'dm_search').length, 1)
})

test('the embedded manager opens the create form and returns to the list', async () => {
  const { runtime, element } = await renderPanel(DATA_ANSWERS, { defaultTab: 'memories' })
  const clickByText = (text) => {
    const view = browserTree(runtime)
    const button = findAll(view, (node) => node.type === 'button').find((node) =>
      node.children.some((child) => typeof child === 'string' && child.includes(text)),
    )
    assert.ok(button !== undefined, `button "${text}" not found`)
    button.props.onClick()
  }
  clickByText('New memory')
  const form = await runtime.render(element)
  assert.match(form, /Body/, 'the create form opens')
  assert.equal(findAll(browserTree(runtime), (node) => node.type === 'textarea').length, 1)
  clickByText('Back to list')
  const list = await runtime.render(element)
  assert.match(list, /部署流程/, 'back on the list')
})

test('a filter change sends the chosen condition to the host', async () => {
  const { runtime, element, requests } = await renderPanel(DATA_ANSWERS, { defaultTab: 'memories' })
  const select = findAll(browserTree(runtime), (node) => node.type === 'select' && node.props['aria-label'] === 'Kind')[0]
  assert.ok(select !== undefined, 'kind filter missing')
  select.props.onChange({ target: { value: 'instruction' } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const listed = requests.filter((entry) => entry.method === 'memories').pop()
  assert.ok(listed !== undefined, 'memories was not called')
  assert.equal(listed.body.kind, 'instruction')
  assert.equal(listed.body.page, 1)
  const after = await runtime.render(element)
  assert.match(after, /记忆/)
})

const STATE = {
  plugin: { name: 'dsh-memory-layered', version: '0.9.0', dbReady: true, startedAt: 1 },
  storage: { home: '', dir: '', dbPath: '', settingsPath: '', settingsExists: false, files: [], totalBytes: 0, error: null },
  stats: {
    total: 12, facts: 9, episodes: 1, projects: 3, superseded: 1,
    l0Total: 20, l0Pending: 2, scenes: 2, personas: 1,
    vectorized: 8, featureIndexed: 9, tokensSpent: 1234, dbBytes: 2048,
  },
  runtime: {
    extraction: { available: false, provider: null, model: null, scheduled: false },
    skills: { enabled: true, dir: '' },
    vector: {
      enabled: false, provider: 'hash', model: null, dims: 384, dimsSource: null, tag: '',
      endpoint: null, available: true, keyRef: null, embedded: 8, pending: 1, total: 9, lastError: null,
    },
  },
  groups: [],
}

test('the panel opens on a statistics tab ahead of 记忆 and 同步', async () => {
  const { html, runtime, requests } = await renderPanel({ state: STATE, syncStatus: { available: false } })
  const tabs = findAll(runtime.tree(), (node) => node.type === 'button' && String(node.props.role) === 'tab')
  assert.deepEqual(tabs.map((node) => node.children.join('')), ['统计', '记忆', '同步'], 'tab order')
  assert.equal(tabs[0].props['aria-selected'], true, 'statistics is the default tab')
  for (const text of ['四层记忆', '向量覆盖', '记忆构成', '存储占用', '明细', '已嵌入', '原文轮次', '项目', '已取代', '待提炼']) {
    assert.ok(html.includes(text), `missing card ${text}`)
  }
  assert.match(html, /8\/9/, 'coverage counter: eight of nine live rows')
  assert.match(html, /12/, 'total memories')
  // The tab is drawn, not listed: five cards, one of them the SVG coverage ring.
  const cards = findAll(runtime.tree(), (node) => /^dm_pnCard( dm_pnCardWide)?$/.test(String(node.props?.className ?? '')))
  assert.equal(cards.length, 5, 'four chart cards plus the wide composition card')
  assert.equal(findAll(runtime.tree(), (node) => node.type === 'svg').length, 1, 'coverage ring missing')

  const before = requests.filter((entry) => entry.method === 'state').length
  const refresh = findAll(runtime.tree(), (node) => node.type === 'button').find((node) =>
    String(node.children).includes('刷新'),
  )
  assert.ok(refresh !== undefined, 'refresh button missing')
  refresh.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(
    requests.filter((entry) => entry.method === 'state').length,
    before + 1,
    'refresh re-reads the statistics',
  )
})
