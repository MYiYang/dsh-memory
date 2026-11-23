/**
 * 同步完整性回归。
 *
 * 每条都对应 DESIGN-sync-integrity.md 里一处会丢记忆的差错，任何一条红了都
 * 不许合：快照四层覆盖、墓碑传播、lamport 单调、首启自愈（只发一次）、
 * 半截快照不可见、校验和拒收、历史行先到后补。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateMemory } from '../src/data.js'
import { openDatabase, saveMemory } from '../src/store.js'
import { drainPending } from '../src/sync/apply.js'
import { applyOps } from '../src/sync/apply.js'
import { collectSnapshotOps, createSyncEngine } from '../src/sync/engine.js'
import { getSyncMeta, listTombstones, setSyncEnabled, setSyncMeta } from '../src/sync/schema.js'
import { encodeSegment } from '../src/sync/segment.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-integrity-'))
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
      ...overrides,
    },
  }
}

const count = (db, tbl, where = '') => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} ${where}`).get().n)
const manifestDir = (dir) => join(dir, 'remote', 'v1', 'ws', 'snapshot')
const manifests = (dir) => {
  try {
    return readdirSync(manifestDir(dir)).filter((name) => name.endsWith('.manifest.json'))
  } catch {
    return []
  }
}

test('E2：快照覆盖事实、历史、原文、场景、画像五处', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  const fact = saveMemory(a, { text: '事实甲', scope: 'global' }, 1_700_000_000_000)
  a.prepare('INSERT INTO memory_history (memory_id, version, op, text, created_at) VALUES (?, 1, ?, ?, ?)').run(fact.id, 'insert', '事实甲', 1)
  a.prepare(
    "INSERT INTO l0_turns (session_id, turn, project, user_text, assistant_text, tool_names, created_at) VALUES ('s1', 1, NULL, '问', '答', '[]', 1)",
  ).run()
  a.prepare(
    "INSERT INTO l2_scenes (scope, project, name, summary, body, heat, fact_count, created_at, updated_at) VALUES ('global', NULL, '场景甲', '摘要', '正文', 3, 2, 1, 1)",
  ).run()
  a.prepare("INSERT INTO l3_persona (scope, project, body, version, updated_at) VALUES ('global', NULL, '画像正文', 2, 1)").run()

  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const published = await engineA.publishSnapshot()
  assert.equal(published.published, true)
  assert.equal(published.ops, 5)

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const pulled = await engineB.syncNow()
  assert.equal(pulled.bootstrap?.mismatch ?? '', '', '快照条数与本地应完全对账')
  assert.equal(count(b, 'memory'), 1)
  assert.equal(count(b, 'memory_history'), 1)
  assert.equal(count(b, 'l0_turns'), 1)
  assert.equal(count(b, 'l2_scenes'), 1)
  assert.equal(count(b, 'l3_persona'), 1)
  assert.equal(b.prepare('SELECT body FROM l3_persona').get().body, '画像正文')
})

test('E1：快照之后的本机改动仍被对端接受（lamport 不被快照压住）', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '甲' }, 1)
  saveMemory(a, { text: '乙' }, 2)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const published = await engineA.publishSnapshot()
  assert.equal(published.published, true)
  const lamportAfter = Number(getSyncMeta(a, 'lamport'))
  assert.ok(lamportAfter > Number(published.lamport), '发完快照必须把本地 lamport 抬过快照里的值')

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 2)

  setSyncEnabled(a, true)
  const row = a.prepare('SELECT id FROM memory WHERE text = ?').get('甲')
  a.prepare('UPDATE memory SET text = ? WHERE id = ?').run('甲改过', row.id)
  await engineA.syncNow()
  await engineB.syncNow()
  assert.equal(count(b, 'memory', "WHERE text = '甲改过'"), 1, '对端必须收下快照之后的改动')
  assert.equal(count(b, 'memory', "WHERE text = '甲'"), 0)
})

test('E3：删除经墓碑传播，对端不再持有已废事实', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '留下' }, 1)
  saveMemory(a, { text: '要删掉' }, 2)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 2)

  a.prepare("DELETE FROM memory WHERE text = '要删掉'").run()
  assert.equal(listTombstones(a).length, 1)
  // 等价于那条 delete op 早已被 oplog 清理：对端只能靠随后的快照墓碑得知。
  a.prepare('DELETE FROM sync_oplog').run()
  await engineA.syncNow()
  // 定期重发（snapshotEveryHours 到期或有新墓碑时引擎会自动做，这里直接触发一次）
  await engineA.publishSnapshot()
  await engineB.syncNow()

  assert.equal(count(b, 'memory'), 1)
  assert.equal(count(b, 'memory', "WHERE text = '要删掉'"), 0)
})

test('E4：远端无快照时本机自愈发一份，且只发一次', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '唯一的一条' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })

  const first = await engineA.syncNow()
  assert.ok(first.seeded !== undefined, '首轮必须自愈发快照')
  assert.ok(first.seeded.ops >= 1)
  assert.equal(getSyncMeta(a, 'bootstrapped'), '1')
  assert.equal(manifests(dir).length, 1)

  const second = await engineA.syncNow()
  assert.equal(second.seeded, undefined, '第二轮不得再发')
  assert.equal(manifests(dir).length, 1)

  // 空库不得制造空快照
  const c = newDb(dir, 'c')
  const engineC = createSyncEngine({ db: c, config: configFor(dir) })
  const empty = await engineC.syncNow()
  assert.equal(empty.seeded, undefined)
  assert.equal(manifests(dir).length, 1)
})

test('两机各自在空桶首启，靠 snapshot 合流，不各守各的事实', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '甲的私有事实' }, 1)
  const b = newDb(dir, 'b')
  saveMemory(b, { text: '乙的私有事实' }, 2)

  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineA.syncNow()
  await engineB.syncNow()
  // 两轮交叉：各自把对方更新的一份快照合进来
  await engineA.syncNow()
  await engineB.syncNow()
  await engineA.syncNow()

  assert.equal(count(a, 'memory'), 2, '甲应当合到乙的事实')
  assert.equal(count(b, 'memory'), 2, '乙应当合到甲的事实')
})

test('半截快照（只有分片、没有 manifest）永不可见', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '甲' }, 1)
  const device = 'deadbeef-0000-4000-8000-000000000000'
  const ops = collectSnapshotOps(a, { lamport: 5, device, now: 1_700_000_000_000 })
  const partDir = join(manifestDir(dir), '1700000000000-deadbeef')
  mkdirSync(partDir, { recursive: true })
  writeFileSync(join(partDir, 'part-000.jsonl.br'), encodeSegment({ device, seq: 99999999, ops, now: 1 }))

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const result = await engineB.syncNow()
  assert.equal(count(b, 'memory'), 0)
  assert.equal(result.bootstrap, undefined)
  assert.equal(getSyncMeta(b, 'bootstrapped'), '')
})

test('分片被篡改则整份拒收，一条也不落地', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '甲' }, 1)
  saveMemory(a, { text: '乙' }, 2)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const [name] = manifests(dir)
  const stampDevice = name.replace('.manifest.json', '')
  const partPath = join(manifestDir(dir), stampDevice, 'part-000.jsonl.br')
  const body = readFileSync(partPath)
  writeFileSync(partPath, Buffer.concat([body, Buffer.from('garbage')]))

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const result = await engineB.syncNow()
  // 坏快照被跳过而不抛穿：本机既不落地数据，也不会被一份坏快照永久卡死。
  assert.match(String(result.bootstrapError ?? result.error ?? ''), /checksum|snapshot/i)
  assert.equal(count(b, 'memory'), 0, '校验不过就一条都不许落地')
  assert.equal(getSyncMeta(b, 'bootstrapped'), '')
})

test('远端快照版本高于本机则拒收且不动本地数据', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '甲' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const [name] = manifests(dir)
  const path = join(manifestDir(dir), name)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.schema = 99
  writeFileSync(path, JSON.stringify(manifest))

  const b = newDb(dir, 'b')
  saveMemory(b, { text: '本地自有' }, 3)
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const result = await engineB.syncNow()
  assert.equal(result.incompatible, true)
  assert.equal(count(b, 'memory'), 1)
  assert.equal(count(b, 'memory', "WHERE text = '本地自有'"), 1)
})

test('E5：历史行先于事实抵达时挂起，事实落地后补齐', () => {
  const dir = tempDir()
  const db = newDb(dir, 'h')
  const fact = saveMemory(db, { text: '旧事实' }, 1)
  const hash = String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(fact.id).hash)
  db.prepare('DELETE FROM memory WHERE id = ?').run(fact.id)

  const historyOp = {
    opId: 'dev:7',
    tbl: 'memory_history',
    key: `${hash}#1`,
    op: 'upsert',
    lamport: 7,
    device: 'dev',
    payload: { version: 1, op: 'insert', text: '旧事实', created_at: 1, hash },
    createdAt: 1,
  }
  const first = applyOps(db, [historyOp])
  assert.equal(first.pending, 1, '目标缺失应当挂起而不是丢弃')
  assert.equal(count(db, 'sync_pending'), 1)

  saveMemory(db, { text: '旧事实' }, 1)
  const resolved = drainPending(db)
  assert.equal(resolved >= 1, true)
  assert.equal(count(db, 'memory_history'), 1)
  assert.equal(count(db, 'sync_pending'), 0)
})

test('E6：改正文会换键，对端必须回收旧键而不是留陈旧副本', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  const saved = saveMemory(a, { text: '原来那句话' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineA.syncNow()
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 1)

  const before = String(a.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id).hash)
  updateMemory(a, { id: saved.id, text: '改过的那句话' }, 2)
  const after = String(a.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id).hash)
  assert.notEqual(before, after, '正文改了，哈希（跨设备键）就该换')

  await engineA.syncNow()
  await engineB.syncNow()

  assert.equal(count(b, 'memory'), 1, '对端不得同时留着旧正文与新正文')
  assert.equal(b.prepare('SELECT text FROM memory').get().text, '改过的那句话')
  assert.equal(count(b, 'memory_history'), 1, '历史行应挂在新的键上，不该失落')
})

test('审计1：更旧的远端 op 不得覆盖本地较新的改动', () => {
  const dir = tempDir()
  const db = newDb(dir, 'local')
  setSyncEnabled(db, true)
  const saved = saveMemory(db, { text: '共享事实' }, 1)
  db.prepare('UPDATE memory SET tags = ? WHERE id = ?').run('["本地新"]', saved.id)
  const hash = String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id).hash)
  const state = db.prepare("SELECT lamport FROM sync_rowstate WHERE tbl = 'memory' AND row_key = ?").get(hash)
  assert.ok(Number(state?.lamport) >= 2, '本地写入必须落 rowstate')

  const counts = applyOps(db, [
    { opId: 'r:1', tbl: 'memory', key: hash, op: 'upsert', lamport: 1, device: 'other', payload: { text: '共享事实', tags: '["远端旧"]', kind: 'fact', scope: 'global' }, createdAt: 1 },
  ])
  assert.equal(counts.conflicts, 1)
  assert.equal(db.prepare('SELECT tags FROM memory WHERE id = ?').get(saved.id).tags, '["本地新"]')
})

test('审计2：应用远端删除后，旧段不得把这条复活', () => {
  const dir = tempDir()
  const db = newDb(dir, 'revive')
  setSyncEnabled(db, true)
  const saved = saveMemory(db, { text: '注定要被删掉' }, 1)
  const hash = String(db.prepare('SELECT hash FROM memory WHERE id = ?').get(saved.id).hash)

  applyOps(db, [{ opId: 'r:del', tbl: 'memory', key: hash, op: 'delete', lamport: 9, device: 'other', payload: { hash }, createdAt: 9 }])
  assert.equal(count(db, 'memory'), 0)
  assert.equal(listTombstones(db).length, 1, '应用删除也要留墓碑')

  const counts = applyOps(db, [
    { opId: 'r:old', tbl: 'memory', key: hash, op: 'upsert', lamport: 1, device: 'other', payload: { text: '注定要被删掉', tags: '[]', kind: 'fact', scope: 'global' }, createdAt: 1 },
  ])
  assert.equal(counts.applied, 0)
  assert.equal(count(db, 'memory'), 0, '已删除的键不得被旧段复活')
})

test('审计3：最新快照损坏时回退到次新，而不是永久停摆', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '第一份快照里的' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()
  saveMemory(a, { text: '第二份快照里的' }, 2)
  await engineA.publishSnapshot()

  const names = manifests(dir).sort()
  assert.equal(names.length, 2)
  const newest = names[names.length - 1]
  const partDir = join(manifestDir(dir), newest.replace('.manifest.json', ''))
  writeFileSync(join(partDir, 'part-000.jsonl.br'), Buffer.from('garbage'))

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  const result = await engineB.syncNow()
  assert.ok(result.bootstrap !== undefined, '应当回退到次新快照')
  assert.equal(count(b, 'memory'), 1)
  assert.equal(b.prepare('SELECT text FROM memory').get().text, '第一份快照里的')
})

test('审计4：段键被占用时另起序号，绝不覆盖已发布的段', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '要推的一条' }, 1)
  const device = getSyncMeta(a, 'device')
  const deviceDir = join(dir, 'remote', 'v1', 'ws', device)
  mkdirSync(deviceDir, { recursive: true })
  writeFileSync(join(deviceDir, '00000001.jsonl.br'), Buffer.from('occupied'))

  const engine = createSyncEngine({ db: a, config: configFor(dir) })
  const result = await engine.syncNow()
  assert.equal(result.pushed, 1)
  assert.equal(readFileSync(join(deviceDir, '00000001.jsonl.br'), 'utf8'), 'occupied', '原有段内容必须原样保留')
  assert.equal(readdirSync(deviceDir).filter((name) => name.endsWith('.jsonl.br')).length, 2)
})

test('审计5：应用失败的 op 先重试、三次后入队留证而不是消失', async () => {
  const dir = tempDir()
  const device = 'other-device-0001'
  const segDir = join(dir, 'remote', 'v1', 'ws', device)
  mkdirSync(segDir, { recursive: true })
  writeFileSync(
    join(segDir, '00000001.jsonl.br'),
    encodeSegment({ device, seq: 1, ops: [{ opId: 'o:1', tbl: 'memory', key: 'h1', op: 'upsert', lamport: 1, device, payload: { text: '' } }] }),
  )

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'sync_peer'), 0, '失败时游标不得前移')
  await engineB.syncNow()
  await engineB.syncNow()
  assert.equal(count(b, 'sync_peer'), 1, '三次之后放行，避免永久卡死')
  assert.equal(count(b, 'sync_pending'), 1, '失败的 op 要留证')
  assert.match(String(b.prepare('SELECT reason FROM sync_pending').get().reason), /apply-failed/)
})

test('A6：换纪元会立刻发一份新纪元快照，旧纪元段被忽略', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '换纪元前就有的' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.syncNow()

  const rotated = await engineA.rotate()
  assert.equal(rotated.epoch, 2)
  assert.ok(rotated.snapshot !== null, '换纪元必须立刻发一份新纪元快照')
  assert.equal(getSyncMeta(a, 'epoch'), '2')

  // 一个旧纪元的段：内容是新纪元不该接受的
  const peerDir = join(dir, 'remote', 'v1', 'ws', 'old-peer')
  mkdirSync(peerDir, { recursive: true })
  writeFileSync(
    join(peerDir, '00000001.jsonl.br'),
    encodeSegment({
      epoch: 1,
      device: 'old-peer',
      seq: 1,
      ops: [{ opId: 'old:1', tbl: 'memory', key: 'stalehash', op: 'upsert', lamport: 99, device: 'old-peer', payload: { text: '旧纪元塞进来的', tags: '[]', kind: 'fact', scope: 'global' }, createdAt: 1 }],
    }),
  )

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(getSyncMeta(b, 'epoch'), '2', '新设备应采纳桶里的新纪元')
  assert.equal(count(b, 'memory', "WHERE text = '旧纪元塞进来的'"), 0, '旧纪元段不得落地')
  assert.equal(count(b, 'memory'), 1)
})

test('墓碑保留：有沉默对端时不清，无对端时才清', async () => {
  const dir = tempDir()
  const db = newDb(dir, 'tomb')
  setSyncEnabled(db, true)
  const engine = createSyncEngine({ db, config: configFor(dir) })
  const longAgo = Date.now() - 200 * 86_400_000
  const addTombstone = () =>
    db.prepare('INSERT OR REPLACE INTO sync_tombstone (tbl, row_key, lamport, device, deleted_at) VALUES (?, ?, ?, ?, ?)').run('memory', 'deadbeefdeadbeef', 1, 'x', longAgo)

  addTombstone()
  await engine.publishSnapshot()
  assert.equal(count(db, 'sync_tombstone'), 0, '没有对端时，过期墓碑应清掉')

  addTombstone()
  db.prepare('INSERT OR REPLACE INTO sync_peer (peer, cursor, last_seen) VALUES (?, ?, ?)').run('silent-peer', 3, longAgo)
  await engine.publishSnapshot()
  assert.equal(count(db, 'sync_tombstone'), 1, '有长期沉默的对端时必须留着墓碑')
})

test('自查：云端有的我都有，本机多的只是未发布的更新', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '已发布的一条' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  const clean = await engineB.verify()
  assert.equal(clean.ok, true)
  assert.equal(clean.localOnly, 0)
  assert.equal(clean.remoteOnly, 0)
  assert.equal(clean.remoteMissing, 0)

  // 本机新增一条但不发布：自查应报「本机多 1」，且仍不落后
  saveMemory(a, { text: '还没上云的一条' }, 2)
  const ahead = await engineA.verify()
  assert.equal(ahead.ok, true, '本机更新不算落后')
  assert.equal(ahead.localOnly, 1)
  assert.equal(ahead.remoteOnly, 0)
})

test('自查能指出分片损坏，而不是给出「一切正常」', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '会被篡改的快照' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()
  const names = manifests(dir)
  const stampDevice = names[0].replace('.manifest.json', '')
  writeFileSync(join(manifestDir(dir), stampDevice, 'part-000.jsonl.br'), Buffer.from('tampered'))

  const verdict = await engineA.verify()
  assert.equal(verdict.ok, false)
  assert.match(String(verdict.reason), /corrupt/)
})

test('快照保留：自己只留最近三份，更旧的连分片一起回收', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '保留下来的事实' }, 1)
  // 回收有一小时的年龄门槛（对端可能正在引导），故把时钟拨快两小时/次
  let clock = Date.now()
  const engineA = createSyncEngine({ db: a, config: configFor(dir), now: () => clock })
  for (let index = 0; index < 5; index += 1) {
    await engineA.publishSnapshot()
    clock += 2 * 3_600_000
  }
  assert.equal(manifests(dir).length, 3, '只应留最近三份')
  // 最新那份仍然完整可用
  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory'), 1)
})

test('引导后立刻补挂起：被取代的旧事实不得在新设备上继续存活', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  const older = saveMemory(a, { text: '旧的那句' }, 1)
  const newer = saveMemory(a, { text: '新的那句' }, 2)
  const olderHash = String(a.prepare('SELECT hash FROM memory WHERE id = ?').get(older.id).hash)
  const newerHash = String(a.prepare('SELECT hash FROM memory WHERE id = ?').get(newer.id).hash)
  // 旧行（id 更小，快照里排在前面）被新行取代 —— 应用时目标尚未到达，只能挂起
  a.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(newer.id, older.id)

  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()

  const rows = b.prepare('SELECT hash, superseded_by FROM memory').all()
  assert.equal(rows.length, 2)
  const oldRow = rows.find((row) => String(row.hash) === olderHash)
  assert.ok(Number(oldRow.superseded_by) > 0, '引导结束时旧事实必须已被标为取代')
  assert.equal(count(b, 'sync_pending'), 0, '挂起的 op 应当在引导末尾被清掉')
})

test('取代目标已被删除的「死行」不得被快照复活成活动事实', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  const older = saveMemory(a, { text: '早先那句' }, 1)
  const successor = saveMemory(a, { text: '后来那句' }, 2)
  const olderHash = String(a.prepare('SELECT hash FROM memory WHERE id = ?').get(older.id).hash)
  a.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(successor.id, older.id)
  // 后继被删：本地留下悬空指针，读路径一律把它当已废
  a.prepare('DELETE FROM memory WHERE id = ?').run(successor.id)
  assert.equal(count(a, 'memory', 'WHERE superseded_by IS NULL'), 0, '线上这条已是死行')

  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'memory', 'WHERE superseded_by IS NULL'), 0, '新设备上不得出现活动事实')
  assert.equal(count(b, 'memory', 'WHERE hash = ?'.replace('?', `'${olderHash}'`)), 0, '死行本身不随快照走')
})

test('P0：发布窗口里发生的本地写入不得把 lamport 撞回旧值', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '发布前就有的' }, 1)
  let injected = false
  const engine = createSyncEngine({
    db: a,
    config: configFor(dir),
    remoteFactory: (cfg) => {
      const base = createRemote(cfg)
      return {
        ...base,
        async put(key, body, opts) {
          if (!injected && key.includes('/snapshot/') && key.endsWith('.jsonl.br')) {
            injected = true
            saveMemory(a, { text: '发布窗口里写入的一条' }, 2)
          }
          return base.put(key, body, opts)
        },
      }
    },
  })
  await engine.publishSnapshot()
  // 发布后再写一条：若计数器被撞回旧值，这里会因 op_id 重复而抛错
  saveMemory(a, { text: '发布之后写入的一条' }, 3)
  const rows = a.prepare('SELECT COUNT(*) n, COUNT(DISTINCT op_id) d FROM sync_oplog').get()
  assert.equal(Number(rows.n), Number(rows.d), 'op_id 必须唯一')
})

test('P0：项目级场景的删除要能传到对端，而不是空转', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  a.prepare(
    "INSERT INTO l2_scenes (scope, project, name, summary, body, heat, fact_count, created_at, updated_at) VALUES ('project', 'dsh-memory', '待删场景', 's', 'b', 1, 1, 1, 1)",
  ).run()
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  const published = await engineA.publishSnapshot()
  assert.equal(published.published, true)

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'l2_scenes'), 1)

  a.prepare("DELETE FROM l2_scenes WHERE name = '待删场景'").run()
  await engineA.syncNow()
  await engineB.syncNow()
  assert.equal(count(b, 'l2_scenes'), 0, '项目级场景删除必须到达对端')
})

test('P0：项目级画像的删除要能传到对端', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  a.prepare("INSERT INTO l3_persona (scope, project, body, version, updated_at) VALUES ('project', 'dsh-memory', '画像', 1, 1)").run()
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()
  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir) })
  await engineB.syncNow()
  assert.equal(count(b, 'l3_persona'), 1)

  a.prepare("DELETE FROM l3_persona WHERE project = 'dsh-memory'").run()
  await engineA.syncNow()
  await engineB.syncNow()
  assert.equal(count(b, 'l3_persona'), 0, '项目级画像删除必须到达对端')
})

test('换纪元发布失败不会永久停摆：下一轮应当自愈出新纪元快照', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '换纪元前的那条' }, 1)
  const broken = createSyncEngine({
    db: a,
    config: configFor(dir),
    remoteFactory: (cfg) => {
      const base = createRemote(cfg)
      return { ...base, async put() { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }) } }
    },
  })
  const failed = await broken.rotate()
  assert.equal(failed.snapshot, null)
  assert.equal(getSyncMeta(a, 'epoch'), '2')

  const healthy = createSyncEngine({ db: a, config: configFor(dir) })
  const result = await healthy.syncNow()
  assert.ok(result.seeded !== undefined, '旧纪元快照存在时也必须允许本机重播新纪元')
  assert.equal(manifests(dir).filter((name) => name.includes('-')).length >= 1, true)
})

test('取代挂起不随 TTL 清理，其余挂起照常过期', async () => {
  const dir = tempDir()
  const db = newDb(dir, 'ttl')
  setSyncEnabled(db, true)
  saveMemory(db, { text: '活着的一条' }, 1)
  const old = Date.now() - 60 * 86_400_000
  db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
    'p1:supersede',
    JSON.stringify({ hash: 'a', byHash: 'b' }),
    'supersede-target-missing',
    old,
  )
  db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
    'p2:failed',
    JSON.stringify({ kind: 'failed-op', op: {} }),
    'apply-failed',
    old,
  )

  const engine = createSyncEngine({ db, config: configFor(dir) })
  await engine.syncNow()
  const reasons = db.prepare('SELECT reason FROM sync_pending').all().map((row) => String(row.reason))
  assert.deepEqual(reasons, ['supersede-target-missing'], '只该清掉 apply-failed')
})

test('旧纪元的段会被计数并记录，而不是悄无声息', async () => {
  const dir = tempDir()
  const peerDir = join(dir, 'remote', 'v1', 'ws', 'old-peer')
  mkdirSync(peerDir, { recursive: true })
  writeFileSync(
    join(peerDir, '00000001.jsonl.br'),
    encodeSegment({
      epoch: 1,
      device: 'old-peer',
      seq: 1,
      ops: [{ opId: 'x:1', tbl: 'memory', key: 'k1', op: 'upsert', lamport: 5, device: 'old-peer', payload: { text: '旧纪元', tags: '[]', kind: 'fact', scope: 'global' }, createdAt: 1 }],
    }),
  )
  const b = newDb(dir, 'b')
  setSyncEnabled(b, true)
  setSyncMeta(b, 'epoch', '2')
  setSyncMeta(b, 'bootstrapped', '1')
  const logs = []
  const engine = createSyncEngine({ db: b, config: configFor(dir), log: (level, message) => logs.push(`${level}: ${message}`) })
  const result = await engine.syncNow()
  assert.equal(result.staleSegments, 1)
  assert.ok(logs.some((line) => line.includes('epoch 1')), '必须留下告警')
  assert.equal(count(b, 'memory'), 0)
})

test('自查把增量段算进覆盖范围：刚推上去的写入不算「只在本机」', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '早已发布的一条' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir) })
  await engineA.publishSnapshot()

  // 发布之后再写一条并推送：它不在快照里，但在段里
  saveMemory(a, { text: '快照之后写的一条' }, 2)
  const pushed = await engineA.syncNow()
  assert.ok(Number(pushed.pushed) >= 1)

  const verdict = await engineA.verify()
  assert.equal(verdict.ok, true)
  assert.equal(verdict.localOnly, 0, '段里已有的写入不该算成本机独有')
  assert.ok(verdict.segments.scanned >= 1)
})
