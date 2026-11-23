/** Every layer in one list: facts, raw turns, scenes, personas — and search across them. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveMemory } from '../src/store.js'
import { browseMemories } from '../src/data.js'

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browse-'))
  const db = openDatabase(join(dir, 'm.db'))
  saveMemory(db, { text: '部署流程用 pnpm', scope: 'project', project: 'demo', kind: 'work_fact' })
  db.prepare('INSERT INTO l0_turns(session_id,turn,project,user_text,assistant_text,tool_names,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('s1', 1, 'demo', '原文里的关键词', '助手回答', '[]', Date.now())
  db.prepare('INSERT INTO l2_scenes(scope,project,name,summary,body,heat,fact_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('project', 'demo', '场景甲', '摘要', '场景正文', 1, 1, Date.now(), Date.now())
  db.prepare('INSERT INTO l3_persona(scope,project,body,version,updated_at) VALUES (?,?,?,?,?)')
    .run('global', null, '画像正文', 1, Date.now())
  return db
}

test('browse returns every layer with a layer tag', () => {
  const db = seeded()
  const all = browseMemories(db, { pageSize: 100 })
  assert.equal(all.total, 4)
  const layers = new Set(all.items.map((row) => row.layer))
  for (const layer of ['fact', 'turn', 'scene', 'persona']) assert.ok(layers.has(layer), `missing ${layer}`)
  db.close()
})

test('browse filters by layer and pages', () => {
  const db = seeded()
  assert.equal(browseMemories(db, { layer: 'fact' }).total, 1)
  assert.equal(browseMemories(db, { layer: 'turn' }).items[0].text.includes('原文里的关键词'), true)
  const paged = browseMemories(db, { pageSize: 2 })
  assert.equal(paged.items.length, 2)
  assert.equal(paged.pages, 2)
  db.close()
})

test('search covers every layer, not just facts', () => {
  const db = seeded()
  assert.equal(browseMemories(db, { query: '关键词' }).total, 1, 'raw turn text should match')
  assert.equal(browseMemories(db, { query: '场景正文' }).total, 1, 'scene body should match')
  assert.equal(browseMemories(db, { query: '画像' }).total, 1, 'persona body should match')
  assert.equal(browseMemories(db, { query: 'demo' }).total >= 3, true, 'project should match across layers')
  db.close()
})

test('browse filters by kind, scope and project', () => {
  const db = seeded()
  // A real fact kind only matches the memory layer.
  const facts = browseMemories(db, { kind: 'work_fact' })
  assert.equal(facts.total, 1)
  assert.equal(facts.items[0].layer, 'fact')
  // Fixed-kind layers answer the kind filter with their own discriminator.
  const turns = browseMemories(db, { kind: 'turn' })
  assert.equal(turns.total, 1)
  assert.equal(turns.items[0].layer, 'turn')
  assert.equal(browseMemories(db, { kind: 'scene' }).total, 1)
  // A turn with a project key counts as project scope, one without as global.
  assert.equal(browseMemories(db, { scope: 'project' }).total, 3)
  assert.equal(browseMemories(db, { scope: 'global' }).total, 1)
  assert.equal(browseMemories(db, { project: 'demo' }).total, 3)
  // Filters combine with the layer filter.
  assert.equal(browseMemories(db, { layer: 'fact', scope: 'project' }).total, 1)
  assert.equal(browseMemories(db, { layer: 'turn', kind: 'work_fact' }).total, 0)
  db.close()
})

test('browse facets ignore the active condition so a dropdown never loses its option', () => {
  const db = seeded()
  const page = browseMemories(db, { kind: 'turn' })
  const kinds = page.facets.kinds.map((entry) => entry.kind)
  for (const kind of ['work_fact', 'turn', 'scene', 'persona']) assert.ok(kinds.includes(kind), `missing facet ${kind}`)
  assert.ok(page.facets.projects.some((entry) => entry.project === 'demo'))
  assert.deepEqual(
    page.facets.scopes.map((entry) => entry.scope).sort(),
    ['global', 'project'],
  )
  db.close()
})

test('browse rejects an unknown scope and echoes the sort it used', () => {
  const db = seeded()
  assert.throws(() => browseMemories(db, { scope: 'everywhere' }), /scope must be/)
  assert.equal(browseMemories(db, { sort: 'created' }).sort, 'created')
  assert.equal(browseMemories(db, { sort: 'nonsense' }).sort, 'updated')
  db.close()
})
