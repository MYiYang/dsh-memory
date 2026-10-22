/**
 * L2 scenes and L3 persona storage.
 *
 * Single source of truth is SQLite (no second markdown copy to drift, the
 * lesson from TencentDB's rowfs vs files split). Scenes carry a heat value
 * that decays over time and rises on use, so the navigation stays small.
 *
 * @module dsh-memory/profile
 */

/**
 * Decay one heat value by age; `halfLifeDays` is when it halves.
 * @param {number} heat
 * @param {number} updatedAt
 * @param {number} now
 * @param {number} [halfLifeDays]
 * @returns {number}
 */
export function effectiveHeat(heat, updatedAt, now, halfLifeDays = 14) {
  const ageDays = Math.max(0, (now - Number(updatedAt ?? now)) / 86_400_000)
  return Number(heat ?? 1) * Math.pow(0.5, ageDays / Math.max(1, halfLifeDays))
}

/**
 * Insert or update one scene block.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   scope: 'global'|'project', project?: string|null, name: string,
 *   summary?: string, body?: string, factCount?: number, heatDelta?: number, now?: number,
 * }} input
 * @returns {number} scene id
 */
export function upsertScene(db, input) {
  const now = input.now ?? Date.now()
  const scope = input.scope === 'global' ? 'global' : 'project'
  const project = scope === 'project' ? (input.project ?? null) : null
  const name = String(input.name ?? '').trim()
  if (name === '') throw new Error('upsertScene: name is required')
  const existing = db
    .prepare('SELECT * FROM l2_scenes WHERE scope = ? AND ifnull(project, \'\') = ifnull(?, \'\') AND name = ?')
    .get(scope, project, name)
  if (existing === undefined) {
    const result = db
      .prepare(
        `INSERT INTO l2_scenes(scope, project, name, summary, body, heat, fact_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(scope, project, name, String(input.summary ?? ''), String(input.body ?? ''), 1 + Number(input.heatDelta ?? 0), Math.max(0, Number(input.factCount ?? 0)), now, now)
    return Number(result.lastInsertRowid)
  }
  db.prepare(
    `UPDATE l2_scenes
        SET summary = ?, body = ?, heat = ?, fact_count = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.summary === undefined ? existing.summary : String(input.summary),
    input.body === undefined ? existing.body : String(input.body),
    Number(existing.heat ?? 1) + Number(input.heatDelta ?? 0),
    input.factCount === undefined ? Number(existing.fact_count ?? 0) : Math.max(0, Number(input.factCount)),
    now,
    existing.id,
  )
  return Number(existing.id)
}

/**
 * Add heat to scenes (recall hit, new facts).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<number|string>} names
 * @param {{ project?: string|null, delta?: number, now?: number }} [options]
 * @returns {number} rows touched
 */
export function touchScenes(db, names, options = {}) {
  const list = [...new Set(names.map(String).filter((name) => name.trim() !== ''))]
  if (list.length === 0) return 0
  const now = options.now ?? Date.now()
  let touched = 0
  for (const name of list) {
    const result = db
      .prepare(
        `UPDATE l2_scenes SET heat = heat + ?, updated_at = ?
          WHERE name = ? AND (scope = 'global' OR project = ?)`,
      )
      .run(Number(options.delta ?? 1), now, name, options.project ?? null)
    touched += Number(result.changes)
  }
  return touched
}

/**
 * Scenes for one project (plus globals), hottest first after decay.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null, limit?: number, now?: number, halfLifeDays?: number }} [options]
 * @returns {Array<Record<string, any> & { effectiveHeat: number }>}
 */
export function listScenes(db, options = {}) {
  const now = options.now ?? Date.now()
  const limit = Math.max(1, Math.min(100, options.limit ?? 40))
  const rows = db
    .prepare(
      `SELECT * FROM l2_scenes
        WHERE scope = 'global' OR project = ?
        ORDER BY heat DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(options.project ?? null, limit)
  return rows
    .map((row) => ({ ...row, effectiveHeat: effectiveHeat(row.heat, row.updated_at, now, options.halfLifeDays ?? 14) }))
    .sort((a, b) => b.effectiveHeat - a.effectiveHeat)
}

/**
 * Compact scene navigation lines for the stable injection block.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null, limit?: number, now?: number, maxChars?: number, halfLifeDays?: number }} [options]
 * @returns {string[]}
 */
export function sceneNavigation(db, options = {}) {
  const maxChars = Math.max(80, options.maxChars ?? 600)
  const lines = []
  let used = 0
  for (const scene of listScenes(db, { ...options, limit: options.limit ?? 8 })) {
    const summary = String(scene.summary ?? '').replace(/\s+/g, ' ').trim()
    const line = `- ${scene.name}（热度 ${scene.effectiveHeat.toFixed(1)}${scene.fact_count ? `，${scene.fact_count} 条` : ''}）${summary ? `: ${summary.slice(0, 80)}` : ''}`
    if (used + line.length > maxChars && lines.length > 0) break
    lines.push(line)
    used += line.length + 1
  }
  return lines
}

/**
 * One persona row (global or project).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope: 'global'|'project', project?: string|null }} input
 * @returns {Record<string, any>|undefined}
 */
export function getPersona(db, input) {
  const scope = input.scope === 'global' ? 'global' : 'project'
  return db
    .prepare("SELECT * FROM l3_persona WHERE scope = ? AND ifnull(project, '') = ifnull(?, '')")
    .get(scope, scope === 'project' ? (input.project ?? null) : null)
}

/**
 * Personas visible from one project: project-specific first, then global.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function listPersonas(db, options = {}) {
  const rows = []
  const project = options.project ?? null
  if (project !== null) {
    const row = getPersona(db, { scope: 'project', project })
    if (row !== undefined) rows.push(row)
  }
  const global = getPersona(db, { scope: 'global' })
  if (global !== undefined) rows.push(global)
  return rows
}

/**
 * Insert or rewrite a persona; version increments on every rewrite.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope: 'global'|'project', project?: string|null, body: string, now?: number }} input
 * @returns {{ id: number, version: number }}
 */
export function putPersona(db, input) {
  const now = input.now ?? Date.now()
  const scope = input.scope === 'global' ? 'global' : 'project'
  const project = scope === 'project' ? (input.project ?? null) : null
  const body = String(input.body ?? '').trim()
  if (body === '') throw new Error('putPersona: body is required')
  const existing = getPersona(db, { scope, project })
  if (existing === undefined) {
    const result = db
      .prepare('INSERT INTO l3_persona(scope, project, body, version, updated_at) VALUES (?, ?, ?, 1, ?)')
      .run(scope, project, body, now)
    return { id: Number(result.lastInsertRowid), version: 1 }
  }
  db.prepare('UPDATE l3_persona SET body = ?, version = version + 1, updated_at = ? WHERE id = ?').run(body, now, existing.id)
  return { id: Number(existing.id), version: Number(existing.version ?? 1) + 1 }
}
