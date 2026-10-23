import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openDatabase,
  forgetMemories,
  getMeta,
  saveMemory,
  searchFts,
  setMeta,
  textHash,
} from '../src/store.js'
import { extractFeatures } from '../src/vector.js'
import {
  DEFAULT_FEATURE_LIMIT,
  EMPTY_FEATURE,
  FEATURE_INDEX_MODEL,
  backfillFeatureIndex,
  candidateMemoryIds,
  ensureFeatureIndexModel,
  indexMemoryFeatures,
  topFeatures,
} from '../src/feature-index.js'

/**
 * Insert a memory row the way an import/legacy path would: no vector, no
 * feature rows, no hooks. Used to exercise the backfill.
 */
function insertRaw(db, text, options = {}) {
  const now = options.now ?? Date.now()
  const result = db
    .prepare(
      `INSERT INTO memory(kind, scope, project, title, text, tags, source, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', 'import', ?, ?, ?)`,
    )
    .run(
      options.kind ?? 'fact',
      options.scope ?? 'global',
      options.project ?? null,
      String(text).slice(0, 40),
      String(text),
      textHash(text),
      now,
      now,
    )
  return Number(result.lastInsertRowid)
}

/** Stored feature rows of one memory, ordered by hash for stable comparisons. */
function featureRows(db, memoryId) {
  return db.prepare('SELECT feature, weight FROM memory_features WHERE memory_id = ? ORDER BY feature').all(memoryId)
}

test('topFeatures is deterministic, weight-sorted and capped', () => {
  const text = 'pnpm 构建 build 部署 构建 构建'
  const first = topFeatures(text)
  assert.deepEqual(first, topFeatures(text), 'the same text must always store the same set')
  assert.ok(first.length > 0)
  assert.ok(first.length <= DEFAULT_FEATURE_LIMIT)
  for (let i = 1; i < first.length; i++) assert.ok(first[i - 1].weight >= first[i].weight, 'weight desc')
  assert.equal(new Set(first.map((entry) => entry.feature)).size, first.length, 'features are unique')
  const repeated = first.find((entry) => entry.feature === 'c:构建')
  assert.ok(repeated, 'a 2-char CJK gram is a feature')
  assert.ok(repeated.weight > 1, 'repeated features get 1 + ln(count)')
  assert.deepEqual(topFeatures('', 5), [])
  assert.equal(topFeatures(text, 3).length, 3)
})

test('the stored feature set is capped at the model limit', () => {
  // One long CJK run yields ~3n character n-grams, far above the cap.
  const longRun =
    '部署流程检查构建编译测试发布回滚监控告警日志追踪链路压测容量规划备份恢复演练故障注入复盘改进验收交付上线灰度蓝绿金丝雀探针熔断降级限流排队超时重试幂等事务隔离索引分片副本选举一致性快照增量全量校验对账'
  assert.ok(extractFeatures(longRun).size > DEFAULT_FEATURE_LIMIT, 'the raw feature count exceeds the cap')
  assert.equal(topFeatures(longRun).length, DEFAULT_FEATURE_LIMIT)
  assert.equal(topFeatures(longRun, 5).length, 5)
})

test('candidateMemoryIds nominates rows that share a rare 2-char CJK feature', () => {
  const db = openDatabase(':memory:')
  const hit = saveMemory(db, { text: '部署流程要先跑 dry-run 校验', scope: 'global' })
  saveMemory(db, { text: '数据库端口是 3306', scope: 'global' })
  assert.deepEqual(candidateMemoryIds(db, '部署前还要复查', { scope: 'all' }), [hit.id])
  // A featureLimit above the probe cap is clamped, not an error.
  assert.deepEqual(candidateMemoryIds(db, '部署前还要复查', { scope: 'all', featureLimit: DEFAULT_FEATURE_LIMIT * 4 }), [
    hit.id,
  ])
  db.close()
})

test('the rarest shared feature wins when the probe is limited', () => {
  const db = openDatabase(':memory:')
  // three rows share 部署, only one shares 探针
  saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  saveMemory(db, { text: '部署脚本先 dry-run', scope: 'global' })
  saveMemory(db, { text: '部署前先备份', scope: 'global' })
  const rare = saveMemory(db, { text: '探针健康检查端点', scope: 'global' })
  assert.deepEqual(candidateMemoryIds(db, '部署探针', { scope: 'all', maxFeatures: 1 }), [rare.id])
  assert.equal(candidateMemoryIds(db, '部署探针', { scope: 'all', maxFeatures: 12 }).length, 4)
  db.close()
})

test('candidateMemoryIds honours global/project visibility and kinds', () => {
  const db = openDatabase(':memory:')
  const global = saveMemory(db, { text: '部署前必须 dry-run 校验', scope: 'global' })
  const alpha = saveMemory(db, { text: 'alpha 部署用 dry-run', scope: 'project', project: 'alpha' })
  saveMemory(db, { text: 'beta 部署用 dry-run', scope: 'project', project: 'beta' })

  const forAlpha = candidateMemoryIds(db, '部署 dry-run', { scope: 'project', project: 'alpha' })
  assert.ok(forAlpha.includes(global.id), 'global rows are always visible')
  assert.ok(forAlpha.includes(alpha.id), 'own project rows are visible')
  assert.ok(!forAlpha.some((id) => id !== global.id && id !== alpha.id), 'other projects stay hidden')

  assert.deepEqual(candidateMemoryIds(db, '部署 dry-run', { scope: 'project', project: null }), [global.id])
  assert.deepEqual(candidateMemoryIds(db, '部署 dry-run', { scope: 'global' }), [global.id])
  assert.equal(candidateMemoryIds(db, '部署 dry-run', { scope: 'all' }).length, 3)
  assert.deepEqual(candidateMemoryIds(db, '部署 dry-run', { scope: 'all', kinds: ['episode'] }), [])
  db.close()
})

test('candidateMemoryIds skips superseded rows', () => {
  const db = openDatabase(':memory:')
  const keep = saveMemory(db, { text: '部署前必须 dry-run 校验', scope: 'global' })
  const dead = saveMemory(db, { text: '部署前直接上线', scope: 'global' })
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(keep.id, dead.id)
  assert.deepEqual(candidateMemoryIds(db, '部署前', { scope: 'all' }), [keep.id])
  db.close()
})

test('forgetMemories removes the feature rows through the delete trigger', () => {
  const db = openDatabase(':memory:')
  const saved = saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  assert.ok(featureRows(db, saved.id).length > 0, 'a save indexes its features')
  assert.equal(forgetMemories(db, { ids: [saved.id] }), 1)
  assert.deepEqual(featureRows(db, saved.id), [], 'no orphaned feature rows')
  db.close()
})

test('indexMemoryFeatures replaces the previous feature set', () => {
  const db = openDatabase(':memory:')
  const saved = saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  const before = featureRows(db, saved.id).map((row) => Number(row.feature))
  indexMemoryFeatures(db, saved.id, '完全不同的主题 烹饪 菜谱')
  const after = featureRows(db, saved.id).map((row) => Number(row.feature))
  assert.notDeepEqual(after, before)
  assert.deepEqual(candidateMemoryIds(db, '部署', { scope: 'all' }), [], 'stale features are gone')
  assert.deepEqual(candidateMemoryIds(db, '烹饪', { scope: 'all' }), [saved.id], 'new features are live')
  db.close()
})

test('indexing never rewrites the memory row (no FTS trigger, no updated_at bump)', () => {
  const db = openDatabase(':memory:')
  const saved = saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  const before = db.prepare('SELECT updated_at FROM memory WHERE id = ?').get(saved.id)
  indexMemoryFeatures(db, saved.id, '部署流程用 pnpm')
  const after = db.prepare('SELECT updated_at FROM memory WHERE id = ?').get(saved.id)
  assert.deepEqual(after, before)
  assert.equal(searchFts(db, '"部署流程"').length, 1, 'FTS still holds exactly one row')
  db.close()
})

test('backfillFeatureIndex indexes rows written without the maintenance hooks', () => {
  const db = openDatabase(':memory:')
  const legacy = insertRaw(db, '部署流程要先跑 dry-run')
  const other = insertRaw(db, '数据库端口是 3306')
  assert.deepEqual(featureRows(db, legacy), [], 'a raw insert leaves no feature rows')
  assert.equal(backfillFeatureIndex(db, { limit: 10 }), 2)
  assert.ok(featureRows(db, legacy).length > 0)
  assert.ok(featureRows(db, other).length > 0)
  assert.deepEqual(candidateMemoryIds(db, '部署', { scope: 'all' }), [legacy])
  assert.equal(backfillFeatureIndex(db, { limit: 10 }), 0, 'a second pass has nothing left to do')
  db.close()
})

test('a corpus-common feature is skipped instead of nominating everything', () => {
  const db = openDatabase(':memory:')
  // 300 rows share 部署 (above MAX_DOCUMENT_FREQUENCY), one shares 叵测.
  db.exec('BEGIN')
  for (let i = 0; i < 300; i++) insertRaw(db, `部署细节 ${i}`)
  db.exec('COMMIT')
  const rare = insertRaw(db, '叵测连接池口径')
  assert.equal(backfillFeatureIndex(db, { limit: 1000 }), 301)
  // The common gram must not fill the candidate list with the whole corpus; the
  // rare shared gram is the only thing that discriminates here.
  assert.deepEqual(candidateMemoryIds(db, '部署叵测', { scope: 'all' }), [rare])
  db.close()
})

test('a row with no indexable feature stores a sentinel instead of being retried', () => {
  const db = openDatabase(':memory:')
  const bare = insertRaw(db, 'A')
  assert.equal(backfillFeatureIndex(db, { limit: 10 }), 1)
  const rows = featureRows(db, bare)
  assert.equal(rows.length, 1)
  assert.equal(Number(rows[0].feature), EMPTY_FEATURE)
  assert.equal(backfillFeatureIndex(db, { limit: 10 }), 0, 'the sentinel stops the backfill from looping')
  assert.deepEqual(candidateMemoryIds(db, 'A', { scope: 'all' }), [], 'a sentinel is never a candidate')
  db.close()
})

test('a feature model change clears the index and the meta tag records it', () => {
  const db = openDatabase(':memory:')
  const saved = saveMemory(db, { text: '部署流程用 pnpm', scope: 'global' })
  assert.equal(getMeta(db, 'feature-index-model'), FEATURE_INDEX_MODEL)
  assert.equal(ensureFeatureIndexModel(db), false, 'a matching model is a no-op')
  assert.ok(featureRows(db, saved.id).length > 0, 'the no-op must not drop rows')

  setMeta(db, 'feature-index-model', 'feat-hash-v0-8')
  assert.equal(ensureFeatureIndexModel(db), true)
  assert.deepEqual(featureRows(db, saved.id), [], 'stale-model rows are discarded')
  assert.equal(getMeta(db, 'feature-index-model'), FEATURE_INDEX_MODEL)
  assert.equal(backfillFeatureIndex(db, { limit: 10 }), 1, 'the backfill rebuilds the cleared index')
  assert.ok(featureRows(db, saved.id).length > 0)
  db.close()
})
