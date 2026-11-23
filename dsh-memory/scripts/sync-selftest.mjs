#!/usr/bin/env node
/**
 * 云同步自检（可反复跑，不碰生产命名空间）。
 *
 * 用本机真实的配置（$DSH_HOME/memory/settings.json）与真实的桶，做四件事：
 *   1. 连接测试（LIST）；
 *   2. 把线上库打一致性快照，推到隔离工作区；
 *   3. 另起空库从该工作区引导，逐层对账；
 *   4. 双向写一条再拉回，确认增量链通；最后清场。
 *
 * 用法：
 *   node scripts/sync-selftest.mjs                 # 用 settings.json 里的配置
 *   node scripts/sync-selftest.mjs --workspace=x   # 换隔离工作区名
 *   node scripts/sync-selftest.mjs --db=path.db    # 换源库（默认 $DSH_HOME/memory/memory.db）
 *
 * 退出码：0 全通；1 有任一项不过。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, saveMemory } from '../src/store.js'
import { readSettingsFile } from '../src/settings-store.js'
import { mergeRaw, resolveConfig, resolveHome, resolveSettingsPath } from '../src/settings.js'
import { createSyncEngine } from '../src/sync/engine.js'
import { createRemote } from '../src/sync/remote.js'

const args = new Map(
  process.argv.slice(2).map((item) => {
    const [key, value = ''] = item.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const settingsPath = resolveSettingsPath()
const stored = readSettingsFile(settingsPath)
const config = resolveConfig(mergeRaw({}, stored.settings))
const sourceDb = args.get('db') ?? join(resolveHome(), 'memory', 'memory.db')
const workspace = args.get('workspace') ?? `selftest-${Date.now().toString(36)}`

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  —  ${detail}`}`)
  if (!ok) failures.push(name)
}
const counts = (db) => ({
  memory: Number(db.prepare('SELECT COUNT(*) n FROM memory').get().n),
  // 「活着的」才是可召回的事实；总数里可能含取代目标已被删除的死行，
  // 那类行按设计不随快照走（见 DESIGN-sync-integrity.md 12.3）。
  active: Number(db.prepare('SELECT COUNT(*) n FROM memory WHERE superseded_by IS NULL').get().n),
  history: Number(db.prepare('SELECT COUNT(*) n FROM memory_history').get().n),
  l0: Number(db.prepare('SELECT COUNT(*) n FROM l0_turns').get().n),
  scenes: Number(db.prepare('SELECT COUNT(*) n FROM l2_scenes').get().n),
  persona: Number(db.prepare('SELECT COUNT(*) n FROM l3_persona').get().n),
})

if (config.sync.remote !== 's3') {
  console.log(`当前 remote=${config.sync.remote}，自检只支持 s3（local 用测试套件覆盖）`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-selftest-'))
const logs = []
const log = (level, message) => {
  logs.push(`${level}: ${message}`)
  if (level === 'warn') console.log(`      warn: ${message}`)
}
const syncConfig = () => ({ sync: { ...config.sync, workspace, mode: 'manual' } })
let remote = null

try {
  const copyPath = join(dir, 'source.db')
  const live = new DatabaseSync(sourceDb)
  live.exec(`VACUUM INTO '${copyPath.split(String.fromCharCode(92)).join('/')}'`)
  live.close()

  const source = openDatabase(copyPath)
  const before = counts(source)
  console.log(`源库 ${sourceDb}\n  ${JSON.stringify(before)}\n工作区 ${workspace}\n`)

  const engineA = createSyncEngine({ db: source, config: syncConfig(), log })
  const connection = await engineA.testConnection()
  check('连接测试', connection.ok === true, JSON.stringify(connection))

  const published = await engineA.publishSnapshot()
  check('发布快照', published.published === true, JSON.stringify({ ops: published.ops, parts: published.parts }))

  const target = openDatabase(join(dir, 'target.db'))
  const engineB = createSyncEngine({ db: target, config: syncConfig(), log })
  const pulled = await engineB.syncNow()
  const after = counts(target)
  check('新库引导', pulled.bootstrap !== undefined && pulled.bootstrap.mismatch === '', JSON.stringify(pulled.bootstrap))
  for (const key of ['active', 'l0', 'scenes', 'persona']) {
    check(`对账 ${key}`, before[key] === after[key], `${before[key]} → ${after[key]}`)
  }
  check('死行不入快照（差异只允许来自悬空取代）', after.memory <= before.memory, `总数 ${before.memory} → ${after.memory}`)

  // 增量：源库改一条、推、对端拉
  const row = source.prepare('SELECT id, text FROM memory WHERE superseded_by IS NULL ORDER BY id LIMIT 1').get()
  if (row !== undefined) {
    source.prepare('UPDATE memory SET text = ? WHERE id = ?').run(`${String(row.text)}（自检）`, row.id)
    const push = await engineA.syncNow()
    const pull = await engineB.syncNow()
    check('增量推送', Number(push.pushed) >= 1, JSON.stringify({ pushed: push.pushed, ops: push.ops }))
    check('增量拉取', Number(pull.pulled) >= 1, JSON.stringify({ pulled: pull.pulled, applied: pull.applied }))
  }

  const verdict = await engineB.verify()
  check('逐键自查', verdict.ok === true, JSON.stringify({ localOnly: verdict.localOnly, remoteMissing: verdict.remoteMissing, remoteStale: verdict.remoteStale }))

  remote = createRemote({
    kind: 's3',
    endpoint: config.sync.s3.endpoint,
    bucket: config.sync.s3.bucket,
    region: config.sync.s3.region,
    pathStyle: config.sync.s3.pathStyle,
    accessKey: config.sync.s3.accessKeyRef,
    secretKey: config.sync.s3.secretKeyRef,
  })
  const prefix = `${String(config.sync.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/`
  const objects = await remote.list(prefix)
  check('远端留有对象', objects.length > 0, `${objects.length} 个`)
  for (const object of objects) await remote.delete(object.key)
  check('清场', (await remote.list(prefix)).length === 0)

  source.close()
  target.close()
} catch (error) {
  check('执行', false, String(error?.message ?? error))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? '全部通过' : `未通过 ${failures.length} 项：${failures.join(' / ')}`}`)
if (failures.length > 0) {
  console.log('\n最近日志：\n' + logs.slice(-12).join('\n'))
  process.exit(1)
}
