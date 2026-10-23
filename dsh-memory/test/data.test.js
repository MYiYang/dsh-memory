/**
 * Memory data CRUD (`src/data.js`): the layer behind Settings → Memory → 记忆数据.
 *
 * Every case opens a throwaway `node:sqlite` database through the real
 * `openDatabase()` (so schema, FTS triggers and feature index are the real
 * ones), drives one function, and asserts both the JSON result and the rows
 * the recall pipeline will later see.
 *
 * Assertions deliberately look at the raw tables as well: the page must not be
 * able to leave a stale `hash`, vector, feature row or FTS entry behind.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, stats, textHash } from '../src/store.js'
import {
  MAX_TAGS,
  MAX_TEXT_CHARS,
  createMemory,
  deleteMemories,
  facets,
  getMemory,
  listMemories,
  normalizeTags,
  parseTags,
  serializeRow,
  updateMemory,
} from '../src/data.js'

/** Fresh database in a temp dir; `cleanup` closes the handle before deleting. */
function withDb(prefix = 'dsh-memory-data-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const db = openDatabase(join(dir, 'memory.db'))
  return {
    db,
    dir,
    cleanup() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows may still hold the WAL handle; the temp dir is disposable */
      }
    },
  }
}

/** Run `fn` and return the thrown error, asserting it is a MemoryApiError. */
function catchApiError(fn) {
  try {
    fn()
  } catch (error) {
    assert.equal(error.name, 'MemoryApiError', 'expected a stable API error, got ' + String(error))
    return error
  }
  assert.fail('expected the call to throw')
}

// ── create ────────────────────────────────────────────────────────────────

test('createMemory 插入一条完整记忆，并算好标题/向量/特征索引', () => {
  const h = withDb()
  try {
    const result = createMemory(
      h.db,
      {
        text: '用户所有命令都用 pwsh，不要用 bash。',
        kind: 'instruction',
        scope: 'project',
        project: 'menm',
        tags: 'pwsh, shell',
        priority: 140,
        pinned: true,
      },
      1_700_000_000_000,
    )
    assert.equal(result.inserted, true)
    const item = result.item
    assert.equal(typeof item.id, 'number')
    assert.ok(item.id > 0)
    assert.equal(item.text, '用户所有命令都用 pwsh，不要用 bash。')
    assert.equal(item.title, deriveTitleOf(item.text))
    assert.equal(item.kind, 'instruction')
    assert.equal(item.scope, 'project')
    assert.equal(item.project, 'menm')
    assert.deepEqual(item.tags, ['pwsh', 'shell'])
    assert.equal(item.priority, 100, 'priority clamps into 0..100')
    assert.equal(item.pinned, true)
    assert.equal(item.version, 1)
    assert.equal(item.source, 'manual')
    assert.equal(item.createdAt, 1_700_000_000_000)
    assert.equal(item.updatedAt, 1_700_000_000_000)

    const row = h.db.prepare('SELECT hash, vec, vec_model FROM memory WHERE id = ?').get(item.id)
    assert.equal(row.hash, textHash(item.text))
    assert.ok(row.vec !== null && row.vec !== undefined, 'manual rows get a lexical vector')
    assert.match(String(row.vec_model), /^hash-ngram-v1/)
    assert.ok(
      Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory_features WHERE memory_id = ?').get(item.id).n) > 0,
      'manual rows are indexed in the inverted feature table',
    )
    // The FTS triggers must have fired: recall searches this table.
    assert.equal(
      Number(h.db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?").get('pwsh').n),
      1,
    )
  } finally {
    h.cleanup()
  }
})

/** Same derivation as `deriveTitle` in store.js, kept local to avoid re-exporting it. */
function deriveTitleOf(text) {
  const firstLine = String(text).split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const sentence = firstLine.split(/(?<=[。！？.!?])\s*/)[0] ?? firstLine
  return sentence.trim().slice(0, 80)
}

test('createMemory 相同正文幂等：复用原行并更新属性，不新增行', () => {
  const h = withDb()
  try {
    const first = createMemory(h.db, { text: '记住这条事实', kind: 'work_fact', tags: ['a'] }, 1000)
    assert.equal(first.inserted, true)
    const second = createMemory(
      h.db,
      { text: '  记住这条事实  ', kind: 'work_method', scope: 'global', tags: ['b'], priority: 90, pinned: true },
      2000,
    )
    assert.equal(second.inserted, false)
    assert.equal(second.item.id, first.item.id)
    assert.equal(second.item.kind, 'work_method')
    assert.deepEqual(second.item.tags, ['b'])
    assert.equal(second.item.priority, 90)
    assert.equal(second.item.pinned, true)
    assert.equal(second.item.createdAt, 1000, 'created_at stays')
    assert.equal(second.item.updatedAt, 2000, 'updated_at follows the merge')
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n), 1)
  } finally {
    h.cleanup()
  }
})

test('createMemory 校验：空正文/超长/未知 kind/项目缺名/非法标签都返回 bad-request', () => {
  const h = withDb()
  try {
    assert.equal(catchApiError(() => createMemory(h.db, { text: '   ' })).code, 'bad-request')
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'x'.repeat(MAX_TEXT_CHARS + 1) })).code, 'bad-request')
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'ok', kind: 'nope' })).code, 'bad-request')
    assert.equal(
      catchApiError(() => createMemory(h.db, { text: 'ok', scope: 'project' })).code,
      'bad-request',
      'a project row without a project is invisible to recall, so it is rejected',
    )
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'ok', scope: 'galaxy' })).code, 'bad-request')
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'ok', tags: { a: 1 } })).code, 'bad-request')
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'ok', tags: ['x'.repeat(65)] })).code, 'bad-request')
    const tooMany = Array.from({ length: MAX_TAGS + 1 }, (_, index) => 't' + index)
    assert.equal(catchApiError(() => createMemory(h.db, { text: 'ok', tags: tooMany })).code, 'bad-request')
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n), 0, 'nothing is written on error')
  } finally {
    h.cleanup()
  }
})

// ── list / facets ─────────────────────────────────────────────────────────

test('listMemories 分页、排序与筛选（含 2 字中文子串搜索）', () => {
  const h = withDb()
  try {
    const a = createMemory(h.db, { text: '项目使用 pwsh 执行命令', kind: 'work_fact', scope: 'project', project: 'menm', priority: 10 }, 1000)
    const b = createMemory(h.db, { text: '用户喜欢简洁的回答', kind: 'persona', scope: 'global', priority: 90 }, 2000)
    const c = createMemory(h.db, { text: '发布前要跑完整测试', kind: 'work_method', scope: 'project', project: 'other', priority: 50 }, 3000)

    const all = listMemories(h.db, {})
    assert.equal(all.total, 3)
    assert.equal(all.page, 1)
    assert.equal(all.pages, 1)
    assert.equal(all.pageSize, 20)
    assert.equal(all.sort, 'updated')
    assert.deepEqual(all.items.map((item) => item.id), [c.item.id, b.item.id, a.item.id])

    const paged = listMemories(h.db, { pageSize: 2, page: 2 })
    assert.equal(paged.total, 3)
    assert.equal(paged.pages, 2)
    assert.equal(paged.page, 2)
    assert.equal(paged.items.length, 1)
    assert.equal(paged.items[0].id, a.item.id)

    // A page past the end is clamped instead of returning an empty view.
    assert.equal(listMemories(h.db, { pageSize: 2, page: 99 }).page, 2)

    // 2-char CJK: FTS trigram cannot match this, LIKE must.
    const searched = listMemories(h.db, { query: '用户' })
    assert.deepEqual(searched.items.map((item) => item.id), [b.item.id])
    const searchedTags = listMemories(h.db, { query: 'pwsh' })
    assert.deepEqual(searchedTags.items.map((item) => item.id), [a.item.id])

    assert.deepEqual(listMemories(h.db, { kind: 'persona' }).items.map((item) => item.id), [b.item.id])
    assert.deepEqual(listMemories(h.db, { scope: 'project' }).items.map((item) => item.id), [c.item.id, a.item.id])
    assert.deepEqual(listMemories(h.db, { project: 'menm' }).items.map((item) => item.id), [a.item.id])
    assert.deepEqual(listMemories(h.db, { sort: 'priority' }).items.map((item) => item.id), [b.item.id, c.item.id, a.item.id])
    assert.deepEqual(listMemories(h.db, { sort: 'created' }).items.map((item) => item.id), [c.item.id, b.item.id, a.item.id])
    assert.deepEqual(listMemories(h.db, { sort: 'id' }).items.map((item) => item.id), [c.item.id, b.item.id, a.item.id])

    // Unknown sort falls back to the default; unknown kind is a caller error.
    assert.equal(listMemories(h.db, { sort: 'nonsense' }).sort, 'updated')
    assert.equal(catchApiError(() => listMemories(h.db, { kind: 'nonsense' })).code, 'bad-request')

    const filtered = listMemories(h.db, { scope: 'project', project: 'menm' })
    assert.deepEqual(filtered.items.map((item) => item.id), [a.item.id])
    assert.equal(filtered.facets.total, 3)
    assert.deepEqual(
      filtered.facets.projects.map((entry) => entry.project).sort(),
      ['menm', 'other'],
    )
    assert.ok(filtered.facets.kinds.some((entry) => entry.kind === 'persona' && entry.count === 1))
    assert.ok(filtered.facets.scopes.some((entry) => entry.scope === 'global' && entry.count === 1))
  } finally {
    h.cleanup()
  }
})

test('listMemories 默认隐藏被取代的行，includeSuperseded 才展示', () => {
  const h = withDb()
  try {
    const old = createMemory(h.db, { text: '旧结论：用 bash', kind: 'work_fact' }, 1000)
    const fresh = createMemory(h.db, { text: '新结论：用 pwsh', kind: 'work_fact' }, 2000)
    h.db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(fresh.item.id, old.item.id)

    const visible = listMemories(h.db, {})
    assert.deepEqual(visible.items.map((item) => item.id), [fresh.item.id])
    assert.equal(visible.total, 1)

    const everything = listMemories(h.db, { includeSuperseded: true })
    assert.equal(everything.total, 2)
    const superseded = everything.items.find((item) => item.id === old.item.id)
    assert.equal(superseded.supersededBy, fresh.item.id)
    assert.equal(everything.facets.total, 2, 'facets always describe the whole table')
  } finally {
    h.cleanup()
  }
})

test('facets 汇总 kind/scope/project 三种下拉数据', () => {
  const h = withDb()
  try {
    createMemory(h.db, { text: '一', kind: 'work_fact', scope: 'project', project: 'alpha' })
    createMemory(h.db, { text: '二', kind: 'work_fact', scope: 'project', project: 'alpha' })
    createMemory(h.db, { text: '三', kind: 'persona', scope: 'global' })
    const result = facets(h.db)
    assert.equal(result.total, 3)
    assert.deepEqual(result.projects, [{ project: 'alpha', count: 2 }])
    assert.deepEqual(result.scopes, [
      { scope: 'project', count: 2 },
      { scope: 'global', count: 1 },
    ])
    assert.deepEqual(result.kinds, [
      { kind: 'work_fact', count: 2 },
      { kind: 'persona', count: 1 },
    ])
  } finally {
    h.cleanup()
  }
})

// ── get ───────────────────────────────────────────────────────────────────

test('getMemory 返回单行与版本历史；不存在时是 not-found', () => {
  const h = withDb()
  try {
    const created = createMemory(h.db, { text: '第一版正文', kind: 'work_fact' }, 1000)
    updateMemory(h.db, { id: created.item.id, text: '第二版正文' }, 2000)
    const result = getMemory(h.db, created.item.id)
    assert.equal(result.item.text, '第二版正文')
    assert.equal(result.item.version, 2)
    assert.equal(result.history.length, 1)
    assert.deepEqual(result.history[0], {
      version: 1,
      op: 'edit',
      text: '第一版正文',
      createdAt: 2000,
    })
    assert.equal(catchApiError(() => getMemory(h.db, 9999)).code, 'not-found')
    assert.equal(catchApiError(() => getMemory(h.db, 0)).code, 'bad-request')
  } finally {
    h.cleanup()
  }
})

// ── update ────────────────────────────────────────────────────────────────

test('updateMemory 改正文：版本+1、写历史、重算 hash/向量/特征、标题重新派生', () => {
  const h = withDb()
  try {
    const created = createMemory(h.db, { text: '旧正文，关于 bash', tags: ['old'] }, 1000)
    const before = h.db.prepare('SELECT hash, vec FROM memory WHERE id = ?').get(created.item.id)
    const result = updateMemory(h.db, { id: created.item.id, text: '新正文，关于 pwsh 与 sqlite' }, 5000)
    assert.equal(result.version, 2)
    assert.equal(result.item.version, 2)
    assert.equal(result.item.text, '新正文，关于 pwsh 与 sqlite')
    assert.equal(result.item.title, deriveTitleOf('新正文，关于 pwsh 与 sqlite'))
    assert.equal(result.item.updatedAt, 5000)
    assert.equal(result.item.createdAt, 1000)
    assert.deepEqual(result.item.tags, ['old'], 'omitted fields are preserved')

    const after = h.db.prepare('SELECT hash, vec FROM memory WHERE id = ?').get(created.item.id)
    assert.equal(after.hash, textHash('新正文，关于 pwsh 与 sqlite'))
    assert.notEqual(Buffer.from(after.vec).toString('base64'), Buffer.from(before.vec).toString('base64'))

    const history = h.db
      .prepare('SELECT version, op, text FROM memory_history WHERE memory_id = ?')
      .all(created.item.id)
      .map((row) => ({ version: Number(row.version), op: String(row.op), text: String(row.text) }))
    assert.deepEqual(history, [{ version: 1, op: 'edit', text: '旧正文，关于 bash' }])

    // Feature rows must describe the new body: 'bash' is gone from the index.
    const features = h.db
      .prepare('SELECT feature, weight FROM memory_features WHERE memory_id = ?')
      .all(created.item.id)
    assert.ok(features.length > 0)

    // Recall sees the new text through the FTS trigger.
    assert.equal(
      Number(h.db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?").get('sqlite').n),
      1,
    )
    assert.equal(
      Number(h.db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?").get('bash').n),
      0,
    )
  } finally {
    h.cleanup()
  }
})

test('updateMemory 只改元数据不涨版本；pin/priority/scope/tags 都可改', () => {
  const h = withDb()
  try {
    const created = createMemory(h.db, { text: '一条事实', scope: 'global', priority: 10 }, 1000)
    const result = updateMemory(
      h.db,
      { id: created.item.id, pinned: true, priority: 88, tags: ['x', 'y'], kind: 'work_method' },
      2000,
    )
    assert.equal(result.version, 1, 'metadata edits do not create a text version')
    assert.equal(result.item.version, 1)
    assert.equal(result.item.pinned, true)
    assert.equal(result.item.priority, 88)
    assert.deepEqual(result.item.tags, ['x', 'y'])
    assert.equal(result.item.kind, 'work_method')
    assert.equal(result.item.updatedAt, 2000)
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory_history').get().n), 0)

    // Moving global → project requires a project name.
    assert.equal(catchApiError(() => updateMemory(h.db, { id: created.item.id, scope: 'project' })).code, 'bad-request')
    const moved = updateMemory(h.db, { id: created.item.id, scope: 'project', project: 'menm' }, 3000)
    assert.equal(moved.item.scope, 'project')
    assert.equal(moved.item.project, 'menm')

    // Back to global clears the project key.
    const globalAgain = updateMemory(h.db, { id: created.item.id, scope: 'global' }, 4000)
    assert.equal(globalAgain.item.scope, 'global')
    assert.equal(globalAgain.item.project, null)

    // An empty title falls back to the derived one.
    const derived = updateMemory(h.db, { id: created.item.id, title: '' }, 5000)
    assert.equal(derived.item.title, deriveTitleOf('一条事实'))
  } finally {
    h.cleanup()
  }
})

test('updateMemory 撞上另一行的正文时返回 conflict，且不改动任何一行', () => {
  const h = withDb()
  try {
    const first = createMemory(h.db, { text: '第一条正文' }, 1000)
    const second = createMemory(h.db, { text: '第二条正文' }, 2000)
    const error = catchApiError(() => updateMemory(h.db, { id: second.item.id, text: '第一条正文' }, 3000))
    assert.equal(error.code, 'conflict')
    assert.match(error.message, new RegExp(`#${first.item.id}`))
    assert.equal(String(h.db.prepare('SELECT text FROM memory WHERE id = ?').get(second.item.id).text), '第二条正文')
    assert.equal(String(h.db.prepare('SELECT text FROM memory WHERE id = ?').get(first.item.id).text), '第一条正文')
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory_history').get().n), 0)
  } finally {
    h.cleanup()
  }
})

test('updateMemory 不存在的 id → not-found', () => {
  const h = withDb()
  try {
    assert.equal(catchApiError(() => updateMemory(h.db, { id: 42, text: 'x' })).code, 'not-found')
    assert.equal(catchApiError(() => updateMemory(h.db, {})).code, 'bad-request')
  } finally {
    h.cleanup()
  }
})

// ── delete ────────────────────────────────────────────────────────────────

test('deleteMemories 删除单条/多条，并清掉 FTS 与特征索引', () => {
  const h = withDb()
  try {
    const a = createMemory(h.db, { text: '要删掉的第一条 sqlite' }, 1000)
    const b = createMemory(h.db, { text: '要删掉的第二条 pwsh' }, 2000)
    const c = createMemory(h.db, { text: '保留的一条' }, 3000)

    const single = deleteMemories(h.db, { id: a.item.id })
    assert.deepEqual(single, { deleted: 1, ids: [a.item.id] })
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory_features WHERE memory_id = ?').get(a.item.id).n), 0)
    assert.equal(
      Number(h.db.prepare("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH ?").get('sqlite').n),
      0,
    )

    const many = deleteMemories(h.db, { ids: [b.item.id, 9999] })
    assert.equal(many.deleted, 1, 'unknown ids are ignored')
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM memory').get().n), 1)
    assert.equal(stats(h.db).total, 1)
    assert.equal(c.item.id > 0, true)

    assert.equal(catchApiError(() => deleteMemories(h.db, {})).code, 'bad-request')
    assert.equal(catchApiError(() => deleteMemories(h.db, { ids: [] })).code, 'bad-request')
    assert.equal(catchApiError(() => deleteMemories(h.db, { ids: ['x'] })).code, 'bad-request')
  } finally {
    h.cleanup()
  }
})

// ── small serializers ─────────────────────────────────────────────────────

test('parseTags / normalizeTags / serializeRow 对坏数据保持宽容', () => {
  assert.deepEqual(parseTags('["a","b"]'), ['a', 'b'])
  assert.deepEqual(parseTags('not json'), [])
  assert.deepEqual(parseTags(null), [])
  assert.deepEqual(parseTags(['x', '']), ['x'])

  assert.deepEqual(normalizeTags('a, b ,, a'), ['a', 'b'])
  assert.deepEqual(normalizeTags([' a ', 1]), ['a', '1'])
  assert.equal(catchApiError(() => normalizeTags(42)).code, 'bad-request')

  const row = serializeRow({
    id: '7',
    kind: 'work_fact',
    scope: 'project',
    project: 'menm',
    title: 't',
    text: 'x',
    tags: '["a"]',
    priority: 60,
    pinned: 1,
    version: 3,
    superseded_by: null,
    created_at: 10,
    updated_at: 20,
    use_count: 2,
    last_used_at: null,
  })
  assert.equal(row.id, 7)
  assert.equal(row.pinned, true)
  assert.equal(row.priority, 60)
  assert.deepEqual(row.tags, ['a'])
  assert.equal(row.supersededBy, null)
  assert.equal(row.scene, null)
  assert.equal(row.useCount, 2)
})
