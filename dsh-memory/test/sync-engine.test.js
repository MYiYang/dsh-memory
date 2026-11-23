/**
 * Host-side sync: segment round-trip, local remote, two-device convergence,
 * breaker trip, and the SigV4 vectors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { setSyncEnabled, getSyncMeta } from '../src/sync/schema.js'
import { encodeSegment, decodeSegment, segmentObjectKey } from '../src/sync/segment.js'
import { createRemote } from '../src/sync/remote.js'
import { createSyncEngine } from '../src/sync/engine.js'
import { createBreaker } from '../src/sync/breaker.js'
import { signRequest } from '../src/sync/s3.js'

function tempDir(prefix = 'dsh-sync-') {
  return mkdtempSync(join(tmpdir(), prefix))
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
      remote: 'local',
      local: { dir: join(dir, 'remote') },
      s3: { endpoint: '', bucket: '', region: 'us-east-1', pathStyle: true, prefix: 'v1' },
      ...overrides,
    },
  }
}

test('segment round-trips through brotli', () => {
  const ops = [
    { opId: 'd:1', tbl: 'memory', key: 'h1', op: 'upsert', lamport: 1, device: 'd', payload: { text: '甲', tags: '[]' }, createdAt: 1 },
    { opId: 'd:2', tbl: 'memory', key: 'h2', op: 'delete', lamport: 2, device: 'd', payload: { hash: 'h2' }, createdAt: 2 },
  ]
  const buf = encodeSegment({ epoch: 3, device: 'd', seq: 7, ops, now: 5 })
  const decoded = decodeSegment(buf)
  assert.equal(decoded.header.epoch, 3)
  assert.equal(decoded.header.seq, 7)
  assert.equal(decoded.header.count, 2)
  assert.equal(decoded.ops.length, 2)
  assert.equal(decoded.ops[0].key, 'h1')
  assert.deepEqual(decoded.ops[0].payload, { text: '甲', tags: '[]' })
})

test('decode rejects a foreign format version', () => {
  const buf = encodeSegment({ device: 'd', seq: 1, ops: [], now: 1 })
  buf.writeUInt8(9, 4)
  assert.throws(() => decodeSegment(buf), /newer than this build/)
})

test('local remote stores, lists and refuses to clobber on ifAbsent', async () => {
  const dir = tempDir()
  const remote = createRemote({ kind: 'local', dir })
  const key = segmentObjectKey({ prefix: 'v1', workspace: 'ws', device: 'dev', seq: 1 })
  assert.deepEqual(await remote.put(key, Buffer.from('one'), { ifAbsent: true }), { status: 200, existed: false })
  assert.deepEqual(await remote.put(key, Buffer.from('two'), { ifAbsent: true }), { status: 412, existed: true })
  assert.equal((await remote.get(key)).toString(), 'one')
  const listed = await remote.list('v1/ws/')
  assert.equal(listed.length, 1)
  assert.deepEqual(await remote.get('v1/ws/none/00000001.jsonl.br'), null)
  await remote.delete(key)
  assert.equal((await remote.list('v1/ws/')).length, 0)
})

test('two devices converge over a directory remote', async () => {
  const dir = tempDir()
  const dbA = newDb(dir, 'a')
  const dbB = newDb(dir, 'b')
  setSyncEnabled(dbA, true)
  setSyncEnabled(dbB, true)

  saveMemory(dbA, { text: '设备甲记下的一条事实', scope: 'project', project: 'demo' })
  saveMemory(dbA, { text: '设备甲记下的第二条', scope: 'project', project: 'demo' })
  saveMemory(dbB, { text: '设备乙自己的那条', scope: 'project', project: 'demo' })

  const engineA = createSyncEngine({ db: dbA, config: configFor(dir) })
  const engineB = createSyncEngine({ db: dbB, config: { ...configFor(dir), dbPath: join(dir, 'b.db') } })
  engineB.reconfigure({ ...configFor(dir).sync })

  const pushed = await engineA.syncNow()
  assert.equal(pushed.pushed, 1)
  const pulled = await engineB.syncNow()
  assert.ok(pulled.pulled >= 1, 'device B should have pulled at least one segment')

  const hashes = dbB.prepare('SELECT hash FROM memory ORDER BY hash').all().map((row) => String(row.hash))
  assert.equal(hashes.length, 3)
  const aHashes = dbA.prepare('SELECT hash FROM memory ORDER BY hash').all().map((row) => String(row.hash))
  assert.deepEqual(hashes.filter((h) => aHashes.includes(h)).length, 2)

  dbA.close()
  dbB.close()
})

test('disabled sync writes nothing and never touches the remote', async () => {
  const dir = tempDir()
  const db = newDb(dir, 'off')
  saveMemory(db, { text: '关闭状态下的一条' })
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sync_oplog').get().n), 0)
  const engine = createSyncEngine({ db, config: { ...configFor(dir), sync: { ...configFor(dir).sync, enabled: false } } })
  const result = await engine.syncNow()
  assert.equal(result.skipped, 'disabled')
  assert.equal(engine.status().enabled, false)
  db.close()
})

test('the breaker trips after repeated transport failures and backs off', () => {
  let clock = 0
  let saved = null
  const breaker = createBreaker({ threshold: 3, baseMs: 1000, maxMs: 8000, now: () => clock, save: (state) => { saved = state } })
  const netError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
  assert.equal(breaker.failure(netError).tripped, false)
  assert.equal(breaker.failure(netError).tripped, false)
  assert.equal(breaker.failure(netError).tripped, true)
  assert.equal(breaker.snapshot().state, 'open')
  assert.equal(saved.state, 'open')
  assert.equal(breaker.before().allowed, false)
  clock += 1000
  assert.equal(breaker.before().allowed, true, 'half-open after the backoff')
  breaker.failure(netError)
  assert.equal(breaker.snapshot().state, 'open')
  assert.ok(saved.backoffMs > 1000, 'a failed probe doubles the wait')
})

test('auth failures do not trip the breaker', () => {
  const breaker = createBreaker({ threshold: 2 })
  for (let i = 0; i < 5; i++) breaker.failure(Object.assign(new Error('denied'), { status: 403 }))
  assert.equal(breaker.snapshot().state, 'closed')
})

test('SigV4 matches the three official AWS vectors', () => {
  const ak = 'AKIAIOSFODNN7EXAMPLE'
  const sk = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const get = signRequest({
    method: 'GET', path: '/test.txt', headers: {
      host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
      'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z',
    }, payloadHash: empty, accessKey: ak, secretKey: sk, region: 'us-east-1', amzDate: '20130524T000000Z',
  })
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')

  const put = signRequest({
    method: 'PUT', path: '/test%24file.text', headers: {
      date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    }, payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    accessKey: ak, secretKey: sk, region: 'us-east-1', amzDate: '20130524T000000Z',
  })
  assert.equal(put.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')

  const list = signRequest({
    method: 'GET', path: '/', query: { 'max-keys': 2, prefix: 'J' }, headers: {
      host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z',
    }, payloadHash: empty, accessKey: ak, secretKey: sk, region: 'us-east-1', amzDate: '20130524T000000Z',
  })
  assert.equal(list.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
})
