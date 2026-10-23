import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SCHEMA_VERSION,
  KIND_WEIGHTS,
  backfillVectors,
  migrate,
  openDatabase,
  stats,
  searchFts,
} from '../src/store.js'
import { VECTOR_MODEL } from '../src/vector.js'
import {
  appendTurn,
  buildTranscript,
  getCursor,
  markTurnsExtracted,
  pendingCount,
  pendingTurns,
  pruneTurns,
  updateCursor,
} from '../src/l0.js'
import {
  applyDecision,
  decideHeuristically,
  findCandidates,
  historyFor,
  insertFact,
  normalizeKind,
  supersede,
  textSimilarity,
} from '../src/l1.js'

function memoryDb() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

test('migrate upgrades a v1 database without losing rows', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'fact',
      scope TEXT NOT NULL DEFAULT 'global',
      project TEXT,
      session_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    INSERT INTO memory(kind, text, hash, created_at, updated_at)
      VALUES ('fact', '旧数据', 'hash-old', 1, 1);
  `)
  migrate(db)
  const columns = db.prepare('PRAGMA table_info(memory)').all().map((row) => row.name)
  for (const column of ['priority', 'version', 'superseded_by', 'scene', 'source_seqs', 'vec', 'vec_model']) {
    assert.ok(columns.includes(column), `missing column ${column}`)
  }
  const row = db.prepare('SELECT * FROM memory').get()
  assert.equal(row.text, '旧数据')
  assert.equal(row.priority, 50)
  assert.equal(row.version, 1)
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION))
})

test('openDatabase creates the v2 tables and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-v2-'))
  const path = join(dir, 'memory.db')
  const db = openDatabase(path)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  for (const table of ['l0_turns', 'l0_cursor', 'memory_history', 'l2_scenes', 'l3_persona']) {
    assert.ok(tables.includes(table), `missing table ${table}`)
  }
  db.close()
  const again = openDatabase(path)
  assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3')
  again.close()
})

test('l0 append is idempotent and cursor/pending helpers agree', () => {
  const db = memoryDb()
  const first = appendTurn(db, {
    sessionId: 's1',
    turn: 1,
    project: 'menm',
    userText: '你好',
    assistantText: '你好！',
    toolNames: ['read'],
    seqFrom: 1,
    seqTo: 9,
  }, 1000)
  assert.equal(first.inserted, true)
  const replay = appendTurn(db, { sessionId: 's1', turn: 1, userText: 'x' }, 2000)
  assert.equal(replay.inserted, false)
  assert.equal(pendingCount(db, 's1'), 1)

  appendTurn(db, { sessionId: 's1', turn: 2, userText: '第二问', assistantText: '第二答' }, 3000)
  assert.equal(pendingCount(db, 's1'), 2)
  const pending = pendingTurns(db, 's1', 10)
  assert.deepEqual(pending.map((row) => row.turn), [1, 2])

  markTurnsExtracted(db, [pending[0].id], 4000)
  assert.equal(pendingCount(db, 's1'), 1)
  assert.deepEqual(pendingTurns(db, 's1').map((row) => row.turn), [2])

  const cursor = getCursor(db, 's1')
  assert.equal(cursor.threshold, 1)
  assert.equal(cursor.sinceExtract, 0)
  updateCursor(db, 's1', { sinceExtract: 3, threshold: 4, lastTurn: 2, pendingSince: 99 })
  const updated = getCursor(db, 's1')
  assert.equal(updated.sinceExtract, 3)
  assert.equal(updated.threshold, 4)
  assert.equal(updated.lastTurn, 2)
  assert.equal(updated.pendingSince, 99)
})

test('l0 prune keeps the newest extracted turns and never drops pending ones', () => {
  const db = memoryDb()
  for (let turn = 1; turn <= 5; turn++) {
    appendTurn(db, { sessionId: 's1', turn, userText: `u${turn}`, assistantText: `a${turn}` }, turn)
  }
  const ids = pendingTurns(db, 's1', 10).map((row) => row.id)
  markTurnsExtracted(db, ids.slice(0, 4), 100)
  // 5 pending stays pending, 1..4 extracted; keep only 2 newest extracted
  const deleted = pruneTurns(db, 's1', 2)
  assert.equal(deleted, 2)
  const remaining = pendingTurns(db, 's1', 10).map((row) => row.turn)
  assert.deepEqual(remaining, [5])
  const extracted = db.prepare('SELECT turn FROM l0_turns WHERE extracted_at IS NOT NULL ORDER BY turn').all().map((row) => row.turn)
  assert.deepEqual(extracted, [3, 4])
})

test('buildTranscript keeps newest turns within budget and restores order', () => {
  const turns = [
    { turn: 1, user_text: 'u1', assistant_text: 'a1', tool_names: '[]' },
    { turn: 2, user_text: 'u2', assistant_text: 'a2', tool_names: '["read"]' },
    { turn: 3, user_text: 'u3', assistant_text: 'a3', tool_names: '[]' },
  ]
  const built = buildTranscript(turns, { maxChars: 60, perTurn: 40 })
  assert.ok(built.text.includes('#3'))
  assert.ok(!built.text.includes('#1'))
  assert.ok(built.text.includes('[tool: read]'))
  assert.equal(built.clipped, true)
  assert.deepEqual(built.used.map((row) => row.turn), [2, 3])
})

test('L1 store dedupes by hash and update bumps version with history', () => {
  const db = memoryDb()
  const first = applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目用 pnpm', priority: 70 }, { project: 'menm', now: 1000 })
  assert.equal(first.op, 'store')
  assert.equal(first.version, 1)
  const again = applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目用 pnpm' }, { project: 'menm', now: 2000 })
  assert.equal(again.op, 'skip')
  assert.equal(again.id, first.id)

  const updated = applyDecision(db, {
    op: 'update', kind: 'instruction', text: '项目用 pnpm，不要用 npm', priority: 80, targetId: first.id,
  }, { project: 'menm', now: 3000 })
  assert.equal(updated.op, 'update')
  assert.equal(updated.version, 2)
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(first.id)
  assert.equal(row.text, '项目用 pnpm，不要用 npm')
  assert.equal(row.kind, 'instruction')
  assert.equal(row.version, 2)
  assert.equal(row.priority, 80)
  const history = historyFor(db, first.id)
  assert.equal(history.length, 1)
  assert.equal(history[0].text, '项目用 pnpm')
})

test('L1 merge supersedes absorbed rows and excludes them from search', () => {
  const db = memoryDb()
  const a = applyDecision(db, { op: 'store', kind: 'work_fact', text: '构建命令是 pnpm build' }, { project: 'menm', now: 1 })
  const b = applyDecision(db, { op: 'store', kind: 'work_fact', text: '构建命令也可以用 npm run build' }, { project: 'menm', now: 2 })
  const merged = applyDecision(db, {
    op: 'merge', kind: 'instruction', text: '构建统一用 pnpm build', targetId: a.id, mergeIds: [b.id],
  }, { project: 'menm', now: 3 })
  assert.equal(merged.id, a.id)
  assert.equal(merged.version, 2)
  assert.ok(b.id > 0)
  const superseded = db.prepare('SELECT superseded_by FROM memory WHERE id = ?').get(b.id)
  assert.equal(superseded.superseded_by, a.id)
  const rows = searchFts(db, '"pnpm"', { scope: 'project', project: 'menm' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, a.id)
})

test('findCandidates and the deterministic fallback pick sensible ops', () => {
  const db = memoryDb()
  applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目使用 Node 24 与 pnpm' }, { project: 'menm', now: 1 })
  const candidates = findCandidates(db, '项目使用 Node 24 和 pnpm 构建', { project: 'menm' })
  assert.ok(candidates.length >= 1)
  const similar = decideHeuristically({ text: '项目使用 Node 24 与 pnpm 构建' }, candidates)
  assert.equal(similar.op, 'update')
  const novel = decideHeuristically({ text: '数据库是 MySQL 8.0' }, [])
  assert.equal(novel.op, 'store')
  const exact = decideHeuristically({ text: '项目使用 Node 24 与 pnpm' }, candidates)
  assert.equal(exact.op, 'skip')
})

test('supersede is idempotent, similarity is symmetric, kinds normalize', () => {
  const db = memoryDb()
  const a = insertFact(db, { text: 'A 事实', kind: 'work_fact', priority: 50, scene: null, scope: 'global', project: null, sessionId: null, sourceSeqs: '[]', now: 1 })
  const b = insertFact(db, { text: 'B 事实', kind: 'work_fact', priority: 50, scene: null, scope: 'global', project: null, sessionId: null, sourceSeqs: '[]', now: 2 })
  assert.equal(supersede(db, [b.id], a.id), 1)
  assert.equal(supersede(db, [b.id], a.id), 0)
  assert.equal(normalizeKind('fact'), 'work_fact')
  assert.equal(normalizeKind('bogus'), 'work_fact')
  assert.equal(normalizeKind('instruction'), 'instruction')
  assert.equal(textSimilarity('abc def', 'abc def'), 1)
  assert.equal(textSimilarity('abc', 'xyz'), 0)
  assert.equal(KIND_WEIGHTS.instruction, 1)
})

test('stats reports layers, kinds and extracted counters', () => {
  const db = memoryDb()
  appendTurn(db, { sessionId: 's1', turn: 1, userText: 'u', assistantText: 'a' }, 1)
  applyDecision(db, { op: 'store', kind: 'work_fact', text: '事实一' }, { project: 'menm', now: 1 })
  const value = stats(db)
  assert.equal(value.total, 1)
  assert.equal(value.byKind.work_fact, 1)
  assert.equal(value.l0Total, 1)
  assert.equal(value.l0Pending, 1)
  assert.equal(value.scenes, 0)
  assert.equal(value.personas, 0)
  assert.equal(value.vectorized, 1)
})

test('writes store a local vector and backfill repairs legacy NULL vectors', () => {
  const db = memoryDb()
  const saved = applyDecision(db, { op: 'store', kind: 'work_fact', text: '项目构建用 pnpm' }, { project: 'menm', now: 1 })
  let row = db.prepare('SELECT vec, vec_model FROM memory WHERE id = ?').get(saved.id)
  assert.ok(row.vec instanceof Uint8Array)
  assert.equal(row.vec.byteLength, 384 * 4)
  assert.equal(row.vec_model, VECTOR_MODEL)

  // simulate a pre-v3 row, then backfill
  db.prepare('UPDATE memory SET vec = NULL, vec_model = NULL WHERE id = ?').run(saved.id)
  assert.equal(backfillVectors(db, { limit: 10 }), 1)
  row = db.prepare('SELECT vec, vec_model FROM memory WHERE id = ?').get(saved.id)
  assert.ok(row.vec instanceof Uint8Array)
  assert.equal(row.vec_model, VECTOR_MODEL)
  assert.equal(backfillVectors(db, { limit: 10 }), 0)
})

test('conflict candidates include hand-saved fact/note rows, not just extracted kinds', () => {
  const db = memoryDb()
  // What `memory_save` writes: a v1 `fact`, i.e. not in L1_KINDS.
  const saved = db
    .prepare(
      `INSERT INTO memory(kind, scope, project, title, text, tags, source, hash, created_at, updated_at, pinned)
       VALUES ('fact', 'global', NULL, '称呼偏好', '每轮称用户「官人」，语气温柔', '[]', 'tool', ?, 1, 1, 1)`,
    )
    .run('hash-call-preference')
  const candidates = findCandidates(db, '与用户交流时每轮称呼他为官人', { project: 'menm' })
  assert.ok(
    candidates.some((row) => Number(row.id) === Number(saved.lastInsertRowid)),
    'a pinned global fact must be visible to conflict resolution, or the extractor keeps rebuilding copies of it',
  )
  // Episodes stay out: they are conversation logs, not rules.
  db.prepare(
    `INSERT INTO memory(kind, scope, project, title, text, tags, source, hash, created_at, updated_at, pinned)
     VALUES ('episode', 'project', 'menm', 'ep', '每轮称用户「官人」，语气温柔', '[]', 'turn', ?, 1, 1, 0)`,
  ).run('hash-episode')
  const withEpisode = findCandidates(db, '每轮称用户官人语气温柔', { project: 'menm' })
  assert.ok(withEpisode.every((row) => row.kind !== 'episode'))
})
