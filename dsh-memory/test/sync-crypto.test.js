/**
 * 端到端加密：密钥可见、默认生成、密钥不上云、无钥即读不出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { createCrypto, generateKey, parseKey, KEY_BYTES } from '../src/sync/crypto.js'
import { encodeSegment, decodeSegment } from '../src/sync/segment.js'
import { getSyncMeta, setSyncEnabled } from '../src/sync/schema.js'
import { createSyncEngine } from '../src/sync/engine.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-crypto-'))
const newDb = (dir, name) => openDatabase(join(dir, `${name}.db`))
const configFor = (dir, overrides = {}) => ({
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
})

test('密钥：默认生成 32 字节 Base64，坏键判空', () => {
  const key = generateKey()
  assert.equal(Buffer.from(key, 'base64').length, KEY_BYTES)
  assert.equal(parseKey(key)?.length, KEY_BYTES)
  assert.equal(parseKey(''), null)
  assert.equal(parseKey('short'), null)
  assert.equal(generateKey() === generateKey(), false)
})

test('段：同一把钥匙能解，换钥匙解不开，且密文里搜不到正文', () => {
  const key = generateKey()
  const crypto = createCrypto(key)
  const ops = [{ opId: 'd:1', tbl: 'memory', key: 'h1', op: 'upsert', lamport: 1, device: 'd', payload: { text: '这段正文不该出现在对象里' }, createdAt: 1 }]
  const sealed = encodeSegment({ device: 'd', seq: 1, ops, now: 1, crypto })
  const opened = decodeSegment(sealed, { crypto })
  assert.equal(opened.header.enc, 'aes-256-gcm')
  assert.equal(opened.ops[0].payload.text, '这段正文不该出现在对象里')
  assert.equal(sealed.includes(Buffer.from('这段正文不该出现在对象里')), false, '明文不得出现在对象字节里')
  assert.throws(() => decodeSegment(sealed, { crypto: createCrypto(generateKey()) }), /decrypt/)
  assert.throws(() => decodeSegment(sealed), /encrypted|decrypt/)
})

test('同步：开了加密，桶里只有密文，带钥匙的设备能读、不带钥匙读不出', async () => {
  const dir = tempDir()
  const key = generateKey()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '加密传输的一条事实' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  await engineA.syncNow()

  const objects = readdirSync(join(dir, 'remote', 'v1', 'ws'), { recursive: true })
    .filter((name) => String(name).endsWith('.jsonl.br'))
  assert.ok(objects.length >= 1)
  for (const name of objects) {
    const bytes = readFileSync(join(dir, 'remote', 'v1', 'ws', String(name)))
    assert.equal(bytes.includes(Buffer.from('加密传输的一条事实')), false, `${name} 不该含明文`)
  }

  // 同一把钥匙：读得出
  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  const pulled = await engineB.syncNow()
  assert.ok(
    Number(pulled.applied ?? 0) + Number(pulled.bootstrap?.applied ?? 0) >= 1,
    '带钥匙的设备必须能读到内容',
  )
  assert.equal(b.prepare('SELECT COUNT(*) n FROM memory').get().n, 1)

  // 没有钥匙：不落地，且报错
  const c = newDb(dir, 'c')
  const engineC = createSyncEngine({ db: c, config: configFor(dir, { encrypt: true }) })
  const failed = await engineC.syncNow()
  assert.ok(failed.error !== undefined || failed.bootstrapError !== undefined || failed.encryptionRequired === true)
  assert.equal(c.prepare('SELECT COUNT(*) n FROM memory').get().n, 0)
})

test('快照：加密后分片与 manifest 都不含明文，带钥匙可引导', async () => {
  const dir = tempDir()
  const key = generateKey()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '快照里的机密正文' }, 1)
  const engineA = createSyncEngine({ db: a, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  const published = await engineA.publishSnapshot()
  assert.equal(published.published, true)

  for (const name of readdirSync(join(dir, 'remote', 'v1', 'ws', 'snapshot'), { recursive: true })) {
    const full = join(dir, 'remote', 'v1', 'ws', 'snapshot', String(name))
    let bytes
    try {
      bytes = readFileSync(full)
    } catch {
      continue
    }
    assert.equal(bytes.includes(Buffer.from('快照里的机密正文')), false, `${name} 不该含明文`)
  }

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  const pulled = await engineB.syncNow()
  assert.equal(pulled.bootstrap?.mismatch ?? '', '')
  assert.equal(b.prepare('SELECT text FROM memory').get().text, '快照里的机密正文')
  assert.equal(engineB.status().encryption.active, true)
})

test('明文与密文混在一个桶里也能读（老对象不因开关加密而作废）', async () => {
  const dir = tempDir()
  const a = newDb(dir, 'a')
  setSyncEnabled(a, true)
  saveMemory(a, { text: '加密之前推送的' }, 1)
  const plain = createSyncEngine({ db: a, config: configFor(dir, { encrypt: false }) })
  await plain.syncNow()

  const key = generateKey()
  saveMemory(a, { text: '加密之后推送的' }, 2)
  const sealed = createSyncEngine({ db: a, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  await sealed.syncNow()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  const pulled = await engineB.syncNow()
  assert.ok(Number(pulled.applied ?? 0) + Number(pulled.bootstrap?.applied ?? 0) >= 1)
  assert.equal(b.prepare('SELECT COUNT(*) n FROM memory').get().n, 2, '明文与密文两条都要到位')
})

test('没有钥匙的设备：宁可报错，也不许回退去吃旧明文快照', async () => {
  const dir = tempDir()
  const key = generateKey()
  const a = newDb(dir, 'a')
  saveMemory(a, { text: '先以明文发布的一条' }, 1)
  // 第一份：明文快照
  const plain = createSyncEngine({ db: a, config: configFor(dir, { encrypt: false }) })
  await plain.publishSnapshot()
  // 第二份：加密快照（更新时间戳保证它是最新）
  saveMemory(a, { text: '后来加密发布的一条' }, 2)
  const sealed = createSyncEngine({ db: a, config: configFor(dir, { encrypt: true, encryptKey: key }) })
  await sealed.publishSnapshot()

  const b = newDb(dir, 'b')
  const engineB = createSyncEngine({ db: b, config: configFor(dir, { encrypt: true }) })
  const result = await engineB.syncNow()
  assert.equal(result.encryptionRequired, true, '应明确报「缺密钥」')
  assert.equal(b.prepare('SELECT COUNT(*) n FROM memory').get().n, 0, '不得拿旧明文快照冒充真相')
  assert.notEqual(String(getSyncMeta(b, 'bootstrapped')), '1')
})
