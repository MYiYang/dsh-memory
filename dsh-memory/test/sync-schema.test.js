/**
 * v6 capture: the oplog triggers must record truth changes and nothing else.
 *
 * The behaviour that matters most here is the negative one — `touchMemories`
 * bumps `use_count`/`last_used_at` on every recall, and logging those would
 * generate sync traffic on every single turn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory, forgetMemories, touchMemories } from '../src/store.js'
import {
  SYNC_TABLES,
  SYNC_TRIGGERS,
  dropSyncSchema,
  ensureSyncSchema,
  getSyncMeta,
  setSyncEnabled,
  withoutCapture,
} from '../src/sync/schema.js'
import { sceneKey, l0Key, personaKey, historyKey, parseKey } from '../src/sync/keys.js'

/** @returns {import('node:sqlite').DatabaseSync} */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-schema-'))
  return openDatabase(join(dir, 'memory.db'))
}

/** @param {import('node:sqlite').DatabaseSync} db */
function oplog(db) {
  return db.prepare('SELECT * FROM sync_oplog ORDER BY seq').all()
}

/** @param {import('node:sqlite').DatabaseSync} db */
function names(db, type) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type).map((row) => row.name)
}

test('v6 creates every sync table and trigger', () => {
  const db = freshDb()
  const tables = names(db, 'table')
  for (const table of SYNC_TABLES) assert.ok(tables.includes(table), `missing table ${table}`)
  const triggers = names(db, 'trigger')
  for (const trigger of SYNC_TRIGGERS) assert.ok(triggers.includes(trigger), `missing trigger ${trigger}`)
  db.close()
})

test('the device id is stable across re-opens and migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-device-'))
  const path = join(dir, 'memory.db')
  const first = openDatabase(path)
  const device = getSyncMeta(first, 'device')
  assert.match(device, /^[0-9a-f-]{36}$/)
  ensureSyncSchema(first)
  assert.equal(getSyncMeta(first, 'device'), device)
  first.close()

  const again = openDatabase(path)
  assert.equal(getSyncMeta(again, 'device'), device)
  again.close()
})

test('capture is off until enabled, and off again after disabling', () => {
  const db = freshDb()
  saveMemory(db, { text: '同步关闭时不应留下日志' })
  assert.equal(oplog(db).length, 0)

  setSyncEnabled(db, true)
  saveMemory(db, { text: '同步开启后应当记一条' })
  const rows = oplog(db)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tbl, 'memory')
  assert.equal(rows[0].op, 'upsert')
  assert.match(String(rows[0].op_id), /^[0-9a-f-]{36}:1$/)

  setSyncEnabled(db, false)
  saveMemory(db, { text: '关闭以后不再记' })
  assert.equal(oplog(db).length, 1)
  db.close()
})

test('the payload carries truth columns only', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  const { id } = saveMemory(db, {
    text: '负载只应包含真相列',
    kind: 'work_fact',
    scope: 'project',
    project: 'demo',
    tags: ['a', 'b'],
    pinned: true,
  })
  const [row] = oplog(db)
  const payload = JSON.parse(String(row.payload))
  for (const key of ['kind', 'scope', 'project', 'title', 'text', 'tags', 'source', 'priority', 'pinned', 'created_at']) {
    assert.ok(key in payload, `payload missing ${key}`)
  }
  for (const forbidden of ['use_count', 'last_used_at', 'vec', 'vec_model']) {
    assert.ok(!(forbidden in payload), `payload must not carry ${forbidden}`)
  }
  assert.equal(payload.scope, 'project')
  assert.equal(payload.project, 'demo')
  assert.equal(payload.pinned, 1)
  assert.equal(String(row.row_key), String(payload.text ? row.row_key : ''))
  assert.equal(Number(row.lamport), 1)

  // Usage bookkeeping is a per-device statistic, never a synced fact.
  touchMemories(db, [id])
  touchMemories(db, [id])
  assert.equal(oplog(db).length, 1)
  db.close()
})

test('editing a truth column logs an upsert, touching does not', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  const { id } = saveMemory(db, { text: '原始正文' })
  assert.equal(oplog(db).length, 1)

  db.prepare('UPDATE memory SET priority = 90 WHERE id = ?').run(id)
  assert.equal(oplog(db).length, 2)
  const second = JSON.parse(String(oplog(db)[1].payload))
  assert.equal(second.priority, 90)

  db.prepare('UPDATE memory SET use_count = use_count + 5, last_used_at = ? WHERE id = ?').run(Date.now(), id)
  assert.equal(oplog(db).length, 2, 'usage columns must not log')
  db.close()
})

test('supersede logs the target hash, delete logs a tombstone', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  const target = saveMemory(db, { text: '被取代的那条' })
  const source = saveMemory(db, { text: '取代别人的那条' })
  db.prepare('UPDATE memory SET superseded_by = ?, updated_at = ? WHERE id = ?')
    .run(target.id, Date.now(), source.id)

  const rows = oplog(db)
  const superseded = rows.find((row) => row.op_id.endsWith(':' + rows[rows.length - 1].lamport))
  assert.ok(superseded, 'missing the supersede update')
  const payload = JSON.parse(String(superseded.payload))
  const targetHash = db.prepare('SELECT hash FROM memory WHERE id = ?').get(target.id).hash
  assert.equal(payload.superseded_by_hash, targetHash)

  forgetMemories(db, { ids: [target.id] })
  const deleteRow = oplog(db).find((row) => row.op === 'delete')
  assert.ok(deleteRow, 'delete did not log a tombstone')
  assert.equal(JSON.parse(String(deleteRow.payload)).hash, targetHash)
  db.close()
})

test('withoutCapture suppresses logging even when enabled', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  withoutCapture(db, () => {
    saveMemory(db, { text: '应用远端时写的行' })
  })
  assert.equal(oplog(db).length, 0)
  assert.equal(getSyncMeta(db, 'applying'), '0')
  db.close()
})

test('withoutCapture restores the flag when the callback throws', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  assert.throws(() => withoutCapture(db, () => { throw new Error('boom') }))
  assert.equal(getSyncMeta(db, 'applying'), '0')
  saveMemory(db, { text: '之后仍应正常记账' })
  assert.equal(oplog(db).length, 1)
  db.close()
})

test('dropSyncSchema removes only what it added', () => {
  const db = freshDb()
  setSyncEnabled(db, true)
  saveMemory(db, { text: '删表之前写的一条' })
  dropSyncSchema(db)
  const tables = names(db, 'table')
  for (const table of SYNC_TABLES) assert.ok(!tables.includes(table), `table ${table} survived`)
  assert.equal(names(db, 'trigger').filter((name) => name.startsWith('sync_')).length, 0)
  // Existing tables are untouched and still usable.
  saveMemory(db, { text: '删表之后仍可写' })
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get().n), 2)
  db.close()
})

test('row keys round-trip', () => {
  assert.equal(l0Key({ session_id: 's1', turn: 3 }), 's1#3')
  assert.deepEqual(parseKey('l0_turns', 's1#3'), { session: 's1', turn: 3 })
  assert.equal(sceneKey({ scope: 'project', project: null, name: 'a|b' }), 'project||a|b')
  assert.deepEqual(parseKey('l2_scenes', 'project||a|b'), { scope: 'project', project: '', name: 'a|b' })
  assert.equal(personaKey({ scope: 'global', project: null }), 'global|')
  assert.deepEqual(parseKey('l3_persona', 'global|'), { scope: 'global', project: '' })
  assert.equal(historyKey('abc', 4), 'abc#4')
  assert.deepEqual(parseKey('memory_history', 'abc#4'), { hash: 'abc', version: 4 })
})

test('老库（schema 2）再开一次即补上键变更触发器，版本号抬到 4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-migrate-'))
  const path = join(dir, 'memory.db')
  const first = openDatabase(path)
  // 回到上一版的样子：没有 _ak 触发器，schema 记作 2
  for (const name of ['sync_memory_ak', 'sync_scene_ak', 'sync_persona_ak']) first.exec(`DROP TRIGGER IF EXISTS ${name}`)
  first.prepare("UPDATE sync_meta SET value = '2' WHERE key = 'schema'").run()
  first.close()

  const reopened = openDatabase(path)
  assert.equal(getSyncMeta(reopened, 'schema'), '4')
  const names = reopened
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%'")
    .all()
    .map((row) => String(row.name))
  for (const expected of SYNC_TRIGGERS) assert.ok(names.includes(expected), `迁移后缺少触发器 ${expected}`)
  reopened.close()
})
