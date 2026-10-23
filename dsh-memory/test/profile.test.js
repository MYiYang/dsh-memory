import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, saveMemory } from '../src/store.js'
import {
  effectiveHeat,
  getPersona,
  listPersonas,
  listScenes,
  pruneScenes,
  putPersona,
  sceneNavigation,
  touchScenes,
  upsertScene,
} from '../src/profile.js'

function db() {
  const value = new DatabaseSync(':memory:')
  migrate(value)
  return value
}

test('effectiveHeat halves at the half-life and never grows with age', () => {
  const now = 100 * 86_400_000
  assert.equal(effectiveHeat(4, now, now, 14), 4)
  assert.ok(Math.abs(effectiveHeat(4, now - 14 * 86_400_000, now, 14) - 2) < 1e-9)
  assert.ok(effectiveHeat(4, now - 60 * 86_400_000, now, 14) < 1)
})

test('upsertScene creates then updates without duplicating, heat accumulates', () => {
  const store = db()
  const id = upsertScene(store, { scope: 'project', project: 'menm', name: '工具链', summary: 'pnpm', now: 1 })
  const same = upsertScene(store, { scope: 'project', project: 'menm', name: '工具链', body: '用 pnpm build', factCount: 3, heatDelta: 2, now: 2 })
  assert.equal(id, same)
  const rows = listScenes(store, { project: 'menm', now: 2 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, 'pnpm')
  assert.equal(rows[0].body, '用 pnpm build')
  assert.equal(rows[0].heat, 3)
  assert.equal(rows[0].fact_count, 3)
})

test('scenes are scoped by project and sorted by decayed heat', () => {
  const store = db()
  upsertScene(store, { scope: 'project', project: 'menm', name: '热', heatDelta: 5, now: 1 })
  upsertScene(store, { scope: 'project', project: 'other', name: '别的项目', heatDelta: 9, now: 1 })
  upsertScene(store, { scope: 'global', project: null, name: '全局', summary: '通用', now: 1 })
  const now = 1 + 30 * 86_400_000
  const rows = listScenes(store, { project: 'menm', now, halfLifeDays: 14 })
  const names = rows.map((row) => row.name)
  assert.ok(names.includes('热'))
  assert.ok(names.includes('全局'))
  assert.ok(!names.includes('别的项目'))
  assert.equal(rows[0].name, '热')
})

test('touchScenes raises heat only for the project rows', () => {
  const store = db()
  upsertScene(store, { scope: 'project', project: 'menm', name: '工具链', now: 1 })
  upsertScene(store, { scope: 'project', project: 'other', name: '工具链', now: 1 })
  const touched = touchScenes(store, ['工具链', '工具链', '缺失'], { project: 'menm', now: 2 })
  assert.equal(touched, 1)
  const mine = listScenes(store, { project: 'menm', now: 2 }).find((row) => row.name === '工具链')
  const other = listScenes(store, { project: 'other', now: 2 }).find((row) => row.name === '工具链')
  assert.equal(mine.heat, 2)
  assert.equal(other.heat, 1)
})

test('sceneNavigation respects the character budget', () => {
  const store = db()
  upsertScene(store, { scope: 'project', project: 'menm', name: 'A', summary: 'a'.repeat(60), now: 1 })
  upsertScene(store, { scope: 'project', project: 'menm', name: 'B', summary: 'b'.repeat(60), now: 1 })
  const lines = sceneNavigation(store, { project: 'menm', now: 1, maxChars: 100 })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^- A/)
})

test('persona insert and rewrite bump version; listPersonas puts project first', () => {
  const store = db()
  const first = putPersona(store, { scope: 'project', project: 'menm', body: '项目约定：pnpm', now: 1 })
  assert.equal(first.version, 1)
  const second = putPersona(store, { scope: 'project', project: 'menm', body: '项目约定：pnpm + node 24', now: 2 })
  assert.equal(second.version, 2)
  putPersona(store, { scope: 'global', project: null, body: '偏好中文', now: 1 })
  const rows = listPersonas(store, { project: 'menm' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].scope, 'project')
  assert.equal(rows[1].scope, 'global')
  assert.equal(getPersona(store, { scope: 'project', project: 'menm' }).version, 2)
  assert.equal(getPersona(store, { scope: 'global' }).body, '偏好中文')
})

test('pruneScenes keeps the top maxScenes by decayed heat, not raw heat', () => {
  const store = db()
  const now = 100 * 86_400_000
  upsertScene(store, { scope: 'project', project: 'menm', name: '热场景', heatDelta: 9, now })
  // Raw heat 4 beats 温场景's 2, but 60 days of decay drops it to ~0.2.
  upsertScene(store, { scope: 'project', project: 'menm', name: '冷场景', heatDelta: 3, now: now - 60 * 86_400_000 })
  upsertScene(store, { scope: 'project', project: 'menm', name: '温场景', heatDelta: 1, now })
  const result = pruneScenes(store, { maxScenes: 2, project: 'menm', now })
  assert.deepEqual(result, { deleted: 1, kept: 2, protected: [], removed: ['冷场景'] })
  const names = listScenes(store, { project: 'menm', now }).map((row) => row.name)
  assert.deepEqual(names.sort(), ['温场景', '热场景'].sort())
})

test('pruneScenes keeps a cold scene the project or global persona still references', () => {
  const store = db()
  const now = 100 * 86_400_000
  upsertScene(store, { scope: 'project', project: 'menm', name: '热场景', heatDelta: 9, now })
  upsertScene(store, { scope: 'project', project: 'menm', name: '温场景', heatDelta: 1, now })
  upsertScene(store, { scope: 'project', project: 'menm', name: '冷场景', now: now - 60 * 86_400_000 })
  upsertScene(store, { scope: 'global', project: null, name: '全局热', heatDelta: 4, now })
  upsertScene(store, { scope: 'global', project: null, name: '全局中', heatDelta: 2, now })
  upsertScene(store, { scope: 'global', project: null, name: '全局冷', now: now - 60 * 86_400_000 })
  putPersona(store, { scope: 'project', project: 'menm', body: '## 项目约定\n- 详见「冷场景」', now })
  putPersona(store, { scope: 'global', body: '## 环境与工具\n- 参考全局冷', now })
  const result = pruneScenes(store, { maxScenes: 2, project: 'menm', now })
  assert.equal(result.deleted, 0)
  assert.equal(result.kept, 6)
  assert.deepEqual(result.protected.sort(), ['全局冷', '冷场景'].sort())
  assert.equal(listScenes(store, { project: 'menm', now }).length, 6)
})

test('pruneScenes caps project and global buckets independently and never deletes L1 facts', () => {
  const store = db()
  const now = 100 * 86_400_000
  for (const [name, delta] of [['项目一', 9], ['项目二', 5], ['项目三', 0]]) {
    upsertScene(store, { scope: 'project', project: 'menm', name, heatDelta: delta, now })
  }
  for (const [name, delta] of [['全局一', 9], ['全局二', 5], ['全局三', 0]]) {
    upsertScene(store, { scope: 'global', project: null, name, heatDelta: delta, now })
  }
  upsertScene(store, { scope: 'project', project: 'other', name: '别人一', now })
  upsertScene(store, { scope: 'project', project: 'other', name: '别人二', now })
  saveMemory(store, { text: '场景修剪不应删除 L1 事实', scope: 'project', project: 'menm' }, now)
  const result = pruneScenes(store, { maxScenes: 2, project: 'menm', now })
  assert.equal(result.deleted, 2) // one per bucket, never the other project's
  assert.equal(result.kept, 4)
  assert.deepEqual(result.removed.sort(), ['全局三', '项目三'].sort())
  const menm = listScenes(store, { project: 'menm', now }).map((row) => row.name)
  assert.ok(menm.includes('项目一'))
  assert.ok(menm.includes('全局一'))
  assert.ok(!menm.includes('项目三'))
  assert.ok(!menm.includes('全局三'))
  const other = listScenes(store, { project: 'other', now }).filter((row) => row.scope === 'project')
  assert.equal(other.length, 2)
  assert.equal(store.prepare('SELECT COUNT(*) AS n FROM memory').get().n, 1)
})

test('pruneScenes reports the removed scene names once, even when both buckets share a name', () => {
  const store = db()
  const now = 100 * 86_400_000
  upsertScene(store, { scope: 'project', project: 'menm', name: '热场景', heatDelta: 9, now })
  upsertScene(store, { scope: 'project', project: 'menm', name: '同名场景', now })
  upsertScene(store, { scope: 'global', project: null, name: '全局热', heatDelta: 9, now })
  upsertScene(store, { scope: 'global', project: null, name: '同名场景', now })
  const result = pruneScenes(store, { maxScenes: 1, project: 'menm', now })
  assert.equal(result.deleted, 2)
  assert.deepEqual(result.removed, ['同名场景'])
})
