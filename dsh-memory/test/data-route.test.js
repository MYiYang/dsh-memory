/**
 * `/memory/api` data endpoints (memories / memory / memoryCreate /
 * memoryUpdate / memoryDelete): the same stub-cordis harness as
 * `settings-route.test.js`, driven against the real `apply()`.
 *
 * The point of these cases is the HTTP contract the settings page actually
 * consumes: status codes for each stable error code, the camelCase JSON shape,
 * and that every write is immediately visible through the reading endpoints and
 * the `state` counters.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { API_PREFIX } from '../src/api.js'

function tempDir(prefix = 'dsh-memory-data-route-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a live sqlite handle on Windows may keep the temp dir; it is disposable */
  }
}

/**
 * Run the real apply() and return a function that posts one JSON body to one
 * `/memory/api/<method>` endpoint.
 *
 * @param {{ dbPath?: string, connection?: any }} [options]
 */
function createHarness(options = {}) {
  const dir = options.dir ?? tempDir()
  const dbPath = options.dbPath ?? join(dir, 'memory.db')
  const settingsPath = join(dir, 'settings.json')
  let apiRoute

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on() {
      return () => {}
    },
    effect(factory) {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      callback({
        effect(factory) {
          factory()
          return () => {}
        },
        webServer: {
          register(candidate) {
            if (candidate.kind === 'prefix' && candidate.path === API_PREFIX) apiRoute = candidate
            return () => {}
          },
        },
      })
      return { dispose() {} }
    },
    get(name) {
      if (name === 'connection') return options.connection
      return undefined
    },
    tools: {
      register() {
        return () => {}
      },
    },
  }

  apply(ctx, { dbPath, settingsPath })
  assert.notEqual(apiRoute, undefined, 'apply() must register /memory/api')

  async function call(method, body) {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const chunks = payload === undefined ? [] : [Buffer.from(payload, 'utf8')]
    const req = {
      method: 'POST',
      url: `${API_PREFIX}/${method}`,
      async *[Symbol.asyncIterator]() {
        yield* chunks
      },
    }
    let settle
    const answered = new Promise((resolve) => {
      settle = resolve
    })
    const res = {
      statusCode: 0,
      headers: undefined,
      body: '',
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(chunk) {
        this.body = chunk ?? ''
        settle(this)
      },
    }
    await apiRoute.handler(req, res)
    const response = await answered
    return { status: response.statusCode, headers: response.headers, body: response.body, json: JSON.parse(response.body) }
  }

  return { dir, dbPath, settingsPath, call }
}

/** Create one row through the API and return its serialized item. */
async function seed(harness, body) {
  const response = await harness.call('memoryCreate', body)
  assert.equal(response.status, 200, response.body)
  assert.equal(response.json.ok, true)
  return response.json.value
}

test('data endpoints: 完整增查改删一轮，写操作立刻对 state 计数可见', async () => {
  const harness = createHarness()
  try {
    const empty = await harness.call('memories', {})
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.value.items, [])
    assert.equal(empty.json.value.total, 0)
    assert.equal(empty.json.value.page, 1)
    assert.equal(empty.json.value.pages, 1)
    assert.equal(empty.json.value.facets.total, 0)

    const created = await seed(harness, {
      text: '所有命令都用 pwsh 执行',
      kind: 'instruction',
      scope: 'project',
      project: 'menm',
      tags: ['shell', 'windows'],
      priority: 120,
      pinned: true,
    })
    assert.equal(created.inserted, true)
    const item = created.item
    assert.equal(item.kind, 'instruction')
    assert.equal(item.scope, 'project')
    assert.equal(item.project, 'menm')
    assert.deepEqual(item.tags, ['shell', 'windows'])
    assert.equal(item.priority, 100, 'priority is clamped by the host')
    assert.equal(item.pinned, true)

    const listed = await harness.call('memories', { scope: 'project', project: 'menm', query: 'pwsh' })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.value.items.map((row) => row.id), [item.id])
    assert.equal(listed.json.value.facets.projects[0].project, 'menm')

    const single = await harness.call('memory', { id: item.id })
    assert.equal(single.status, 200)
    assert.equal(single.json.value.item.id, item.id)
    assert.deepEqual(single.json.value.history, [])

    const updated = await harness.call('memoryUpdate', {
      id: item.id,
      text: '所有命令都用 pwsh，并且不要用 cmd',
      tags: 'shell',
      priority: 30,
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.json.value.item.version, 2)
    assert.equal(updated.json.value.item.priority, 30)
    assert.deepEqual(updated.json.value.item.tags, ['shell'])
    assert.equal(updated.json.value.item.pinned, true, 'omitted fields survive an update')
    assert.equal(updated.json.value.item.text, '所有命令都用 pwsh，并且不要用 cmd')

    const history = await harness.call('memory', { id: item.id })
    assert.equal(history.json.value.history.length, 1)
    assert.equal(history.json.value.history[0].text, '所有命令都用 pwsh 执行')

    // state.stats is computed live, so the page can refresh its tiles after a write.
    const state = await harness.call('state', {})
    assert.equal(state.json.value.stats.total, 1)
    assert.equal(state.json.value.stats.facts, 0)
    assert.equal(state.json.value.stats.byKind.instruction, 1)

    const deleted = await harness.call('memoryDelete', { id: item.id })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.json.value, { deleted: 1, ids: [item.id] })
    assert.equal((await harness.call('memories', { includeSuperseded: true })).json.value.total, 0)
  } finally {
    cleanup(harness.dir)
  }
})

test('data endpoints: 相同正文的第二次创建是幂等更新（inserted:false）', async () => {
  const harness = createHarness()
  try {
    const first = await seed(harness, { text: '幂等正文' })
    const second = await seed(harness, { text: '幂等正文', kind: 'work_method', priority: 77 })
    assert.equal(first.inserted, true)
    assert.equal(second.inserted, false)
    assert.equal(second.item.id, first.item.id)
    assert.equal(second.item.kind, 'work_method')
    assert.equal(second.item.priority, 77)
    assert.equal((await harness.call('memories', {})).json.value.total, 1)
  } finally {
    cleanup(harness.dir)
  }
})

test('data endpoints: 校验失败 400、缺行 404、正文冲突 409、未知方法 404', async () => {
  const harness = createHarness()
  try {
    const empty = await harness.call('memoryCreate', { text: '   ' })
    assert.equal(empty.status, 400)
    assert.equal(empty.json.error.code, 'bad-request')

    const badKind = await harness.call('memories', { kind: 'nope' })
    assert.equal(badKind.status, 400)
    assert.equal(badKind.json.error.code, 'bad-request')

    const missing = await harness.call('memory', { id: 9999 })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'not-found')
    assert.equal((await harness.call('memoryUpdate', { id: 9999, text: 'x' })).status, 404)
    assert.equal((await harness.call('memory', {})).status, 400)

    const a = await seed(harness, { text: '第一条' })
    const b = await seed(harness, { text: '第二条' })
    const conflict = await harness.call('memoryUpdate', { id: b.item.id, text: '第一条' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.error.code, 'conflict')
    assert.match(conflict.json.error.message, new RegExp(String(a.item.id)))

    const unknown = await harness.call('nope', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'not-found')
  } finally {
    cleanup(harness.dir)
  }
})

test('data endpoints: 数据库没打开时返回 503 not-ready，设置页仍可用', async () => {
  const dir = tempDir()
  try {
    // Point the database at a directory: openDatabase() cannot open it, so the
    // plugin degrades to dbReady=false exactly like a read-only home would.
    const harness = createHarness({ dir, dbPath: dir })
    const state = await harness.call('state', {})
    assert.equal(state.status, 200, 'the parameter page must keep working')
    assert.equal(state.json.value.plugin.dbReady, false)

    const listed = await harness.call('memories', {})
    assert.equal(listed.status, 503)
    assert.equal(listed.json.error.code, 'not-ready')
    assert.equal((await harness.call('memoryCreate', { text: 'x' })).status, 503)
    assert.equal((await harness.call('memoryUpdate', { id: 1, text: 'x' })).status, 503)
    assert.equal((await harness.call('memoryDelete', { id: 1 })).status, 503)
  } finally {
    cleanup(dir)
  }
})

test('data endpoints: 信任闸门拒绝时数据接口也是 403（不泄露方法是否存在）', async () => {
  const harness = createHarness({
    connection: { requestRejection: () => 'not a trusted page' },
  })
  try {
    for (const method of ['memories', 'memory', 'memoryCreate', 'memoryUpdate', 'memoryDelete']) {
      const response = await harness.call(method, { text: 'x', id: 1 })
      assert.equal(response.status, 403, method)
      assert.equal(response.json.error.code, 'forbidden', method)
    }
  } finally {
    cleanup(harness.dir)
  }
})
