/**
 * 动态设置层的单元测试：
 *
 *   - 字段目录（FIELDS）与 resolveConfig 默认值的一致性
 *   - validatePatch / validateUnset 的接受、钳位与拒绝
 *   - mergeRaw / deepMerge / collectSources 的优先级与来源
 *   - applyLiveConfig 的原地生效、嵌套对象引用、重启项报告
 *   - deletePath / toNested / buildGroups 的形状
 *   - settings-store：读（缺失/损坏/包装/裸对象）、原子写、清除、存储目录描述、
 *     revealDirectory 的平台命令与失败降级（注入 fake spawn，不真的开窗口）
 *
 * 所有落盘用例都在 mkdtempSync 的临时目录里跑，绝不读写真实的 ~/.dsh。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIELDS,
  GROUPS,
  SOURCE,
  applyLiveConfig,
  buildGroups,
  collectSources,
  deepMerge,
  defaults,
  deletePath,
  fieldByKey,
  mergeRaw,
  readPath,
  resolveConfig,
  toNested,
  validatePatch,
  validateUnset,
} from '../src/settings.js'
import { clearSettingsFile, describeStorage, readSettingsFile, revealDirectory, writeSettingsFile } from '../src/settings-store.js'

/** 每个用例一个独立临时目录。 */
function tempDir(prefix = 'dsh-memory-settings-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Windows 上残留句柄/占用可能让 rm 失败；清理失败不能掩盖断言失败。 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录留给系统回收 */
  }
}

/** 深拷贝快照，用来断言「输入没有被改」。 */
function snapshot(value) {
  return JSON.parse(JSON.stringify(value))
}

// ── 字段目录 ────────────────────────────────────────────────────────────────

test('每个字段的默认值都等于 resolveConfig({}) 在该路径上的值', () => {
  const normalized = resolveConfig({})
  const catalogDefaults = defaults()
  for (const field of FIELDS) {
    const expected = readPath(normalized, field.path)
    assert.notEqual(expected, undefined, `${field.key} 的 path ${field.path.join('.')} 在 resolveConfig({}) 里不存在`)
    assert.deepEqual(catalogDefaults[field.key], expected, `${field.key} 的默认值与 resolveConfig({}) 不一致`)
  }
  assert.equal(Object.keys(catalogDefaults).length, FIELDS.length)
})

test('字段目录本身自洽：key 唯一、分组存在、类型元数据完整', () => {
  const keys = FIELDS.map((field) => field.key)
  assert.equal(new Set(keys).size, keys.length, 'field key 必须唯一')
  const groupIds = new Set(GROUPS.map((group) => group.id))
  for (const field of FIELDS) {
    assert.ok(groupIds.has(field.group), `${field.key} 的 group ${field.group} 不在 GROUPS 里`)
    assert.ok(['number', 'boolean', 'enum', 'text'].includes(field.type), `${field.key} 的 type 非法`)
    assert.equal(typeof field.live, 'boolean', `${field.key} 必须显式声明 live`)
    if (field.type === 'number') {
      assert.ok(Number.isFinite(field.min), `${field.key} 缺 min`)
      assert.ok(Number.isFinite(field.max) && field.max > field.min, `${field.key} 的 max 必须大于 min`)
      assert.ok(field.step > 0, `${field.key} 的 step 必须为正`)
    } else {
      assert.equal(field.min, undefined, `${field.key} 不是 number，不应带 min`)
      assert.equal(field.step, undefined, `${field.key} 不是 number，不应带 step`)
    }
    if (field.type === 'enum') {
      assert.ok(Array.isArray(field.options) && field.options.length > 0, `${field.key} 缺 options`)
    } else {
      assert.equal(field.options, undefined, `${field.key} 不是 enum，不应带 options`)
    }
  }
  assert.equal(fieldByKey('recall.maxItems')?.path.join('.'), 'maxItems')
  assert.equal(fieldByKey('no.such.key'), undefined)
  // 契约 §3.2：只有这些字段不能热更新
  const restartOnly = FIELDS.filter((field) => field.live === false).map((field) => field.key).sort()
  assert.deepEqual(restartOnly, ['extraction.model', 'extraction.provider', 'skills.dir', 'skills.enabled', 'storage.dbPath'])
})

// ── 校验 ────────────────────────────────────────────────────────────────────

test('validatePatch 接受合法值：数字钳位、文本裁剪、类型归一', () => {
  const result = validatePatch({
    'recall.maxItems': 100, // 超过上限 → 20
    'recall.minScore': -5, // 低于下限 → 0
    'vector.weight': 0.35,
    'recall.maxChars': '2400', // 数字字符串也接受
    'recall.scope': 'global',
    'vector.enabled': false,
    'extraction.provider': '  deepseek  ', // 两端空白裁掉
    'persona.personaReasoningEffort': 'high',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.flat['recall.maxItems'], 20)
  // integer fields round instead of leaking a fractional count into SQL LIMIT
  assert.equal(validatePatch({ 'recall.maxItems': 3.7 }).flat['recall.maxItems'], 4)
  assert.equal(result.flat['recall.minScore'], 0)
  assert.equal(result.flat['vector.weight'], 0.35)
  assert.equal(result.flat['recall.maxChars'], 2400)
  assert.equal(result.flat['recall.scope'], 'global')
  assert.equal(result.flat['vector.enabled'], false)
  assert.equal(result.flat['extraction.provider'], 'deepseek')
  assert.equal(result.flat['persona.personaReasoningEffort'], 'high')

  // 空 patch / null 都是合法的空操作
  assert.deepEqual(validatePatch(undefined), { ok: true, errors: [], flat: {} })
  assert.deepEqual(validatePatch(null), { ok: true, errors: [], flat: {} })
  // 空字符串是 enum 的合法选项（= 跟随默认）
  assert.equal(validatePatch({ 'persona.personaReasoningEffort': '' }).ok, true)
})

test('validatePatch 拒绝错误类型、未知 key 和非对象 patch', () => {
  const badNumber = validatePatch({ 'recall.maxItems': 'many' })
  assert.equal(badNumber.ok, false)
  assert.equal(badNumber.errors.length, 1)
  assert.equal(badNumber.errors[0].key, 'recall.maxItems')
  assert.match(badNumber.errors[0].message, /expected number 1\.\.20/)
  assert.equal(badNumber.flat['recall.maxItems'], undefined, '非法值不能进入 flat')

  assert.match(validatePatch({ 'capture': 'yes' }).errors[0].message, /expected boolean/)
  assert.match(validatePatch({ 'recall.maxItems': true }).errors[0].message, /expected number/)
  assert.match(validatePatch({ 'recall.maxItems': null }).errors[0].message, /expected number/)
  assert.match(validatePatch({ 'recall.scope': 'everything' }).errors[0].message, /expected one of/)
  assert.match(validatePatch({ 'extraction.provider': 42 }).errors[0].message, /expected string/)
  assert.match(validatePatch({ 'extraction.provider': 'x'.repeat(501) }).errors[0].message, /at most 500/)

  const unknown = validatePatch({ 'memory.nope': 1 })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errors[0].message, 'unknown setting')

  // 合法与非法混在一起：ok=false，但 flat 里保留能用的值（由调用方决定是否整体拒绝）
  const mixed = validatePatch({ 'recall.maxItems': 7, 'memory.nope': 1 })
  assert.equal(mixed.ok, false)
  assert.equal(mixed.flat['recall.maxItems'], 7)
  assert.deepEqual(mixed.errors.map((error) => error.key), ['memory.nope'])

  for (const notAnObject of ['recall.maxItems', [], 42, true]) {
    const rejected = validatePatch(notAnObject)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.errors[0].message, 'patch must be an object')
    assert.deepEqual(rejected.flat, {})
  }
})

test('validateUnset 只接受字段目录里的 key 列表', () => {
  assert.deepEqual(validateUnset(undefined), { ok: true, errors: [], keys: [] })
  assert.deepEqual(validateUnset(null), { ok: true, errors: [], keys: [] })
  const good = validateUnset(['recall.maxItems', 'debug'])
  assert.deepEqual(good, { ok: true, errors: [], keys: ['recall.maxItems', 'debug'] })

  const unknown = validateUnset(['nope'])
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errors[0].message, 'unknown setting')
  assert.deepEqual(unknown.keys, [])

  const nonString = validateUnset([42])
  assert.equal(nonString.ok, false)
  assert.equal(nonString.errors[0].key, '42')

  const notArray = validateUnset('recall.maxItems')
  assert.equal(notArray.ok, false)
  assert.equal(notArray.errors[0].message, 'unset must be an array of keys')
})

test('向量模型字段：默认走内置词法，数值钳位，未知 provider 落回 hash', () => {
  const fresh = resolveConfig({})
  assert.equal(fresh.vector.provider, 'hash', '不配置就必须还是内置词法')
  assert.equal(fresh.vector.model, '')
  assert.equal(fresh.vector.dims, 0, '0 = 自动解析维度')
  assert.equal(fresh.vector.baseUrl, '')
  assert.equal(fresh.vector.apiKeyRef, '')
  assert.equal(fresh.vector.minCosine, 0.5)
  assert.equal(fresh.vector.timeoutMs, 5000)

  // A provider this build does not implement must not reach the runtime.
  assert.equal(resolveConfig({ vector: { provider: 'huggingface' } }).vector.provider, 'hash')
  assert.equal(resolveConfig({ vector: { provider: 'openai' } }).vector.provider, 'openai')

  assert.equal(validatePatch({ 'vector.provider': 'openai' }).flat['vector.provider'], 'openai')
  assert.equal(validatePatch({ 'vector.provider': 'anthropic' }).ok, false)
  assert.equal(validatePatch({ 'vector.dims': -1 }).flat['vector.dims'], 0)
  assert.equal(validatePatch({ 'vector.dims': 99999 }).flat['vector.dims'], 4096)
  assert.equal(validatePatch({ 'vector.dims': 1536.4 }).flat['vector.dims'], 1536)
  assert.equal(validatePatch({ 'vector.minCosine': 0.65 }).flat['vector.minCosine'], 0.65)
  assert.equal(validatePatch({ 'vector.minCosine': 9 }).flat['vector.minCosine'], 1)
  assert.equal(validatePatch({ 'vector.timeoutMs': 1 }).flat['vector.timeoutMs'], 500)
  assert.equal(validatePatch({ 'vector.apiKeyRef': '  OPENAI_API_KEY  ' }).flat['vector.apiKeyRef'], 'OPENAI_API_KEY')
  // Text fields stay strings and are trimmed like every other text field.
  assert.equal(validatePatch({ 'vector.model': 42 }).ok, false)
  assert.equal(validatePatch({ 'vector.baseUrl': '   ' }).flat['vector.baseUrl'], '')
})

// ── 合并与来源 ──────────────────────────────────────────────────────────────

test('mergeRaw：settings > loader > 默认值，且不修改任何输入', () => {
  const loader = { maxItems: 4, capture: false, extraction: { everyN: 9, provider: 'loader-provider' } }
  const stored = { maxItems: 8, extraction: { idleMs: 2000 } }
  const loaderBefore = snapshot(loader)
  const storedBefore = snapshot(stored)

  const merged = mergeRaw(loader, stored)
  assert.equal(merged.maxItems, 8, 'settings 层覆盖 loader')
  assert.equal(merged.capture, false, 'settings 没写的值来自 loader')
  assert.equal(merged.extraction.everyN, 9, 'loader 的嵌套值保留')
  assert.equal(merged.extraction.idleMs, 2000, 'settings 的嵌套值追加')
  assert.equal(merged.extraction.provider, 'loader-provider')
  assert.notEqual(merged, loader)
  assert.notEqual(merged.extraction, loader.extraction, '返回的是新对象，不是入参别名')

  const config = resolveConfig(merged)
  assert.equal(config.maxItems, 8)
  assert.equal(config.capture, false)
  assert.equal(config.extraction.everyN, 9)
  assert.equal(config.extraction.idleMs, 2000)
  assert.equal(config.minScore, 0.2, '谁都没写的字段回落到内建默认值')

  assert.deepEqual(snapshot(loader), loaderBefore, 'loader config 不能被改动')
  assert.deepEqual(snapshot(stored), storedBefore, 'settings 层不能被改动')

  // 非对象入参按空对象处理
  assert.deepEqual(mergeRaw(null, undefined), {})
  assert.deepEqual(mergeRaw([1, 2], 'x'), {})
})

test('deepMerge 深合 plain object、数组整体替换、不改输入', () => {
  const base = { tags: ['a', 'b'], core: { enabled: true, maxItems: 6 }, note: 'old' }
  const patch = { tags: ['c'], core: { maxItems: 3 }, extra: 1 }
  const baseBefore = snapshot(base)
  const patchBefore = snapshot(patch)
  assert.deepEqual(deepMerge(base, patch), {
    tags: ['c'],
    core: { enabled: true, maxItems: 3 },
    note: 'old',
    extra: 1,
  })
  assert.deepEqual(snapshot(base), baseBefore)
  assert.deepEqual(snapshot(patch), patchBefore)
  // 标量/数组用 patch 覆盖 base
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] })
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 })
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 })
})

test('collectSources 区分 default / config / settings 三种来源', () => {
  const sources = collectSources({ maxItems: 2, extraction: { everyN: 7 } }, { maxItems: 3 })
  for (const field of FIELDS) {
    assert.ok(Object.hasOwn(sources, field.key), `每个字段都要有来源：缺 ${field.key}`)
    assert.ok(['default', 'config', 'settings'].includes(sources[field.key]))
  }
  assert.equal(sources['recall.maxItems'], 'settings', 'settings 层优先')
  assert.equal(sources['extraction.everyN'], 'config')
  assert.equal(sources['recall.maxChars'], 'default')
  assert.deepEqual(SOURCE, { default: 'default', config: 'config', settings: 'settings' })

  // 显式 undefined 不算「设置过」：继续往下一层找
  const withUndefined = collectSources({ maxItems: 2 }, { maxItems: undefined })
  assert.equal(withUndefined['recall.maxItems'], 'config')
  assert.equal(collectSources({}, {})['recall.maxItems'], 'default')
})

// ── 原地生效 ────────────────────────────────────────────────────────────────

test('applyLiveConfig 原地写入 live 字段，并保持嵌套对象引用不变', () => {
  const current = resolveConfig({})
  const extractionRef = current.extraction
  const coreRef = current.core
  const layersRef = current.layers
  const next = resolveConfig({ maxItems: 8, capture: false, core: { maxItems: 4 }, extraction: { everyN: 9 } })

  const { applied, restartRequired } = applyLiveConfig(current, next)
  assert.deepEqual(restartRequired, [])
  assert.equal(current.maxItems, 8)
  assert.equal(current.capture, false)
  assert.equal(current.extraction, extractionRef, 'config.extraction 的引用不能在保存后换掉')
  assert.equal(current.core, coreRef)
  assert.equal(current.layers, layersRef)
  assert.equal(extractionRef.everyN, 9, '持有旧引用的闭包必须看到新值')
  assert.equal(coreRef.maxItems, 4)
  // 只有真正变化的 live 字段进 applied
  for (const key of ['recall.maxItems', 'capture', 'core.maxItems', 'extraction.everyN']) {
    assert.ok(applied.includes(key), `${key} 应该被应用`)
  }
  assert.ok(!applied.includes('recall.maxChars'), '没变的字段不应出现在 applied 里')

  // 同一份 next 再应用一次：已经没有变化
  assert.deepEqual(applyLiveConfig(current, next), { applied: [], restartRequired: [] })
})

test('applyLiveConfig 只报告、不应用重启敏感字段', () => {
  const dir = tempDir()
  try {
    const runningDb = join(dir, 'running.db')
    const nextDb = join(dir, 'next.db')
    const current = resolveConfig({ dbPath: runningDb })
    const skillsRef = current.skills
    const extractionRef = current.extraction
    const next = resolveConfig({
      dbPath: nextDb,
      skills: { enabled: false, dir: 'C:\\bundled-skills' },
      extraction: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    })

    const { applied, restartRequired } = applyLiveConfig(current, next)
    assert.deepEqual(applied, [], '重启项一个都不能热更新')
    assert.deepEqual(restartRequired.sort(), [
      'extraction.model',
      'extraction.provider',
      'skills.dir',
      'skills.enabled',
      'storage.dbPath',
    ])
    assert.equal(current.dbPath, runningDb, '运行中的库路径不能变')
    assert.equal(current.skills, skillsRef)
    assert.equal(current.skills.enabled, true)
    assert.equal(current.skills.dir, '')
    assert.equal(current.extraction, extractionRef)
    assert.equal(current.extraction.provider, '', 'provider/model 要等重启')
    assert.equal(current.extraction.model, '')

    // 再应用一次同一份配置：仍是「需要重启」，不是「已应用」
    const repeat = applyLiveConfig(current, next)
    assert.deepEqual(repeat.applied, [])
    assert.deepEqual(repeat.restartRequired.sort(), restartRequired)
  } finally {
    cleanup(dir)
  }
})

// ── 删除 / 嵌套 / 分组 ─────────────────────────────────────────────────────

test('deletePath 删除值并剪掉被删空的父对象，不存在的路径返回 false', () => {
  const root = { maxItems: 6, core: { enabled: false, maxItems: 6 }, extraction: { everyN: 5 }, layers: {} }

  assert.equal(deletePath(root, ['core', 'enabled']), true)
  assert.deepEqual(root.core, { maxItems: 6 }, '父对象还有兄弟键时不能删')

  assert.equal(deletePath(root, ['core', 'maxItems']), true)
  assert.equal(Object.hasOwn(root, 'core'), false, '空的父对象要剪掉')

  assert.equal(deletePath(root, ['extraction']), true)
  assert.equal(Object.hasOwn(root, 'extraction'), false)

  assert.equal(deletePath(root, ['maxItems']), true)
  assert.deepEqual(root, { layers: {} })

  // 不存在的路径：false，且不改动
  assert.equal(deletePath(root, ['nope', 'deeper']), false)
  assert.equal(deletePath(root, ['layers', 'l0']), false)
  assert.equal(deletePath({}, ['a']), false)
  assert.equal(deletePath({ a: 1 }, ['a', 'b']), false, '父级不是对象时不能继续往下删')
  assert.deepEqual(root, { layers: {} }, '失败的删除不能顺手剪枝')
})

test('toNested 生成的行配置形状与 loader config 一致', () => {
  const nested = toNested({
    'recall.maxItems': 8,
    'recall.scope': 'global',
    'core.enabled': false,
    'extraction.everyN': 10,
    'storage.dbPath': 'D:\\memory.db',
    'debug': true,
  })
  assert.deepEqual(nested, {
    maxItems: 8,
    scope: 'global',
    core: { enabled: false },
    extraction: { everyN: 10 },
    dbPath: 'D:\\memory.db',
    debug: true,
  })
  // 直接喂回 resolveConfig 就能当 loader config 用
  const config = resolveConfig(nested)
  assert.equal(config.maxItems, 8)
  assert.equal(config.scope, 'global')
  assert.equal(config.core.enabled, false)
  assert.equal(config.extraction.everyN, 10)
  assert.equal(config.dbPath, 'D:\\memory.db')
  assert.equal(config.debug, true)
  // 未知 key 不产生垃圾字段
  assert.deepEqual(toNested({ 'no.such.key': 1 }), {})
})

test('buildGroups 输出 8 组、字段元数据齐全、重启项带 active', () => {
  const dir = tempDir()
  try {
    const loaderRaw = { dbPath: join(dir, 'from-loader.db') }
    const storedSettings = { dbPath: join(dir, 'from-settings.db'), maxItems: 9, extraction: { provider: 'next-provider' } }
    const effective = resolveConfig(mergeRaw(loaderRaw, storedSettings))
    const active = resolveConfig({ dbPath: join(dir, 'running.db') })

    const groups = buildGroups(effective, active, loaderRaw, storedSettings)
    assert.deepEqual(
      groups.map((group) => group.id),
      ['recall', 'capture', 'extraction', 'scenes', 'persona', 'vector', 'storage', 'advanced'],
    )
    const fields = groups.flatMap((group) => group.fields)
    // 每个字段恰好出现一次（分组过滤不能丢字段或重复字段）
    assert.deepEqual(fields.map((field) => field.key).sort(), FIELDS.map((field) => field.key).sort())

    for (const field of fields) {
      assert.ok(['number', 'boolean', 'enum', 'text'].includes(field.type))
      assert.equal(typeof field.live, 'boolean')
      assert.ok(['default', 'config', 'settings'].includes(field.source), `${field.key} 的 source 非法`)
      assert.notEqual(field.default, undefined, `${field.key} 缺 default`)
      assert.notEqual(field.value, undefined, `${field.key} 缺 value`)
    }

    // number 字段带 min/max/step，default 落在范围内
    for (const field of fields.filter((candidate) => candidate.type === 'number')) {
      assert.equal(typeof field.min, 'number')
      assert.equal(typeof field.max, 'number')
      assert.equal(typeof field.step, 'number')
      assert.ok(field.default >= field.min && field.default <= field.max, `${field.key} 的默认值越界`)
    }
    // enum 字段带 options，且默认值是合法选项
    const enums = fields.filter((field) => field.type === 'enum')
    assert.deepEqual(enums.map((field) => field.key).sort(), ['persona.personaReasoningEffort', 'recall.scope', 'vector.provider'])
    for (const field of enums) {
      assert.ok(Array.isArray(field.options) && field.options.length > 0)
      assert.ok(field.options.includes(field.default), `${field.key} 的默认值不在 options 里`)
    }
    // 只有 live:false 的字段带 active
    for (const field of fields) {
      assert.equal(Object.hasOwn(field, 'active'), field.live === false, `${field.key} 的 active 出现时机不对`)
    }

    // 生效值来自 settings 层；active 是运行中的旧值
    const dbField = fields.find((field) => field.key === 'storage.dbPath')
    assert.equal(dbField.value, join(dir, 'from-settings.db'))
    assert.equal(dbField.active, join(dir, 'running.db'))
    assert.equal(dbField.source, 'settings')
    const provider = fields.find((field) => field.key === 'extraction.provider')
    assert.equal(provider.value, 'next-provider')
    assert.equal(provider.active, '')

    const maxItems = fields.find((field) => field.key === 'recall.maxItems')
    assert.equal(maxItems.value, 9)
    assert.equal(maxItems.default, 6)
    assert.equal(maxItems.source, 'settings')
    // 没被任何人改过的字段保持 default 来源
    assert.equal(fields.find((field) => field.key === 'recall.maxChars').source, 'default')
  } finally {
    cleanup(dir)
  }
})

// ── settings-store：读 ─────────────────────────────────────────────────────

test('readSettingsFile：缺失返回空、损坏返回空并报错、非对象报错', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    assert.deepEqual(readSettingsFile(path), { settings: {}, exists: false, updatedAt: null, error: null })

    writeFileSync(path, 'not json{')
    const corrupt = readSettingsFile(path)
    assert.deepEqual(corrupt.settings, {}, '损坏的设置文件不能半读')
    assert.equal(corrupt.exists, true)
    assert.equal(corrupt.updatedAt, null)
    assert.match(corrupt.error, /not valid JSON/)

    writeFileSync(path, '[1,2,3]')
    const array = readSettingsFile(path)
    assert.deepEqual(array.settings, {})
    assert.match(array.error, /must contain a JSON object/)

    writeFileSync(path, `{"maxItems": 1, "pad": "${'x'.repeat(1024 * 1024)}"}`)
    const oversized = readSettingsFile(path)
    assert.deepEqual(oversized.settings, {})
    assert.match(oversized.error, /larger than 1048576 bytes/)
  } finally {
    cleanup(dir)
  }
})

test('readSettingsFile：兼容 {settings} 包装与裸对象，且不把版本字段混进配置', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({ version: 1, updatedAt: '2026-10-23T08:00:00.000Z', settings: { maxItems: 8, core: { enabled: false } } }),
    )
    const wrapped = readSettingsFile(path)
    assert.deepEqual(wrapped.settings, { maxItems: 8, core: { enabled: false } })
    assert.equal(wrapped.exists, true)
    assert.equal(wrapped.updatedAt, '2026-10-23T08:00:00.000Z')
    assert.equal(wrapped.error, null)

    // 裸对象（手写或旧版文件）也能读，且没有 updatedAt
    writeFileSync(path, JSON.stringify({ maxItems: 5, dbPath: 'D:\\memory.db' }))
    const plain = readSettingsFile(path)
    assert.deepEqual(plain.settings, { maxItems: 5, dbPath: 'D:\\memory.db' })
    assert.equal(plain.exists, true)
    assert.equal(plain.updatedAt, null)
    assert.equal(plain.error, null)
  } finally {
    cleanup(dir)
  }
})

// ── settings-store：写 / 清 ────────────────────────────────────────────────

test('writeSettingsFile 原子写入：可读回、覆盖旧值、不残留 .tmp', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'memory', 'settings.json')
    const written = writeSettingsFile(path, { maxItems: 9, extraction: { everyN: 12 } })
    assert.ok(written.bytes > 0)
    assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.version, 1, '文件里要带格式版本')
    assert.equal(raw.updatedAt, written.updatedAt)
    assert.deepEqual(raw.settings, { maxItems: 9, extraction: { everyN: 12 } })

    const read = readSettingsFile(path)
    assert.deepEqual(read.settings, { maxItems: 9, extraction: { everyN: 12 } })
    assert.equal(read.updatedAt, written.updatedAt)
    assert.equal(read.exists, true)
    assert.equal(read.error, null)
    assert.deepEqual(
      readdirSync(join(dir, 'memory')).filter((name) => name !== 'settings.json'),
      [],
      '写入后不能留下临时文件',
    )

    // 覆盖写：整份替换，不残留上一次的 key
    writeSettingsFile(path, { maxItems: 3 })
    assert.deepEqual(readSettingsFile(path).settings, { maxItems: 3 })
  } finally {
    cleanup(dir)
  }
})

test('writeSettingsFile 写入失败时抛出且不留下半份设置文件', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    // 用同名目录占住「临时文件」路径，让临时写失败
    mkdirSync(`${path}.tmp`)
    try {
      assert.throws(() => writeSettingsFile(path, { maxItems: 1 }))
      assert.equal(existsSync(path), false, '失败的写入不能生成目标文件')
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true })
    }
  } finally {
    cleanup(dir)
  }
})

test('clearSettingsFile 删除设置层文件，缺失时返回 false', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'settings.json')
    assert.equal(clearSettingsFile(path), false)
    writeSettingsFile(path, { maxItems: 8 })
    assert.equal(existsSync(path), true)
    assert.equal(clearSettingsFile(path), true)
    assert.equal(existsSync(path), false)
  } finally {
    cleanup(dir)
  }
})

// ── settings-store：存储目录描述 ───────────────────────────────────────────

test('describeStorage 列出库/设置文件与体积，缺目录不算错误', () => {
  const dir = tempDir()
  try {
    const memoryDir = join(dir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'memory.db'), Buffer.alloc(2048, 7))
    writeFileSync(join(memoryDir, 'memory.db-wal'), Buffer.alloc(512, 1))
    const settingsPath = join(memoryDir, 'settings.json')
    writeSettingsFile(settingsPath, { maxItems: 8 })
    mkdirSync(join(memoryDir, 'backup')) // 目录不进入文件列表

    const info = describeStorage({
      dir: memoryDir,
      dbPath: join(memoryDir, 'memory.db'),
      settingsPath,
      home: 'C:\\Users\\example\\.dsh',
    })
    assert.equal(info.dir, memoryDir)
    assert.equal(info.dbPath, join(memoryDir, 'memory.db'))
    assert.equal(info.settingsPath, settingsPath)
    assert.equal(info.home, 'C:\\Users\\example\\.dsh')
    assert.equal(info.settingsExists, true)
    assert.equal(info.error, null)
    assert.deepEqual(info.files.map((file) => file.name), ['memory.db', 'memory.db-wal', 'settings.json'])
    const database = info.files.find((file) => file.name === 'memory.db')
    assert.equal(database.bytes, 2048)
    assert.equal(typeof database.modifiedAt, 'number')
    assert.ok(database.modifiedAt > 0)
    const settingsFile = info.files.find((file) => file.name === 'settings.json')
    assert.equal(info.totalBytes, 2048 + 512 + settingsFile.bytes)

    // 目录还不存在（首次打开数据库之前）：空文件列表 + 无错误
    const missing = describeStorage({
      dir: join(dir, 'not-created-yet'),
      dbPath: join(dir, 'not-created-yet', 'memory.db'),
      settingsPath: join(dir, 'not-created-yet', 'settings.json'),
      home: 'H',
    })
    assert.deepEqual(missing.files, [])
    assert.equal(missing.totalBytes, 0)
    assert.equal(missing.error, null)
    assert.equal(missing.settingsExists, false)
    assert.equal(missing.home, 'H')
  } finally {
    cleanup(dir)
  }
})

// ── settings-store：打开目录（注入 fake spawn，不真的开窗口） ───────────────

test('revealDirectory 按平台选择文件管理器，失败只降级不抛', () => {
  const dir = join(tmpdir(), 'dsh-memory-memory')
  const calls = []
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { on() {}, unref() {} }
  }

  for (const [platform, expected] of [
    ['win32', 'explorer.exe'],
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ]) {
    assert.deepEqual(revealDirectory(dir, { spawn: fakeSpawn, platform }), { opened: true, dir })
    const call = calls[calls.length - 1]
    assert.equal(call.command, expected, `${platform} 应该用 ${expected}`)
    assert.deepEqual(call.args, [dir])
    assert.equal(call.options.detached, true)
    assert.equal(call.options.stdio, 'ignore')
  }
  assert.equal(calls.length, 3)

  // spawn 同步抛错：返回 opened:false + 错误信息，并记一条 warn
  const logs = []
  const log = (level, message) => logs.push([level, message])
  const failed = revealDirectory(dir, {
    spawn: () => {
      throw new Error('no file manager here')
    },
    platform: 'linux',
    log,
  })
  assert.deepEqual(failed, { opened: false, dir, error: 'no file manager here' })
  assert.ok(logs.some(([level, message]) => level === 'warn' && /no file manager here/.test(message)))

  // spawn 异步报错（ENOENT）只记日志，返回值仍是 opened:true
  const handlers = {}
  const child = {
    on(event, handler) {
      handlers[event] = handler
      return child
    },
    unref() {},
  }
  const asyncResult = revealDirectory(dir, { spawn: () => child, platform: 'win32', log })
  assert.deepEqual(asyncResult, { opened: true, dir })
  assert.equal(typeof handlers.error, 'function', '必须挂 error 监听，否则子进程错误会变成未捕获异常')
  handlers.error(new Error('spawn explorer.exe ENOENT'))
  assert.ok(logs.some(([, message]) => /ENOENT/.test(message)))
})
