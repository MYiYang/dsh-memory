/**
 * Memory data management: the CRUD surface behind Settings → Memory → 记忆数据.
 *
 * The settings page can only talk to the host through `/memory/api`, so every
 * read and every write of an actual memory row lands here. Keeping the SQL in
 * one module (instead of spreading it over `index.js`) has three payoffs:
 *
 *   - the browser half never needs to know the schema, only this module's
 *     camelCase JSON shape (`serializeRow`);
 *   - every invariant the extraction pipeline relies on (hash dedupe, `vec` /
 *     `vec_model`, the inverted feature index, `memory_history`, FTS triggers)
 *     is applied on the same code path as an LLM rewrite;
 *   - the functions are pure `(db, payload) => result`, so `test/data.test.js`
 *     can drive them against a throwaway database with no cordis context.
 *
 * Manual edits are not a second-class path: a text change bumps `version`,
 * writes the previous text to `memory_history`, recomputes the lexical vector
 * and re-indexes the feature rows, exactly like `applyDecision` in `l1.js`.
 *
 * @module dsh-memory/data
 */
import { MemoryApiError } from './api.js'
import { KINDS, deriveTitle, textHash } from './store.js'
import { VECTOR_MODEL, embed, packVector } from './vector.js'
import { indexMemoryFeatures } from './feature-index.js'

/** Rows per page when the caller does not say. */
export const PAGE_SIZE = 20

/** Hard cap for one page (the UI never asks for more than 100). */
export const PAGE_SIZE_MAX = 100

/** Hard cap for one memory body; well above anything the extractor writes. */
export const MAX_TEXT_CHARS = 20_000

/** Hard cap for the optional title. */
export const MAX_TITLE_CHARS = 200

/** How many tags one row may carry. */
export const MAX_TAGS = 20

/** How many characters one tag may carry. */
export const MAX_TAG_CHARS = 64

/** Ordering options the list endpoint accepts. */
export const SORTS = /** @type {const} */ (['updated', 'created', 'priority', 'id'])

/** The kind vocabulary, as a set for validation. */
const KIND_SET = new Set(KINDS)

/** `priority` is clamped into this range (same range as `core.minPriority`). */
const PRIORITY_MIN = 0
const PRIORITY_MAX = 100
const PRIORITY_DEFAULT = 50

/** Sorts that map 1:1 to a ORDER BY fragment; nothing from the caller is interpolated. */
const ORDER_BY = {
  updated: 'updated_at DESC, id DESC',
  created: 'created_at DESC, id DESC',
  priority: 'priority DESC, updated_at DESC, id DESC',
  id: 'id DESC',
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Parse the JSON tag column into a plain string array (never throws).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(String).filter((tag) => tag !== '')
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String).filter((tag) => tag !== '')
  } catch {
    /* a malformed column degrades to "no tags" instead of failing the page */
  }
  return []
}

/**
 * One `memory` row → the JSON shape the settings page renders.
 *
 * Column names are snake_case in SQLite and camelCase on the wire; the mapping
 * lives here so the client never sees `updated_at` or `superseded_by`.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function serializeRow(row) {
  return {
    id: Number(row.id),
    kind: typeof row.kind === 'string' ? row.kind : 'fact',
    scope: row.scope === 'project' ? 'project' : 'global',
    project: typeof row.project === 'string' && row.project !== '' ? row.project : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    title: typeof row.title === 'string' ? row.title : '',
    text: typeof row.text === 'string' ? row.text : '',
    tags: parseTags(row.tags),
    source: typeof row.source === 'string' ? row.source : 'manual',
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : PRIORITY_DEFAULT,
    pinned: Number(row.pinned) === 1,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : 1,
    supersededBy:
      row.superseded_by === null || row.superseded_by === undefined ? null : Number(row.superseded_by),
    scene: typeof row.scene === 'string' && row.scene !== '' ? row.scene : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    useCount: Number(row.use_count ?? 0),
  }
}

/**
 * Validate and normalize a tag list; accepts an array or a comma separated
 * string so both the API and a text input are safe callers.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTags(value) {
  /** @type {unknown[]} */
  let raw = []
  if (Array.isArray(value)) raw = value
  else if (typeof value === 'string') raw = value.split(',')
  else if (value === undefined || value === null) raw = []
  else throw new MemoryApiError('bad-request', 'tags must be an array of strings')
  /** @type {string[]} */
  const tags = []
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new MemoryApiError('bad-request', 'tags must be an array of strings')
    }
    const tag = String(item).trim()
    if (tag === '') continue
    if (tag.length > MAX_TAG_CHARS) {
      throw new MemoryApiError('bad-request', `each tag may have at most ${MAX_TAG_CHARS} characters`)
    }
    if (!tags.includes(tag)) tags.push(tag)
    if (tags.length > MAX_TAGS) throw new MemoryApiError('bad-request', `at most ${MAX_TAGS} tags per memory`)
  }
  return tags
}

/**
 * Validate a memory body.
 * @param {unknown} value
 * @param {string} label - 'text' | 'title'
 * @param {number} max
 * @returns {string}
 */
function normalizeText(value, label, max) {
  if (typeof value !== 'string') throw new MemoryApiError('bad-request', `${label} must be a string`)
  const text = value.trim()
  if (text === '') throw new MemoryApiError('bad-request', `${label} must not be empty`)
  if (text.length > max) throw new MemoryApiError('bad-request', `${label} may have at most ${max} characters`)
  return text
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKind(value) {
  if (value === undefined || value === null || value === '') return 'work_fact'
  const kind = String(value)
  if (!KIND_SET.has(kind)) throw new MemoryApiError('bad-request', `unknown kind "${kind}"`)
  return kind
}

/**
 * @param {unknown} value
 * @param {{ fallback?: 'global'|'project' }} [options]
 * @returns {'global'|'project'}
 */
function normalizeScope(value, options = {}) {
  if (value === undefined || value === null || value === '') return options.fallback ?? 'global'
  if (value === 'global' || value === 'project') return value
  throw new MemoryApiError('bad-request', 'scope must be "global" or "project"')
}

/**
 * A project-scoped row without a project key is invisible to every read path
 * (`recall` always filters on `project = ?`), so the pair is validated together.
 *
 * @param {'global'|'project'} scope
 * @param {unknown} project
 * @returns {string|null}
 */
function normalizeProject(scope, project) {
  if (scope === 'global') return null
  const value = typeof project === 'string' ? project.trim() : ''
  if (value === '') throw new MemoryApiError('bad-request', 'a project-scoped memory needs a project name')
  if (value.length > 200) throw new MemoryApiError('bad-request', 'project may have at most 200 characters')
  return value
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} [label]
 * @returns {boolean}
 */
function normalizeBoolean(value, fallback, label = 'value') {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new MemoryApiError('bad-request', `${label} must be a boolean`)
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizePriority(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw new MemoryApiError('bad-request', 'priority must be a number')
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(numeric)))
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeId(value) {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new MemoryApiError('bad-request', 'id must be a positive integer')
  return id
}

/**
 * Fetch one row or raise the stable `not-found` code.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {Record<string, any>}
 */
function requireRow(db, id) {
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(id)
  if (row === undefined) throw new MemoryApiError('not-found', `memory #${id} does not exist`)
  return /** @type {Record<string, any>} */ (row)
}

/**
 * Escape a LIKE pattern; every caller passes the escaped text with `ESCAPE '\'`.
 * @param {string} value
 * @returns {string}
 */
function likePattern(value) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/**
 * Filter facets for the modal's dropdowns: which kinds/scopes/projects exist
 * and how large each bucket is. Computed over the whole table (not the current
 * page) so a filter never disappears while it is active.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ kinds: Array<{kind: string, count: number}>, scopes: Array<{scope: string, count: number}>, projects: Array<{project: string, count: number}>, total: number }}
 */
export function facets(db) {
  const kinds = db
    .prepare('SELECT kind, COUNT(*) AS n FROM memory GROUP BY kind ORDER BY n DESC, kind ASC')
    .all()
    .map((row) => ({ kind: String(row.kind), count: Number(row.n) }))
  const scopes = db
    .prepare('SELECT scope, COUNT(*) AS n FROM memory GROUP BY scope ORDER BY n DESC, scope ASC')
    .all()
    .map((row) => ({ scope: String(row.scope), count: Number(row.n) }))
  const projects = db
    .prepare(
      `SELECT project, COUNT(*) AS n FROM memory
        WHERE scope = 'project' AND project IS NOT NULL AND project <> ''
        GROUP BY project ORDER BY n DESC, project ASC`,
    )
    .all()
    .map((row) => ({ project: String(row.project), count: Number(row.n) }))
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0)
  return { kinds, scopes, projects, total }
}

/**
 * One page of memories with optional search and filters.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   query?: unknown, kind?: unknown, scope?: unknown, project?: unknown,
 *   includeSuperseded?: unknown, sort?: unknown, page?: unknown, pageSize?: unknown,
 * }} [payload]
 * @returns {Record<string, any>}
 */
export function listMemories(db, payload = {}) {
  const page = clampInt(payload.page, 1, 1, 1_000_000)
  const pageSize = clampInt(payload.pageSize, PAGE_SIZE, 1, PAGE_SIZE_MAX)
  const sort = SORTS.includes(/** @type {any} */ (payload.sort)) ? String(payload.sort) : 'updated'
  const includeSuperseded = normalizeBoolean(payload.includeSuperseded, false, 'includeSuperseded')

  /** @type {string[]} */
  const where = []
  /** @type {any[]} */
  const params = []

  const query = typeof payload.query === 'string' ? payload.query.trim() : ''
  if (query.length > 200) throw new MemoryApiError('bad-request', 'query may have at most 200 characters')
  if (query !== '') {
    // Substring search: FTS trigram cannot match 1–2 character CJK queries and
    // the management view must find exactly what the user typed.
    const pattern = likePattern(query)
    where.push("(title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
    params.push(pattern, pattern, pattern)
  }

  if (payload.kind !== undefined && payload.kind !== null && payload.kind !== '') {
    const kind = String(payload.kind)
    if (!KIND_SET.has(kind)) throw new MemoryApiError('bad-request', `unknown kind "${kind}"`)
    where.push('kind = ?')
    params.push(kind)
  }

  if (payload.scope !== undefined && payload.scope !== null && payload.scope !== '') {
    const scope = normalizeScope(payload.scope)
    where.push('scope = ?')
    params.push(scope)
  }

  const project = typeof payload.project === 'string' ? payload.project.trim() : ''
  if (project !== '') {
    where.push('project = ?')
    params.push(project)
  }

  if (includeSuperseded !== true) where.push('superseded_by IS NULL')

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memory ${clause}`).get(...params)?.n ?? 0)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pages)
  const offset = (safePage - 1) * pageSize
  const rows = db
    .prepare(`SELECT * FROM memory ${clause} ORDER BY ${ORDER_BY[sort]} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)

  return {
    items: rows.map((row) => serializeRow(/** @type {Record<string, any>} */ (row))),
    total,
    page: safePage,
    pageSize,
    pages,
    sort,
    includeSuperseded,
    facets: facets(db),
  }
}

/**
 * One memory plus its version history (newest first, bounded).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {unknown} value - row id
 * @returns {Record<string, any>}
 */
export function getMemory(db, value) {
  const id = normalizeId(value)
  const item = serializeRow(requireRow(db, id))
  const history = db
    .prepare(
      `SELECT version, op, text, created_at AS createdAt
         FROM memory_history WHERE memory_id = ? ORDER BY version DESC, id DESC LIMIT 10`,
    )
    .all(id)
    .map((row) => ({
      version: Number(row.version),
      op: String(row.op),
      text: String(row.text),
      createdAt: Number(row.createdAt),
    }))
  return { item, history }
}

/**
 * Insert a memory from the settings page.
 *
 * The `memory` table has a UNIQUE index on `hash` (the normalized text), so a
 * second row with identical text cannot exist. Instead of failing, the existing
 * row is updated with the new attributes and reported as `inserted: false` —
 * the same idempotent contract as `saveMemory`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} [payload]
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function createMemory(db, payload = {}, now = Date.now()) {
  const text = normalizeText(payload.text, 'text', MAX_TEXT_CHARS)
  const kind = normalizeKind(payload.kind)
  const scope = normalizeScope(payload.scope)
  const project = normalizeProject(scope, payload.project)
  const titleValue =
    typeof payload.title === 'string' && payload.title.trim() !== ''
      ? normalizeText(payload.title, 'title', MAX_TITLE_CHARS)
      : deriveTitle(text)
  const tags = normalizeTags(payload.tags)
  const pinned = normalizeBoolean(payload.pinned, false, 'pinned')
  const priority = normalizePriority(payload.priority, PRIORITY_DEFAULT)

  const existing = db.prepare('SELECT id FROM memory WHERE hash = ?').get(textHash(text))
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  if (existing !== undefined) {
    const id = Number(existing.id)
    db.prepare(
      `UPDATE memory
          SET kind = ?, scope = ?, project = ?, title = ?, tags = ?, pinned = ?, priority = ?, updated_at = ?
        WHERE id = ?`,
    ).run(kind, scope, project, titleValue, JSON.stringify(tags), pinned ? 1 : 0, priority, timestamp, id)
    // The text (and therefore the hash, vec and feature set) is unchanged.
    return { item: serializeRow(requireRow(db, id)), inserted: false }
  }

  const result = db
    .prepare(
      `INSERT INTO memory
         (kind, scope, project, session_id, title, text, tags, source, hash,
          created_at, updated_at, priority, version, pinned, vec, vec_model)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'manual', ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      kind,
      scope,
      project,
      titleValue,
      text,
      JSON.stringify(tags),
      textHash(text),
      timestamp,
      timestamp,
      priority,
      pinned ? 1 : 0,
      packVector(embed(text)),
      VECTOR_MODEL,
    )
  const id = Number(result.lastInsertRowid)
  indexMemoryFeatures(db, id, text)
  return { item: serializeRow(requireRow(db, id)), inserted: true }
}

/**
 * Rewrite one memory. Only the members present on `payload` change; the row's
 * `hash`, lexical vector and feature rows are recomputed when the body changes,
 * and the previous body is preserved in `memory_history`.
 *
 * `version` tracks the *body*, not the metadata: pinning a row or adding a tag
 * updates `updated_at` without inventing a new text version, while rewriting
 * the text appends one history entry and bumps the counter — the same rule the
 * extraction pipeline follows in `l1.js`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} [payload]
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function updateMemory(db, payload = {}, now = Date.now()) {
  const id = normalizeId(payload.id)
  const row = requireRow(db, id)
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now()

  const nextText = payload.text === undefined ? String(row.text ?? '') : normalizeText(payload.text, 'text', MAX_TEXT_CHARS)
  const textChanged = nextText !== String(row.text ?? '')
  // A different row already owns the new body (the hash is UNIQUE): report the
  // owner instead of letting SQLite throw a constraint error at the caller.
  if (textChanged) {
    const owner = db.prepare('SELECT id FROM memory WHERE hash = ? AND id <> ?').get(textHash(nextText), id)
    if (owner !== undefined) {
      throw new MemoryApiError(
        'conflict',
        `the same text is already stored as memory #${Number(owner.id)}; edit that row instead`,
      )
    }
  }

  const kind = payload.kind === undefined ? String(row.kind ?? 'work_fact') : normalizeKind(payload.kind)
  const scope = payload.scope === undefined ? normalizeScope(row.scope, { fallback: 'global' }) : normalizeScope(payload.scope)
  const project = payload.project !== undefined || payload.scope !== undefined ? normalizeProject(scope, payload.project) : normalizeProject(scope, row.project)
  const title =
    payload.title === undefined
      ? textChanged
        ? deriveTitle(nextText)
        : String(row.title ?? '')
      : payload.title === ''
        ? deriveTitle(nextText)
        : normalizeText(payload.title, 'title', MAX_TITLE_CHARS)
  const tags = payload.tags === undefined ? parseTags(row.tags) : normalizeTags(payload.tags)
  const pinned = normalizeBoolean(payload.pinned, Number(row.pinned) === 1, 'pinned')
  const priority = normalizePriority(payload.priority, Number(row.priority ?? PRIORITY_DEFAULT))
  const version = Number.isFinite(Number(row.version)) ? Number(row.version) : 1

  if (textChanged) {
    db.prepare(
      `INSERT INTO memory_history(memory_id, version, op, text, created_at)
       VALUES (?, ?, 'edit', ?, ?)`,
    ).run(id, version, String(row.text ?? ''), timestamp)
  }

  db.prepare(
    `UPDATE memory
        SET kind = ?, scope = ?, project = ?, title = ?, text = ?, tags = ?, hash = ?,
            pinned = ?, priority = ?, vec = ?, vec_model = ?,
            version = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    kind,
    scope,
    project,
    title,
    nextText,
    JSON.stringify(tags),
    textHash(nextText),
    pinned ? 1 : 0,
    priority,
    packVector(embed(nextText)),
    VECTOR_MODEL,
    textChanged ? version + 1 : version,
    timestamp,
    id,
  )
  // The FTS triggers follow the UPDATE; the inverted feature index is a plain
  // table, so a rewritten body has to re-index explicitly.
  if (textChanged) indexMemoryFeatures(db, id, nextText)

  return { item: serializeRow(requireRow(db, id)), version: textChanged ? version + 1 : version }
}

/**
 * Delete one or more memories. Unknown ids are ignored (the caller gets the
 * real count back). FTS rows and feature rows are removed by triggers.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} [payload]
 * @returns {{ deleted: number, ids: number[] }}
 */
export function deleteMemories(db, payload = {}) {
  const raw = Array.isArray(payload.ids) ? payload.ids : payload.id === undefined ? [] : [payload.id]
  if (raw.length === 0) throw new MemoryApiError('bad-request', 'id or ids is required')
  if (raw.length > PAGE_SIZE_MAX) throw new MemoryApiError('bad-request', `at most ${PAGE_SIZE_MAX} ids per call`)
  const ids = raw.map(normalizeId)
  const placeholders = ids.map(() => '?').join(',')
  const result = db.prepare(`DELETE FROM memory WHERE id IN (${placeholders})`).run(...ids)
  return { deleted: Number(result.changes), ids }
}
