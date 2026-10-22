/**
 * L1: atomic memories extracted from L0 turns.
 *
 * The `memory` table doubles as the L1 store: v2 added `priority`, `version`,
 * `superseded_by`, `scene` and `source_seqs`. Superseded rows stay for audit
 * but are excluded from recall and candidate search.
 *
 * Decision vocabulary (same four states as TencentDB Agent Memory):
 *   store  - a new fact
 *   update - the new text replaces an existing row (version + 1)
 *   merge  - the new text replaces the target and absorbs other rows
 *   skip   - already known
 *
 * @module dsh-memory/l1
 */
import { KINDS, KIND_WEIGHTS, deriveTitle, normalizeText, textHash } from './store.js'
import { buildFtsQuery, extractTerms } from './recall.js'
import { searchFts, searchLike } from './store.js'
import { VECTOR_MODEL, embed, packVector } from './vector.js'

/** Kinds the extractor may emit (v1 kinds stay valid for manual writes). */
export const L1_KINDS = /** @type {const} */ ([
  'persona',
  'instruction',
  'work_fact',
  'work_method',
  'work_task',
  'work_artifact',
  'episodic',
])

/** Clamp one priority into 0..100. */
export function clampPriority(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** Normalize a kind to the L1 vocabulary; unknown kinds fall back to `work_fact`. */
export function normalizeKind(kind) {
  const value = String(kind ?? '').trim()
  if (L1_KINDS.includes(value)) return value
  if (value === 'fact' || value === 'note') return 'work_fact'
  return 'work_fact'
}

/**
 * Trigram Jaccard similarity, used by the deterministic conflict heuristic.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function textSimilarity(a, b) {
  const grams = (text) => {
    const value = normalizeText(text).replace(/\s+/g, ' ')
    const set = new Set()
    for (let i = 0; i + 3 <= value.length; i++) set.add(value.slice(i, i + 3))
    return set
  }
  const left = grams(a)
  const right = grams(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Existing rows that could conflict with `text`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text
 * @param {{ limit?: number, project?: string|null, scope?: 'global'|'project'|'all' }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function findCandidates(db, text, options = {}) {
  const limit = Math.max(1, Math.min(20, options.limit ?? 4))
  const { ftsTerms, likeTerms } = extractTerms(text)
  const ftsQuery = buildFtsQuery(ftsTerms)
  const scope = options.scope === 'global' ? 'global' : 'project'
  const found = new Map()
  if (ftsQuery !== '') {
    for (const row of searchFts(db, ftsQuery, {
      limit,
      scope,
      project: options.project ?? null,
      kinds: L1_KINDS,
    })) {
      found.set(row.id, row)
    }
  }
  if (found.size < limit && likeTerms.length > 0) {
    for (const row of searchLike(db, likeTerms, {
      limit,
      scope,
      project: options.project ?? null,
      kinds: L1_KINDS,
    })) {
      if (!found.has(row.id)) found.set(row.id, row)
    }
  }
  return [...found.values()].slice(0, limit)
}

/**
 * One existing row by exact normalized text, if any.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text
 * @returns {Record<string, any>|undefined}
 */
export function findByHash(db, text) {
  return db
    .prepare('SELECT * FROM memory WHERE hash = ? AND superseded_by IS NULL')
    .get(textHash(text))
}

/**
 * Deterministic fallback when the LLM conflict pass is unavailable.
 * @param {{ text: string }} fact
 * @param {Array<Record<string, any>>} candidates
 * @returns {{ op: 'store'|'update'|'skip', targetId: number|null }}
 */
export function decideHeuristically(fact, candidates) {
  const exact = candidates.find((row) => textHash(row.text) === textHash(fact.text))
  if (exact) return { op: 'skip', targetId: exact.id }
  let best = null
  let bestScore = 0
  for (const row of candidates) {
    const score = textSimilarity(row.text, fact.text)
    if (score > bestScore) {
      best = row
      bestScore = score
    }
  }
  if (best && bestScore >= 0.75) return { op: 'update', targetId: best.id }
  return { op: 'store', targetId: null }
}

/**
 * Apply one extractor decision to the store.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   op: 'store'|'update'|'merge'|'skip',
 *   kind?: string,
 *   text: string,
 *   priority?: number,
 *   scene?: string|null,
 *   targetId?: number|null,
 *   mergeIds?: number[],
 * }} decision
 * @param {{
 *   project?: string|null,
 *   scope?: 'global'|'project',
 *   sessionId?: string|null,
 *   sourceSeqs?: number[],
 *   now?: number,
 * }} [ctx]
 * @returns {{ op: string, id: number|null, version: number }}
 */
export function applyDecision(db, decision, ctx = {}) {
  const now = ctx.now ?? Date.now()
  const text = String(decision.text ?? '').trim()
  const op = decision.op
  if (text === '') throw new Error('applyDecision: empty text')
  if (op === 'skip') return { op, id: decision.targetId ?? null, version: 0 }

  const project = ctx.project ?? null
  const scope = ctx.scope === 'global' || project === null ? 'global' : 'project'
  const kind = normalizeKind(decision.kind)
  const priority = clampPriority(decision.priority)
  const scene = decision.scene === undefined ? null : decision.scene
  const sourceSeqs = JSON.stringify(Array.isArray(ctx.sourceSeqs) ? ctx.sourceSeqs : [])

  if (op === 'store' || op === 'update' || op === 'merge') {
    const targetId = Number(decision.targetId ?? 0)
    const target = targetId > 0 ? db.prepare('SELECT * FROM memory WHERE id = ?').get(targetId) : undefined
    if ((op === 'update' || op === 'merge') && target === undefined) {
      // Target vanished (forgotten concurrently): fall back to a new row.
      return insertFact(db, { text, kind, priority, scene, scope, project, sessionId: ctx.sessionId ?? null, sourceSeqs, now })
    }
    if (target !== undefined) {
      // A different row already owns the new text: treat it as merged into that row.
      const owner = db.prepare('SELECT id FROM memory WHERE hash = ? AND id <> ?').get(textHash(text), targetId)
      if (owner !== undefined) {
        if (op === 'merge') {
          for (const id of decision.mergeIds ?? []) supersede(db, [id], owner.id)
        }
        return { op: 'skip', id: Number(owner.id), version: 0 }
      }
      db.prepare(
        `INSERT INTO memory_history(memory_id, version, op, text, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(targetId, Number(target.version ?? 1), op, String(target.text ?? ''), now)
      db.prepare(
        `UPDATE memory
            SET kind = ?, text = ?, title = ?, hash = ?, priority = ?, scene = ?,
                scope = ?, project = ?, source = 'extract', source_seqs = ?,
                vec = ?, vec_model = ?,
                version = version + 1, updated_at = ?
          WHERE id = ?`,
      ).run(
        kind,
        text,
        deriveTitle(text),
        textHash(text),
        priority,
        scene,
        scope,
        project,
        sourceSeqs,
        packVector(embed(text)),
        VECTOR_MODEL,
        now,
        targetId,
      )
      if (op === 'merge') {
        for (const id of decision.mergeIds ?? []) supersede(db, [id], targetId)
      }
      return { op, id: targetId, version: Number(target.version ?? 1) + 1 }
    }
  }

  return insertFact(db, { text, kind, priority, scene, scope, project, sessionId: ctx.sessionId ?? null, sourceSeqs, now })
}

/**
 * Insert one L1 row, reusing an existing row with the same hash.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   text: string, kind: string, priority: number, scene: string|null,
 *   scope: 'global'|'project', project: string|null, sessionId: string|null,
 *   sourceSeqs: string, now: number,
 * }} input
 * @returns {{ op: string, id: number, version: number }}
 */
export function insertFact(db, input) {
  const existing = db.prepare('SELECT id, version FROM memory WHERE hash = ?').get(textHash(input.text))
  if (existing !== undefined) return { op: 'skip', id: Number(existing.id), version: Number(existing.version ?? 1) }
  const result = db
    .prepare(
      `INSERT INTO memory
         (kind, scope, project, session_id, title, text, tags, source, hash,
          created_at, updated_at, priority, version, superseded_by, scene, source_seqs,
          vec, vec_model)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'extract', ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      input.scope,
      input.project,
      input.sessionId,
      deriveTitle(input.text),
      input.text,
      textHash(input.text),
      input.now,
      input.now,
      input.priority,
      input.scene,
      input.sourceSeqs,
      packVector(embed(input.text)),
      VECTOR_MODEL,
    )
  return { op: 'store', id: Number(result.lastInsertRowid), version: 1 }
}

/**
 * Mark rows as superseded by another row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @param {number} byId
 * @returns {number}
 */
export function supersede(db, ids, byId) {
  const list = ids.filter((id) => Number.isInteger(id) && id > 0 && id !== byId)
  if (list.length === 0) return 0
  const placeholders = list.map(() => '?').join(',')
  const result = db
    .prepare(`UPDATE memory SET superseded_by = ?, updated_at = ? WHERE id IN (${placeholders}) AND superseded_by IS NULL`)
    .run(byId, Date.now(), ...list)
  return Number(result.changes)
}

/**
 * Version history of one memory, newest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} memoryId
 * @param {number} [limit]
 * @returns {Array<Record<string, any>>}
 */
export function historyFor(db, memoryId, limit = 20) {
  return db
    .prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY version DESC, id DESC LIMIT ?')
    .all(memoryId, Math.max(1, limit))
}

/**
 * Active L1 rows for one scene, used by the L2 summarizer.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scene: string, project?: string|null, limit?: number }} input
 * @returns {Array<Record<string, any>>}
 */
export function factsForScene(db, input) {
  return db
    .prepare(
      `SELECT * FROM memory
        WHERE superseded_by IS NULL AND scene = ?
          AND (scope = 'global' OR project = ?)
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(input.scene, input.project ?? null, Math.max(1, Math.min(100, input.limit ?? 40)))
}

/** Kinds ranked by weight; used by stats and recall docs. */
export function kindWeight(kind) {
  return KIND_WEIGHTS[kind] ?? 0.5
}

/** Export the canonical kind list for config validation. */
export { KINDS }
