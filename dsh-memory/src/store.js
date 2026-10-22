/**
 * SQLite storage for dsh-memory.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so the plugin has zero
 * runtime dependencies. Search is FTS5 with the `trigram` tokenizer, which
 * handles CJK substrings (>= 3 chars) and ASCII substrings without a custom
 * word segmenter; 2-char CJK terms fall back to LIKE in recall.js.
 *
 * @module dsh-memory/store
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { VECTOR_MODEL, embed, packVector } from './vector.js'

/** Schema version; bump when the layout changes and add a migration step. */
export const SCHEMA_VERSION = 3

/**
 * Kinds of memory rows.
 *
 * v1 shipped `fact` / `episode` / `note`. v2 adds the L1 taxonomy borrowed
 * from TencentDB Agent Memory (see DESIGN-v2.md §4.2). `episode` stays for
 * backward compatibility with v1 rows; new extraction prefers the L1 kinds.
 */
export const KINDS = /** @type {const} */ ([
  'persona',
  'instruction',
  'work_fact',
  'work_method',
  'work_task',
  'work_artifact',
  'episodic',
  'fact',
  'episode',
  'note',
])

/** Relative importance per kind, used by recall scoring. */
export const KIND_WEIGHTS = /** @type {Record<string, number>} */ ({
  persona: 1,
  instruction: 1,
  work_fact: 0.9,
  work_method: 0.8,
  work_artifact: 0.7,
  work_task: 0.6,
  episodic: 0.4,
  fact: 0.9,
  note: 0.8,
  episode: 0.5,
})


/**
 * Normalize text for hashing: trim, collapse whitespace, lowercase.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Stable content hash used for idempotent writes (same fact saved twice).
 * @param {string} text
 * @returns {string}
 */
export function textHash(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 32)
}

/**
 * Open (and migrate) the memory database.
 *
 * @param {string} path - absolute database path; its directory is created.
 * @returns {DatabaseSync}
 */
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 3000')
  migrate(db)
  // v2 → v3 backfill: the plugin is the only writer, so a bounded pass at open
  // is enough; the next open finishes any remainder.
  try {
    backfillVectors(db, { limit: 500 })
  } catch {
    /* vectors are an optimization; never block opening the database */
  }
  return db
}

/**
 * Compute local lexical vectors for rows that lack one (or whose model tag is
 * stale). Bounded so opening a large database stays fast.
 *
 * @param {DatabaseSync} db
 * @param {{ limit?: number }} [options]
 * @returns {number} rows updated
 */
export function backfillVectors(db, options = {}) {
  const limit = Math.max(1, Math.min(10_000, options.limit ?? 500))
  const rows = db
    .prepare(
      `SELECT id, text FROM memory
        WHERE vec IS NULL OR vec_model IS NOT ? 
        LIMIT ?`,
    )
    .all(VECTOR_MODEL, limit)
  if (rows.length === 0) return 0
  const update = db.prepare('UPDATE memory SET vec = ?, vec_model = ? WHERE id = ?')
  let updated = 0
  for (const row of rows) {
    update.run(packVector(embed(String(row.text ?? ''))), VECTOR_MODEL, row.id)
    updated += 1
  }
  return updated
}

/**
 * Create the schema when absent and record the version.
 * @param {DatabaseSync} db
 */
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL DEFAULT 'fact',
      scope        TEXT NOT NULL DEFAULT 'global',   -- global | project
      project      TEXT,                              -- project key, null for global
      session_id   TEXT,
      title        TEXT NOT NULL DEFAULT '',
      text         TEXT NOT NULL,
      tags         TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
      source       TEXT NOT NULL DEFAULT 'manual',   -- manual | turn | tool | import
      hash         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count    INTEGER NOT NULL DEFAULT 0,
      pinned       INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS memory_hash_uniq ON memory(hash);
    CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory(scope, project, kind);
    CREATE INDEX IF NOT EXISTS memory_recent_idx ON memory(created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      title,
      text,
      tags,
      content='memory',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, title, text, tags)
      VALUES (new.id, new.title, new.text, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, text, tags)
      VALUES ('delete', old.id, old.title, old.text, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, text, tags)
      VALUES ('delete', old.id, old.title, old.text, old.tags);
      INSERT INTO memory_fts(rowid, title, text, tags)
      VALUES (new.id, new.title, new.text, new.tags);
    END;

    -- ── v2: L0 raw turns, per-session cursor, L1 audit, L2 scenes, L3 persona ──
    CREATE TABLE IF NOT EXISTS l0_turns (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      turn             INTEGER NOT NULL,
      project          TEXT,
      user_text        TEXT NOT NULL DEFAULT '',
      assistant_text   TEXT NOT NULL DEFAULT '',
      tool_names       TEXT NOT NULL DEFAULT '[]',
      seq_from         INTEGER,
      seq_to           INTEGER,
      created_at       INTEGER NOT NULL,
      extracted_at     INTEGER,
      extract_attempts INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, turn)
    );
    CREATE INDEX IF NOT EXISTS l0_pending_idx ON l0_turns(extracted_at, id);

    CREATE TABLE IF NOT EXISTS l0_cursor (
      session_id                  TEXT PRIMARY KEY,
      last_turn                   INTEGER NOT NULL DEFAULT 0,
      conversations_since_extract INTEGER NOT NULL DEFAULT 0,
      threshold                   INTEGER NOT NULL DEFAULT 1,
      pending_since               INTEGER,
      updated_at                  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id  INTEGER NOT NULL,
      version    INTEGER NOT NULL,
      op         TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_history_idx ON memory_history(memory_id, version);

    CREATE TABLE IF NOT EXISTS l2_scenes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL DEFAULT 'project',
      project    TEXT,
      name       TEXT NOT NULL,
      summary    TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      heat       REAL NOT NULL DEFAULT 1,
      fact_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- SQLite treats NULLs as distinct in UNIQUE, so key on ifnull(project,'')
    CREATE UNIQUE INDEX IF NOT EXISTS l2_scenes_uniq ON l2_scenes(scope, ifnull(project, ''), name);

    CREATE TABLE IF NOT EXISTS l3_persona (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      scope      TEXT NOT NULL,
      project    TEXT,
      body       TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS l3_persona_uniq ON l3_persona(scope, ifnull(project, ''));
  `)

  // v1 → v2: additive columns on the existing memory table.
  ensureColumn(db, 'memory', 'priority', 'INTEGER NOT NULL DEFAULT 50')
  ensureColumn(db, 'memory', 'version', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'memory', 'superseded_by', 'INTEGER')
  ensureColumn(db, 'memory', 'scene', 'TEXT')
  ensureColumn(db, 'memory', 'source_seqs', 'TEXT')
  // v2 → v3: local lexical vector for hybrid recall.
  ensureColumn(db, 'memory', 'vec', 'BLOB')
  ensureColumn(db, 'memory', 'vec_model', 'TEXT')

  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
}

/**
 * Add a column when the table does not have it yet (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`). Idempotent: a present column is a no-op.
 * @param {DatabaseSync} db
 * @param {string} table
 * @param {string} column
 * @param {string} declaration - type + constraints, e.g. `INTEGER NOT NULL DEFAULT 50`
 */
export function ensureColumn(db, table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some((row) => row.name === column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  return true
}

/* ── meta key/value helpers (tokens spent, extraction bookkeeping) ───────── */

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @returns {string|undefined}
 */
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : String(row.value)
}

/**
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {string|number} value
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value))
}

/**
 * Add to a numeric meta counter (tokens, calls, …).
 * @param {DatabaseSync} db
 * @param {string} key
 * @param {number} delta
 * @returns {number} the new value
 */
export function addMeta(db, key, delta) {
  const current = Number(getMeta(db, key) ?? 0)
  const next = current + delta
  setMeta(db, key, next)
  return next
}

/**
 * @typedef {object} MemoryInput
 * @property {'fact'|'episode'|'note'} [kind]
 * @property {'global'|'project'} [scope]
 * @property {string|null} [project]
 * @property {string|null} [sessionId]
 * @property {string} text
 * @property {string} [title]
 * @property {string[]} [tags]
 * @property {string} [source]
 * @property {boolean} [pinned]
 */

/**
 * Insert a memory, returning the existing row when the same text already
 * exists (idempotent). Re-saving refreshes scope/tags/title but never
 * duplicates the row.
 *
 * @param {DatabaseSync} db
 * @param {MemoryInput} input
 * @param {number} [now]
 * @returns {{ id: number, inserted: boolean }}
 */
export function saveMemory(db, input, now = Date.now()) {
  const text = String(input.text ?? '').trim()
  if (text === '') throw new Error('memory text is empty')
  const kind = KINDS.includes(input.kind) ? input.kind : 'fact'
  const scope = input.scope === 'project' ? 'project' : 'global'
  const project = scope === 'project' ? (input.project ?? null) : null
  const title = String(input.title ?? deriveTitle(text)).slice(0, 200)
  const tags = JSON.stringify(Array.isArray(input.tags) ? input.tags.slice(0, 20).map(String) : [])
  const hash = textHash(text)
  const existing = db.prepare('SELECT id FROM memory WHERE hash = ?').get(hash)
  if (existing !== undefined) {
    db.prepare(
      `UPDATE memory
          SET kind = ?, scope = ?, project = ?, title = ?, tags = ?, updated_at = ?, pinned = MAX(pinned, ?)
        WHERE id = ?`,
    ).run(kind, scope, project, title, tags, now, input.pinned ? 1 : 0, existing.id)
    return { id: Number(existing.id), inserted: false }
  }
  const result = db
    .prepare(
      `INSERT INTO memory
         (kind, scope, project, session_id, title, text, tags, source, hash,
          created_at, updated_at, pinned, vec, vec_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      scope,
      project,
      input.sessionId ?? null,
      title,
      text,
      tags,
      input.source ?? 'manual',
      hash,
      now,
      now,
      input.pinned ? 1 : 0,
      packVector(embed(text)),
      VECTOR_MODEL,
    )
  return { id: Number(result.lastInsertRowid), inserted: true }
}

/**
 * Derive a short title from text (first line / first sentence, <= 80 chars).
 * @param {string} text
 * @returns {string}
 */
export function deriveTitle(text) {
  const firstLine = String(text).split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const sentence = firstLine.split(/(?<=[。！？.!?])\s*/)[0] ?? firstLine
  return sentence.trim().slice(0, 80)
}

/**
 * Row shape as used by recall and tools.
 * @typedef {object} MemoryRow
 * @property {number} id
 * @property {string} kind
 * @property {string} scope
 * @property {string|null} project
 * @property {string|null} session_id
 * @property {string} title
 * @property {string} text
 * @property {string} tags
 * @property {string} source
 * @property {number} created_at
 * @property {number} updated_at
 * @property {number|null} last_used_at
 * @property {number} use_count
 * @property {number} pinned
 * @property {number} [rank]
 */

/**
 * Full-text search via FTS5 trigram. Returns rows with a `rank` column
 * (FTS5 bm25; more negative is a better match).
 *
 * @param {DatabaseSync} db
 * @param {string} ftsQuery - already-quoted FTS5 query, e.g. `"foo" OR "bar"`
 * @param {{ limit?: number, scope?: 'global'|'project', project?: string|null }} [options]
 * @returns {MemoryRow[]}
 */
export function searchFts(db, ftsQuery, options = {}) {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const where = []
  const params = [ftsQuery]
  if (options.includeSuperseded !== true) where.push('m.superseded_by IS NULL')
  if (Array.isArray(options.kinds) && options.kinds.length > 0) {
    where.push(`m.kind IN (${options.kinds.map(() => '?').join(',')})`)
    params.push(...options.kinds)
  }
  if (options.scope === 'project' && options.project) {
    // project-scoped results may include global facts, which always apply
    where.push("(m.scope = 'global' OR (m.scope = 'project' AND m.project = ?))")
    params.push(options.project)
  } else if (options.scope === 'global') {
    where.push("m.scope = 'global'")
  }
  const sql = `
    SELECT m.*, bm25(memory_fts) AS rank
      FROM memory_fts
      JOIN memory m ON m.id = memory_fts.rowid
     WHERE memory_fts MATCH ?
       ${where.length ? 'AND ' + where.join(' AND ') : ''}
     ORDER BY rank
     LIMIT ${limit}`
  return /** @type {MemoryRow[]} */ (db.prepare(sql).all(...params))
}

/**
 * Substring search used for 2-char CJK terms that trigram cannot match.
 *
 * @param {DatabaseSync} db
 * @param {string[]} terms
 * @param {{ limit?: number, scope?: 'global'|'project', project?: string|null }} [options]
 * @returns {MemoryRow[]}
 */
export function searchLike(db, terms, options = {}) {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, 6)
  if (cleaned.length === 0) return []
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const clauses = cleaned.map(() => '(m.title LIKE ? OR m.text LIKE ? OR m.tags LIKE ?)')
  const params = []
  for (const term of cleaned) {
    const pattern = `%${term.replace(/[%_]/g, (c) => '\\' + c)}%`
    params.push(pattern, pattern, pattern)
  }
  let scopeClause = 'AND m.superseded_by IS NULL'
  if (Array.isArray(options.kinds) && options.kinds.length > 0) {
    scopeClause += ` AND m.kind IN (${options.kinds.map(() => '?').join(',')})`
    params.push(...options.kinds)
  }
  if (options.scope === 'project' && options.project) {
    scopeClause += " AND (m.scope = 'global' OR (m.scope = 'project' AND m.project = ?))"
    params.push(options.project)
  } else if (options.scope === 'global') {
    scopeClause += " AND m.scope = 'global'"
  }
  const sql = `
    SELECT m.*
      FROM memory m
     WHERE (${clauses.join(' OR ')})
       ${scopeClause} 
     ORDER BY m.pinned DESC, m.updated_at DESC
     LIMIT ${limit}`
  return /** @type {MemoryRow[]} */ (db.prepare(sql).all(...params))
}

/**
 * Fetch rows by id.
 * @param {DatabaseSync} db
 * @param {number[]} ids
 * @returns {MemoryRow[]}
 */
export function getByIds(db, ids) {
  const list = ids.filter((id) => Number.isInteger(id) && id > 0)
  if (list.length === 0) return []
  const placeholders = list.map(() => '?').join(',')
  return /** @type {MemoryRow[]} */ (db.prepare(`SELECT * FROM memory WHERE id IN (${placeholders})`).all(...list))
}

/**
 * Mark rows as used (recall bookkeeping), so frequently recalled memories
 * rank slightly higher and stale ones can be pruned later.
 * @param {DatabaseSync} db
 * @param {number[]} ids
 * @param {number} [now]
 */
export function touchMemories(db, ids, now = Date.now()) {
  const list = ids.filter((id) => Number.isInteger(id) && id > 0)
  if (list.length === 0) return
  const stmt = db.prepare('UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
  for (const id of list) stmt.run(now, id)
}

/**
 * Delete memories by id or by full-text/substring query.
 *
 * @param {DatabaseSync} db
 * @param {{ ids?: number[], query?: string }} selector
 * @returns {number} deleted row count
 */
export function forgetMemories(db, selector) {
  if (Array.isArray(selector.ids) && selector.ids.length > 0) {
    const placeholders = selector.ids.map(() => '?').join(',')
    const result = db.prepare(`DELETE FROM memory WHERE id IN (${placeholders})`).run(...selector.ids)
    return Number(result.changes)
  }
  if (typeof selector.query === 'string' && selector.query.trim() !== '') {
    const term = `%${selector.query.trim()}%`
    const result = db.prepare('DELETE FROM memory WHERE text LIKE ? OR title LIKE ?').run(term, term)
    return Number(result.changes)
  }
  return 0
}

/**
 * Aggregate counters for `memory_stats` and logs.
 * @param {DatabaseSync} db
 * @returns {{ total: number, facts: number, episodes: number, projects: number, dbBytes: number }}
 */
export function stats(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind = 'fact' THEN 1 ELSE 0 END) AS facts,
              SUM(CASE WHEN kind = 'episode' THEN 1 ELSE 0 END) AS episodes,
              SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END) AS superseded,
              COUNT(DISTINCT project) AS projects
         FROM memory`,
    )
    .get()
  /** @type {Record<string, number>} */
  const byKind = {}
  for (const item of db.prepare('SELECT kind, COUNT(*) AS n FROM memory GROUP BY kind').all()) {
    byKind[String(item.kind)] = Number(item.n)
  }
  let dbBytes = 0
  try {
    const page = db.prepare('PRAGMA page_count').get()
    const size = db.prepare('PRAGMA page_size').get()
    dbBytes = Number(page?.page_count ?? 0) * Number(size?.page_size ?? 0)
  } catch {
    dbBytes = 0
  }
  const count = (sql, ...params) => {
    try {
      return Number(db.prepare(sql).get(...params)?.n ?? 0)
    } catch {
      return 0
    }
  }
  return {
    total: Number(row?.total ?? 0),
    facts: Number(row?.facts ?? 0),
    episodes: Number(row?.episodes ?? 0),
    superseded: Number(row?.superseded ?? 0),
    projects: Number(row?.projects ?? 0),
    byKind,
    l0Total: count('SELECT COUNT(*) AS n FROM l0_turns'),
    l0Pending: count('SELECT COUNT(*) AS n FROM l0_turns WHERE extracted_at IS NULL'),
    scenes: count('SELECT COUNT(*) AS n FROM l2_scenes'),
    personas: count('SELECT COUNT(*) AS n FROM l3_persona'),
    vectorized: count('SELECT COUNT(*) AS n FROM memory WHERE vec IS NOT NULL AND vec_model = ?', VECTOR_MODEL),
    tokensSpent: Number(getMeta(db, 'l1_tokens_total') ?? 0),
    dbBytes,
  }
}

/**
 * List recent rows (for the `memory_list` tool / debugging).
 * @param {DatabaseSync} db
 * @param {{ limit?: number, kind?: string, project?: string|null }} [options]
 * @returns {MemoryRow[]}
 */
export function listRecent(db, options = {}) {
  const limit = Math.max(1, Math.min(200, options.limit ?? 20))
  const where = []
  const params = []
  if (options.kind && KINDS.includes(options.kind)) {
    where.push('kind = ?')
    params.push(options.kind)
  }
  if (options.project) {
    where.push('(scope = ? OR project = ?)')
    params.push('global', options.project)
  }
  const sql = `SELECT * FROM memory ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ${limit}`
  return /** @type {MemoryRow[]} */ (db.prepare(sql).all(...params))
}
