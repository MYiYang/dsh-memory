/**
 * 崩溃与故障注入：进程在任何一步断掉，都不许留下半份可见数据。
 *
 * 用一条可控的远端（remoteFactory 注入）在指定的第 N 次 put/get 上抛错，
 * 模拟断电、断网、进程被杀。断言一律围绕「对端能看到什么」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { createRemote } from '../src/sync/remote.js'
import { collectSnapshotOps, createSyncEngine } from '../src/sync/engine.js'
import { getSyncMeta, setSyncEnabled, setSyncMeta } from '../src/sync/schema.js'
import { encodeSegment } from '../src/sync/segment.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-crash-'))
}

function newDb(dir, name) {
  return openDatabase(join(dir, `${name}.db`))
}

function configFor(dir, overrides = {}) {
  return {
    dbPath: join(dir, 'a.db'),
    sync: {
      enabled: true,
      mode: 'manual',
      everySeconds: 300,
      workspace: 'ws',
      remote: 'local',
      local: { dir: join(dir, 'remote') },
      s3: { endpoint: '', bucket: '', region: 'us-east-1', pathStyle: true, prefix: 'v1' },
      snapshotOpsPerPart: 2,
      ...overrides,
    },
  }
}

/**
 * A local remote that throws on the Nth put / get.
 * @param {string} dir
 * @param {{ failPutAt?: number, failGetAt?: number }} plan
 */
function faultyRemote(dir, plan = {}) {
  const base = createRemote({ kind: 'local', dir })
  const counts = { put: 0, get: 0 }
  const boom = (what, n) => {
    const error = new Error(`injected ${what} failure #${n}`)
    Object.assign(error, { code: 'ECONNRESET' })
    return error
  }
  return {
    ...base,
    async put(key, body, opts) {
      counts.put += 1
      if (plan.failPutAt === counts.put) throw boom('put', counts.put)
      return base.put(key, body, opts)
    },
    async get(key) {
      counts.get += 1
      if (plan.failGetAlways === true || plan.failGetAt === counts.get) throw boom('get', counts.get)
      return base.get(key)
    },
  }
}

const snapshotFiles = (dir) => {
  const path = join(dir, 'remote', 'v1', 'ws', 'snapshot')
  if (!existsSync(path)) return []
  return readdirSync(path)
}

const count = (db, target) =>
  Number(db.prepare(target.includes(' ') ? target : `SELECT COUNT(*) AS n FROM ${target}`).get().n)

test('发布分片中途断掉：没有 manifest，对端什么也拉不到', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  for (let index = 0; index < 5; index += 1) saveMemory(a, { text: `第一层第 ${index} 条` }, index + 1)

  const failing = createSyncEngine({
    db: a,
    config: configFor(dir),
    remoteFactory: () => faultyRemote(join(dir, 'remote'), { failPutAt: 1 }),
  })
  const published = await failing.publishSnapshot()
  assert.equal(published.published, false)
  assert.equal(snapshotFiles(dir).filter((name) => name.endsWith('.manifest.json')).length, 0, '没有 manifest 才算没发布')

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 0)
  assert.equal(getSyncMeta(b, 'bootstrapped'), '')
})

test('manifest 写入失败：整份快照不可见，重试后只留一份', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  for (let index = 0; index < 205; index += 1) saveMemory(a, { text: `重试第 ${index} 条` }, index + 1)

  // 205 条 → 每片 200 → 两片，第 3 次 put 才是 manifest（meta 属尽力而为，不算）
  const failing = createSyncEngine({
    db: a,
    config: configFor(dir),
    remoteFactory: () => faultyRemote(join(dir, 'remote'), { failPutAt: 3 }),
  })
  const first = await failing.publishSnapshot()
  assert.equal(first.published, false)
  assert.equal(snapshotFiles(dir).filter((name) => name.endsWith('.manifest.json')).length, 0)

  const healthy = createSyncEngine({ db: a, config: configFor(dir) })
  const second = await healthy.publishSnapshot()
  assert.equal(second.published, true)
  assert.equal(snapshotFiles(dir).filter((name) => name.endsWith('.manifest.json')).length, 1)

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 205)
})

test('读了半个快照就断：一条也不应用', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  for (let index = 0; index < 205; index += 1) saveMemory(a, { text: `半份第 ${index} 条` }, index + 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const published = await engineA.publishSnapshot()
  assert.ok(published.parts >= 2, '本用例需要多分片')

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({
    db: b,
    config: configFor(dir),
    remoteFactory: () => faultyRemote(join(dir, 'remote'), { failGetAlways: true }),
  })
  const result = await engineB.syncNow()
  assert.ok(result.bootstrapError !== undefined || result.error !== undefined)
  assert.equal(count(b, 'memory'), 0, '先校验后应用：半份快照一条都不许落地')
  assert.equal(getSyncMeta(b, 'bootstrapped'), '')
})

test('拉段时断网：游标不前进，下一轮重取成功', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '来自甲的一条' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.syncNow() // 首启自愈，顺带把这条推成段
  const push = await engineA.syncNow()
  assert.ok(push.pushed >= 0)

  const b = newDb(dir, 'b')
  setSyncMeta(b, 'bootstrapped', '1') // 跳过引导，专测拉段
  const flaky = createSyncEngine({
    db: b,
    config: configFor(dir),
    remoteFactory: () => faultyRemote(join(dir, 'remote'), { failGetAt: 1 }),
  })
  await flaky.syncNow()
  assert.equal(count(b, 'SELECT COUNT(*) n FROM sync_peer'), 0, '取段失败不得前移游标')

  const healthy = createSyncEngine({ db: b, config: configFor(dir) })
  const pulled = await healthy.syncNow()
  assert.ok(pulled.applied >= 1)
  assert.equal(count(b, 'memory', "WHERE text = '来自甲的一条'"), 1)
})

test('段体被截断：解码失败，不应用也不推进游标', async () => {
  const dir = tempDir()
  const device = 'truncated-peer'
  const segDir = join(dir, 'remote', 'v1', 'ws', device)
  const ops = collectSnapshotOps(newDb(dir, 'seed'), { lamport: 1, device, now: 1 }).slice(0, 1)
  const body = encodeSegment({ device, seq: 1, ops, now: 1 })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(segDir, { recursive: true })
  writeFileSync(join(segDir, '00000001.jsonl.br'), body.subarray(0, 5))

  const b = newDb(dir, 'b')
  setSyncMeta(b, 'bootstrapped', '1')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const result = await engineB.syncNow()
  assert.ok(result.error !== undefined, '坏段应当报错而不是静默通过')
  assert.equal(count(b, 'SELECT COUNT(*) n FROM sync_peer'), 0)
})
