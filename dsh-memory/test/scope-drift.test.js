import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { applyDecision } from '../src/l1.js'

const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), 'dsh-memory-scope-')), 'memory.db'))

test('update keeps a global row global (no demotion into the editing project)', () => {
  const db = fresh()
  const now = Date.now()
  const saved = saveMemory(db, { text: '每轮称用户「官人」，语气温柔', kind: 'fact', scope: 'global', pinned: true }, now)

  applyDecision(
    db,
    { op: 'update', targetId: saved.id, text: '每轮称用户「官人」，自称「妾身」，语气温柔', kind: 'fact', priority: 60 },
    { project: 'menm', now },
  )

  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(saved.id)
  assert.equal(row.scope, 'global', 'a global rule stays global')
  assert.equal(row.project, null)
  assert.equal(row.pinned, 1, 'pinning survives a rewrite')
  assert.equal(row.version, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_history WHERE memory_id = ?').get(saved.id).n, 1)
  // Still visible from another project: that is the whole point of global.
  const visible = db.prepare("SELECT id FROM memory WHERE id = ? AND (scope = 'global' OR project = ?)").get(saved.id, 'dsh')
  assert.ok(visible !== undefined)
  db.close()
})

test('merge keeps the target scope and a project row is not promoted by a keyless session', () => {
  const db = fresh()
  const now = Date.now()
  const globalTarget = saveMemory(db, { text: '发布策略：只发 GitHub Release', kind: 'instruction', scope: 'global' }, now)
  applyDecision(
    db,
    { op: 'merge', targetId: globalTarget.id, mergeIds: [], text: '发布策略：只发 GitHub Release，不发 npm', kind: 'instruction', priority: 90 },
    { project: 'dsh', now },
  )
  const merged = db.prepare('SELECT * FROM memory WHERE id = ?').get(globalTarget.id)
  assert.equal(merged.scope, 'global')
  assert.equal(merged.project, null)

  const local = saveMemory(db, { text: '端口是 3000', kind: 'work_fact', scope: 'project', project: 'menm' }, now)
  applyDecision(db, { op: 'update', targetId: local.id, text: '端口是 3001', kind: 'work_fact', priority: 60 }, { project: null, now })
  const kept = db.prepare('SELECT * FROM memory WHERE id = ?').get(local.id)
  assert.equal(kept.scope, 'project', 'a keyless session must not promote a project fact')
  assert.equal(kept.project, 'menm')

  // An explicit scope in the decision is still honoured (deliberate promotion).
  applyDecision(
    db,
    { op: 'update', scope: 'global', targetId: local.id, text: '端口是 3002', kind: 'work_fact', priority: 60 },
    { project: 'menm', now },
  )
  const promoted = db.prepare('SELECT * FROM memory WHERE id = ?').get(local.id)
  assert.equal(promoted.scope, 'global')
  assert.equal(promoted.project, null)
  db.close()
})

test('a project row without a project key is stored as global instead of becoming a ghost', () => {
  const db = fresh()
  const ghost = saveMemory(db, { text: '发布流程走 GitHub Release', kind: 'fact', scope: 'project', project: null }, Date.now())
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(ghost.id)
  assert.equal(row.scope, 'global')
  assert.equal(row.project, null)
  db.close()
})

test('an extractor-declared global preference lands in the global layer', () => {
  const db = fresh()
  const now = Date.now()
  const result = applyDecision(
    db,
    { op: 'store', kind: 'persona', text: '每轮称用户「官人」，语气温柔', priority: 95, scope: 'global' },
    { project: 'menm', now },
  )
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(result.id)
  assert.equal(row.scope, 'global', 'a cross-project preference must not be trapped in one project')
  assert.equal(row.project, null)

  // Without the flag the same fact stays project-scoped (that is the default).
  const local = applyDecision(db, { op: 'store', kind: 'persona', text: '本项目偏好在提交前跑测试', priority: 90 }, { project: 'menm', now })
  const localRow = db.prepare('SELECT * FROM memory WHERE id = ?').get(local.id)
  assert.equal(localRow.scope, 'project')
  assert.equal(localRow.project, 'menm')
  db.close()
})
