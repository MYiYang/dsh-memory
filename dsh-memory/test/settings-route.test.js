/**
 * `/memory/api` 路由测试：用 stub cordis context 跑**真实** apply()，
 * 捕获插件注册的 prefix 路由，再让真实 POST 请求穿过真实 handler。
 *
 * stub 的办法与 dsh-git-branch/test/route.test.js 相同：ctx.effect 立即执行工厂，
 * ctx.inject(['webServer'], cb) 用假 webCtx 回调，假 webServer.register 收下路由。
 *
 * 每个用例都有独立临时目录，apply 一律显式传 settingsPath，绝不碰真实的 ~/.dsh；
 * 不监听端口、不联网、不 spawn 真实进程（/memory/api/reveal 会真的开资源管理器，
 * 因此这里不调用它，revealDirectory 在 settings.test.js 里用注入的 fake spawn 覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { API_PREFIX, MAX_BODY_BYTES } from '../src/api.js'

/** 每个用例一个独立临时目录。 */
function tempDir(prefix = 'dsh-memory-route-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Windows 上运行中的 sqlite 句柄可能挡住 rmSync：清理失败不能掩盖断言失败。 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录留给系统回收 */
  }
}

/** 设置页会渲染的扁平字段表（按分组顺序）。 */
function flattenFields(state) {
  return state.groups.flatMap((group) => group.fields)
}

/**
 * stub cordis context：跑真实 apply()，捕获 `/memory/api` 路由，返回直接打路由的请求函数。
 *
 * options:
 *   config       loader 行 config（YAML 基线）
 *   settings     apply 之前写进 settings.json 的 {settings} 层
 *   rawSettings  apply 之前直接写入 settings.json 的原始文本（测损坏文件）
 *   connection   注入 ctx.get('connection') 的返回值（缺省=无，等价 headless）
 */
function createHarness(options = {}) {
  const dir = options.dir ?? tempDir()
  const dbPath = join(dir, 'memory.db')
  const settingsPath = join(dir, 'settings.json')
  if (options.settings !== undefined) {
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), settings: options.settings }),
    )
  }
  if (options.rawSettings !== undefined) writeFileSync(settingsPath, options.rawSettings)

  const handlers = new Map()
  const tools = new Map()
  let apiRoute

  const webContext = {
    webServer: {
      register(candidate) {
        if (candidate.kind === 'prefix' && candidate.path === API_PREFIX) apiRoute = candidate
        return () => {}
      },
    },
    effect(factory) {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(factory) {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'], '设置页路由只能依赖 webServer')
      callback(webContext)
      return { dispose() {} }
    },
    get(name) {
      if (name === 'connection') return options.connection
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  apply(ctx, { dbPath, settingsPath, ...(options.config ?? {}) })
  assert.notEqual(apiRoute, undefined, 'apply() 必须通过 ctx.inject([\'webServer\']) 注册 /memory/api')

  /**
   * 打一次真实请求。body 传对象会被 JSON 序列化；传字符串按原文发送（测非法 JSON / 超限）。
   */
  async function request(method, pathname, body) {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const chunks = payload === undefined ? [] : [Buffer.from(payload, 'utf8')]
    const req = {
      method,
      url: pathname,
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
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
      json: JSON.parse(response.body),
    }
  }

  return { dir, dbPath, settingsPath, apiRoute, handlers, request }
}

/** 模拟一次完整回合（turn/end completed 会触发捕获）。 */
function emitTurn(handlers, session, { turn, user, assistant }) {
  const fire = handlers.get('session/event')
  fire(session, { type: 'turn/start', data: { turn } })
  fire(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } })
  fire(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: assistant }] } } })
  fire(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

// ── state ──────────────────────────────────────────────────────────────────

test('apply 注册 /memory/api 前缀路由，state 返回设置页需要的全量结构', async () => {
  const harness = createHarness()
  try {
    assert.equal(harness.apiRoute.kind, 'prefix')
    assert.equal(harness.apiRoute.path, '/memory/api')

    const response = await harness.request('POST', '/memory/api/state', {})
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.ok, true)
    assert.match(response.headers['content-type'], /^application\/json/)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body))

    const state = response.json.value
    assert.equal(state.plugin.name, 'dsh-memory-layered')
    assert.match(state.plugin.version, /^\d+\.\d+\.\d+/)
    assert.equal(state.plugin.dbReady, true)
    assert.equal(typeof state.plugin.startedAt, 'number')

    // 存储卡片：指向本用例的临时目录
    assert.equal(state.storage.dir, harness.dir)
    assert.equal(state.storage.dbPath, harness.dbPath)
    assert.equal(state.storage.settingsPath, harness.settingsPath)
    assert.equal(state.storage.settingsExists, false)
    assert.equal(state.storage.error, null)
    assert.ok(Array.isArray(state.storage.files))
    assert.ok(state.storage.files.some((file) => file.name === 'memory.db'), '数据库文件应出现在存储卡片里')
    assert.equal(typeof state.storage.totalBytes, 'number')

    assert.equal(typeof state.stats.total, 'number')
    assert.equal(state.stats.total, 0)
    assert.equal(state.runtime.extraction.available, false, 'stub ctx 没有 llm 服务')
    assert.equal(typeof state.runtime.skills.enabled, 'boolean')

    assert.deepEqual(
      state.groups.map((group) => group.id),
      ['recall', 'capture', 'extraction', 'scenes', 'persona', 'vector', 'storage', 'advanced'],
    )
    const fields = flattenFields(state)
    const maxItems = fields.find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 6)
    assert.equal(maxItems.default, 6)
    assert.equal(maxItems.source, 'default')
    assert.equal(maxItems.min, 1)
    assert.equal(maxItems.max, 20)
    assert.equal(maxItems.step, 1)
    assert.equal(maxItems.live, true)
    // 空请求体也能读 state
    assert.equal((await harness.request('POST', '/memory/api/state')).status, 200)
  } finally {
    cleanup(harness.dir)
  }
})

test('启动时读取 settings.json：设置层盖过 YAML，来源标成 settings', async () => {
  const harness = createHarness({
    config: { maxItems: 3, capture: false },
    settings: { maxItems: 9, extraction: { everyN: 20 } },
  })
  try {
    const state = (await harness.request('POST', '/memory/api/state', {})).json.value
    assert.equal(state.storage.settingsExists, true)
    assert.equal(state.storage.error, null)
    const fields = flattenFields(state)

    const maxItems = fields.find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 9, 'settings 层必须盖过 YAML')
    assert.equal(maxItems.source, 'settings')
    assert.equal(maxItems.default, 6)

    const everyN = fields.find((field) => field.key === 'extraction.everyN')
    assert.equal(everyN.value, 20)
    assert.equal(everyN.source, 'settings')

    const capture = fields.find((field) => field.key === 'capture')
    assert.equal(capture.value, false, 'settings 没写的 key 由 YAML 提供')
    assert.equal(capture.source, 'config')

    assert.equal(fields.find((field) => field.key === 'recall.maxChars').source, 'default')
  } finally {
    cleanup(harness.dir)
  }
})

test('启动时设置文件损坏：插件照常启动，错误显示在 storage.error', async () => {
  const harness = createHarness({ rawSettings: 'not json{' })
  try {
    const response = await harness.request('POST', '/memory/api/state', {})
    assert.equal(response.status, 200)
    const state = response.json.value
    assert.equal(state.plugin.dbReady, true, '坏设置文件不能挡住数据库打开')
    assert.match(state.storage.error, /not valid JSON/)
    const maxItems = flattenFields(state).find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 6, '坏文件等于没有设置层')
    assert.equal(maxItems.source, 'default')
  } finally {
    cleanup(harness.dir)
  }
})

// ── save：动态字段 ─────────────────────────────────────────────────────────

test('save 一个动态字段：立即生效、只落盘改过的 key、来源变成 settings', async () => {
  const harness = createHarness()
  try {
    const saved = await harness.request('POST', '/memory/api/save', { patch: { 'recall.maxItems': 9 } })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.deepEqual(saved.json.value.applied, ['recall.maxItems'])
    assert.deepEqual(saved.json.value.restartRequired, [])

    // 落盘：包装格式 + 只写用户改过的 key
    assert.equal(existsSync(harness.settingsPath), true)
    const file = JSON.parse(readFileSync(harness.settingsPath, 'utf8'))
    assert.equal(file.version, 1)
    assert.deepEqual(file.settings, { maxItems: 9 })

    // save 的返回值里 state 已反映新值
    const fromSave = flattenFields(saved.json.value.state).find((field) => field.key === 'recall.maxItems')
    assert.equal(fromSave.value, 9)
    assert.equal(fromSave.source, 'settings')

    // 再读一次 state 也应该是 9（不是只有 save 那一次返回变了）
    const state = (await harness.request('POST', '/memory/api/state', {})).json.value
    const reread = flattenFields(state).find((field) => field.key === 'recall.maxItems')
    assert.equal(reread.value, 9)
    assert.equal(reread.source, 'settings')
    assert.equal(state.storage.settingsExists, true)

    // 同一份配置重复保存：没有任何变更
    const repeat = await harness.request('POST', '/memory/api/save', { patch: { 'recall.maxItems': 9 } })
    assert.equal(repeat.status, 200)
    assert.deepEqual(repeat.json.value.applied, [])
    assert.deepEqual(repeat.json.value.restartRequired, [])
  } finally {
    cleanup(harness.dir)
  }
})

test('save 的 live 语义：关掉 capture 后运行中的捕获立即停止（无需重启）', async () => {
  const harness = createHarness()
  try {
    const session = { id: 'route-live', header: { cwd: 'F:\\work\\demo' }, events: [] }
    emitTurn(harness.handlers, session, { turn: 1, user: '构建用什么工具', assistant: 'pnpm build' })
    const before = (await harness.request('POST', '/memory/api/state', {})).json.value
    assert.equal(before.stats.total, 1, '默认配置下 turn/end 会捕获一条 episode')

    const saved = await harness.request('POST', '/memory/api/save', { patch: { capture: false } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.value.applied, ['capture'])
    assert.deepEqual(JSON.parse(readFileSync(harness.settingsPath, 'utf8')).settings, { capture: false })

    emitTurn(harness.handlers, session, { turn: 2, user: '第二个问题', assistant: '第二个结论' })
    const after = (await harness.request('POST', '/memory/api/state', {})).json.value
    assert.equal(after.stats.total, 1, 'config.capture 已在内存里改掉，捕获必须立即停止')
  } finally {
    cleanup(harness.dir)
  }
})

test('save 重启敏感字段：报告 restartRequired，运行中的值保持不变', async () => {
  const harness = createHarness()
  try {
    const nextDb = join(harness.dir, 'next.db')
    const saved = await harness.request('POST', '/memory/api/save', { patch: { 'storage.dbPath': nextDb } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.value.applied, [])
    assert.deepEqual(saved.json.value.restartRequired, ['storage.dbPath'])

    const state = saved.json.value.state
    const dbField = flattenFields(state).find((field) => field.key === 'storage.dbPath')
    assert.equal(dbField.live, false)
    assert.equal(dbField.value, nextDb, 'value 是下次启动会用的路径')
    assert.equal(dbField.active, harness.dbPath, 'active 是运行中真正在用的路径')
    assert.equal(dbField.source, 'settings')
    assert.equal(state.storage.dbPath, harness.dbPath, '运行中的存储卡片仍指向旧库')

    // 重启项也要落盘，否则重启后不生效
    assert.deepEqual(JSON.parse(readFileSync(harness.settingsPath, 'utf8')).settings, { dbPath: nextDb })
  } finally {
    cleanup(harness.dir)
  }
})

test('save 的 unset：回退到默认值，并从 settings.json 里删掉该 key', async () => {
  const harness = createHarness()
  try {
    const first = await harness.request('POST', '/memory/api/save', {
      patch: { 'recall.maxItems': 9, 'vector.enabled': false },
    })
    assert.deepEqual([...first.json.value.applied].sort(), ['recall.maxItems', 'vector.enabled'])

    const unset = await harness.request('POST', '/memory/api/save', { unset: ['recall.maxItems'] })
    assert.equal(unset.status, 200)
    assert.deepEqual(unset.json.value.unset, ['recall.maxItems'])
    assert.deepEqual(unset.json.value.applied, ['recall.maxItems'], 'unset 后的值要同步回内存')

    const fields = flattenFields(unset.json.value.state)
    const maxItems = fields.find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 6)
    assert.equal(maxItems.source, 'default')
    // 没被 unset 的覆盖保留
    assert.equal(fields.find((field) => field.key === 'vector.enabled').value, false)

    // 文件里只剩未 unset 的 key（空的分组对象也要被剪掉）
    assert.deepEqual(JSON.parse(readFileSync(harness.settingsPath, 'utf8')).settings, { vector: { enabled: false } })
  } finally {
    cleanup(harness.dir)
  }
})

// ── reset ──────────────────────────────────────────────────────────────────

test('reset 删除设置文件并回落到 YAML/默认基线', async () => {
  const harness = createHarness({ config: { maxItems: 3 } })
  try {
    await harness.request('POST', '/memory/api/save', { patch: { 'recall.maxItems': 9, 'capture': false } })
    assert.equal(existsSync(harness.settingsPath), true)
    const before = (await harness.request('POST', '/memory/api/state', {})).json.value
    assert.equal(flattenFields(before).find((field) => field.key === 'recall.maxItems').value, 9)

    const reset = await harness.request('POST', '/memory/api/reset', {})
    assert.equal(reset.status, 200)
    assert.equal(reset.json.ok, true)
    assert.equal(reset.json.value.reset, true)
    assert.deepEqual([...reset.json.value.applied].sort(), ['capture', 'recall.maxItems'])
    assert.deepEqual(reset.json.value.restartRequired, [])
    assert.equal(existsSync(harness.settingsPath), false, 'reset 必须删掉设置文件')

    const fields = flattenFields(reset.json.value.state)
    const maxItems = fields.find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 3, '回到 YAML 行 config')
    assert.equal(maxItems.source, 'config')
    const capture = fields.find((field) => field.key === 'capture')
    assert.equal(capture.value, true)
    assert.equal(capture.source, 'default')
    assert.equal(reset.json.value.state.storage.settingsExists, false)
  } finally {
    cleanup(harness.dir)
  }
})

test('reset keys 只回退指定字段，其余覆盖保留', async () => {
  const harness = createHarness()
  try {
    await harness.request('POST', '/memory/api/save', { patch: { 'recall.maxItems': 9, 'capture': false } })
    const reset = await harness.request('POST', '/memory/api/reset', { keys: ['recall.maxItems'] })
    assert.equal(reset.status, 200)
    assert.equal(reset.json.value.reset, true)
    assert.deepEqual(reset.json.value.applied, ['recall.maxItems'])

    const fields = flattenFields(reset.json.value.state)
    assert.equal(fields.find((field) => field.key === 'recall.maxItems').value, 6)
    assert.equal(fields.find((field) => field.key === 'capture').value, false, '没点名的覆盖不能被清掉')
    // 文件还在，只留下 capture
    assert.equal(existsSync(harness.settingsPath), true)
    assert.deepEqual(JSON.parse(readFileSync(harness.settingsPath, 'utf8')).settings, { capture: false })
  } finally {
    cleanup(harness.dir)
  }
})

// ── 错误码 ─────────────────────────────────────────────────────────────────

test('save 校验失败返回 400 且不落盘', async () => {
  const harness = createHarness()
  try {
    const badType = await harness.request('POST', '/memory/api/save', { patch: { 'recall.maxItems': 'many' } })
    assert.equal(badType.status, 400)
    assert.equal(badType.json.ok, false)
    assert.equal(badType.json.error.code, 'bad-request')
    assert.match(badType.json.error.message, /recall\.maxItems/)
    assert.match(badType.json.error.message, /expected number 1\.\.20/)

    const unknownKey = await harness.request('POST', '/memory/api/save', { patch: { 'memory.nope': 1 } })
    assert.equal(unknownKey.status, 400)
    assert.equal(unknownKey.json.error.code, 'bad-request')
    assert.match(unknownKey.json.error.message, /unknown setting/)

    const badUnset = await harness.request('POST', '/memory/api/save', { unset: ['nope'] })
    assert.equal(badUnset.status, 400)
    assert.equal(badUnset.json.error.code, 'bad-request')
    assert.match(badUnset.json.error.message, /unknown setting/)

    assert.equal(existsSync(harness.settingsPath), false, '校验失败绝不能落盘')
    const state = (await harness.request('POST', '/memory/api/state', {})).json.value
    assert.equal(flattenFields(state).find((field) => field.key === 'recall.maxItems').value, 6)
  } finally {
    cleanup(harness.dir)
  }
})

test('路由对未知方法、非 POST、非法 JSON、超限请求体给出稳定错误码', async () => {
  const harness = createHarness()
  try {
    const unknownMethod = await harness.request('POST', '/memory/api/nope', {})
    assert.equal(unknownMethod.status, 404)
    assert.equal(unknownMethod.json.error.code, 'not-found')

    // 方法名里带 / 也算未知方法
    const nested = await harness.request('POST', '/memory/api/state/extra', {})
    assert.equal(nested.status, 404)
    assert.equal(nested.json.error.code, 'not-found')

    const wrongPrefix = await harness.request('POST', '/memory/other/state', {})
    assert.equal(wrongPrefix.status, 404)

    const notPost = await harness.request('GET', '/memory/api/state')
    assert.equal(notPost.status, 405)
    assert.equal(notPost.json.error.code, 'method-not-allowed')

    const invalidJson = await harness.request('POST', '/memory/api/save', '{not json')
    assert.equal(invalidJson.status, 400)
    assert.equal(invalidJson.json.error.code, 'bad-request')
    assert.match(invalidJson.json.error.message, /not valid JSON/)

    const notAnObject = await harness.request('POST', '/memory/api/save', '[1,2,3]')
    assert.equal(notAnObject.status, 400)
    assert.equal(notAnObject.json.error.code, 'bad-request')

    const oversizedBody = JSON.stringify({ patch: { debug: 'x'.repeat(MAX_BODY_BYTES) } })
    assert.ok(Buffer.byteLength(oversizedBody) > MAX_BODY_BYTES)
    const oversized = await harness.request('POST', '/memory/api/save', oversizedBody)
    assert.equal(oversized.status, 400)
    assert.equal(oversized.json.error.code, 'bad-request')
    assert.match(oversized.json.error.message, new RegExp(`exceeds ${MAX_BODY_BYTES} bytes`))

    assert.equal(existsSync(harness.settingsPath), false)
  } finally {
    cleanup(harness.dir)
  }
})

test('connection.requestRejection 拒绝请求时返回 403，且不透露方法是否存在', async () => {
  const harness = createHarness({ connection: { requestRejection: () => ({ status: 403, message: 'cross-origin' }) } })
  try {
    const state = await harness.request('POST', '/memory/api/state', {})
    assert.equal(state.status, 403)
    assert.equal(state.json.ok, false)
    assert.equal(state.json.error.code, 'forbidden')

    const unknown = await harness.request('POST', '/memory/api/nope', {})
    assert.equal(unknown.status, 403, '信任校验先于方法校验')
    const writeAttempt = await harness.request('POST', '/memory/api/save', { patch: { 'capture': false } })
    assert.equal(writeAttempt.status, 403)
    assert.equal(existsSync(harness.settingsPath), false, '被拒的请求不能产生副作用')
  } finally {
    cleanup(harness.dir)
  }
})
