/**
 * Sync schema (v6): the oplog, the peer cursors, the merge bookkeeping and the
 * triggers that capture them.
 *
 * Everything here is **additive**. No existing table gains a column, so:
 *   - an older build opening this file ignores all of it;
 *   - rolling back is `dropSyncSchema(db)` and nothing else.
 *
 * Capture is done with triggers rather than call sites because the write paths
 * are spread over `store.js`, `l1.js`, `l0.js`, `consolidate.js` and `data.js`.
 * A trigger cannot be forgotten by a new writer.
 *
 * Two guards keep the triggers cheap and loop-free:
 *   - `enabled`  — when sync is off nothing is written at all;
 *   - `applying` — while remote ops are being applied, nothing is logged, or a
 *                  pull would echo back as new local writes.
 *
 * @module dsh-memory/sync/schema
 */
import { randomUUID } from 'node:crypto'

/** Bumped when the trigger/table set changes shape. */
export const SYNC_SCHEMA_VERSION = 4

/** Tables created by this module (drop order matters: triggers first). */
export const SYNC_TABLES = [
  'sync_meta',
  'sync_oplog',
  'sync_peer',
  'sync_pending',
  'sync_rowstate',
  'sync_undo',
  'sync_state',
  'sync_tombstone',
  'sync_emb_dirty',
]

/** Trigger names, in creation order. */
export const SYNC_TRIGGERS = [
  'sync_memory_ai', 'sync_memory_au', 'sync_memory_ak', 'sync_memory_ad',
  'sync_l0_ai',
  'sync_scene_ai', 'sync_scene_au', 'sync_scene_ak', 'sync_scene_ad',
  'sync_persona_ai', 'sync_persona_au', 'sync_persona_ak', 'sync_persona_ad',
  'sync_history_ai',
  'sync_emb_ai', 'sync_emb_au', 'sync_emb_ad',
]

/**
 * Guard expression shared by every trigger.
 * A missing row (fresh install before seeding) evaluates to NULL, and
 * `NULL IS NOT '1'` is true — so a half-initialized DB still logs nothing
 * because `enabled` will be missing too.
 */
const GUARD = `(SELECT value FROM sync_meta WHERE key = 'applying') IS NOT '1'
   AND (SELECT value FROM sync_meta WHERE key = 'enabled') IS '1'`

/**
 * Emit one oplog row from inside a trigger.
 *
 * Lamport is bumped first, then embedded in the id, so `device:lamport` is
 * unique per op without a random component.
 *
 * @param {string} tbl
 * @param {string} op
 * @param {string} rowKey - SQL expression producing the cross-device key
 * @param {string} payload - SQL expression producing the JSON payload
 * @param {string} [extra] - further statements for the same trigger body
 * @returns {string}
 */
function emit(tbl, op, rowKey, payload, extra = '') {
  return `BEGIN
    UPDATE sync_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'lamport';
    INSERT INTO sync_oplog (op_id, device, lamport, tbl, row_key, op, payload, created_at)
    VALUES (
      (SELECT value FROM sync_meta WHERE key = 'device') || ':' ||
        (SELECT value FROM sync_meta WHERE key = 'lamport'),
      (SELECT value FROM sync_meta WHERE key = 'device'),
      (SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'lamport'),
      '${tbl}', ${rowKey}, '${op}', ${payload},
      CAST(strftime('%s','now') AS INTEGER) * 1000
    );
    -- A local write must claim the row's stamp too: without it a *staler* remote
    -- op would find no rowstate here, pass the LWW test and overwrite newer data.
    INSERT INTO sync_rowstate (tbl, row_key, lamport, device, op, updated_at)
    VALUES (
      '${tbl}', ${rowKey},
      (SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'lamport'),
      (SELECT value FROM sync_meta WHERE key = 'device'),
      '${op}',
      CAST(strftime('%s','now') AS INTEGER) * 1000
    )
    ON CONFLICT(tbl, row_key) DO UPDATE SET
      lamport = excluded.lamport, device = excluded.device, op = excluded.op, updated_at = excluded.updated_at;
    ${extra}
  END`
}

/**
 * Remember that a cross-device key is gone.
 *
 * Without this a peer that never saw the delete op (its oplog entry already
 * pruned, or the row died before sync was switched on) would keep the retired
 * fact forever, and a later snapshot cannot say "this is gone" because the row
 * no longer exists locally.
 *
 * @param {string} tbl
 * @param {string} rowKey - SQL expression producing the cross-device key
 * @returns {string}
 */
function recordTombstone(tbl, rowKey) {
  return `INSERT OR REPLACE INTO sync_tombstone (tbl, row_key, lamport, device, deleted_at)
    VALUES ('${tbl}', ${rowKey},
      (SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'lamport'),
      (SELECT value FROM sync_meta WHERE key = 'device'),
      CAST(strftime('%s','now') AS INTEGER) * 1000);`
}

/** The truth columns of `memory`, as a json_object expression over `p` (old/new). */
function memoryPayload(p) {
  return `json_object(
    'kind', ${p}.kind, 'scope', ${p}.scope, 'project', ${p}.project,
    'session_id', ${p}.session_id, 'title', ${p}.title, 'text', ${p}.text,
    'tags', ${p}.tags, 'source', ${p}.source, 'priority', ${p}.priority,
    'pinned', ${p}.pinned, 'scene', ${p}.scene, 'source_seqs', ${p}.source_seqs,
    'created_at', ${p}.created_at, 'updated_at', ${p}.updated_at,
    'version', ${p}.version,
    'superseded_by_hash', (SELECT hash FROM memory WHERE id = ${p}.superseded_by)
  )`
}

/** Does any truth column differ? `use_count` / `last_used_at` are deliberately absent. */
const MEMORY_CHANGED = `(old.kind IS NOT new.kind OR old.scope IS NOT new.scope
   OR old.project IS NOT new.project OR old.session_id IS NOT new.session_id
   OR old.title IS NOT new.title OR old.text IS NOT new.text OR old.tags IS NOT new.tags
   OR old.source IS NOT new.source OR old.priority IS NOT new.priority
   OR old.pinned IS NOT new.pinned OR old.version IS NOT new.version
   OR old.superseded_by IS NOT new.superseded_by OR old.scene IS NOT new.scene
   OR old.source_seqs IS NOT new.source_seqs)`

/**
 * Dirty mark for one vector row. The blob itself is *not* logged: a 16 KB hex
 * string per upsert would bloat the oplog far more than the vectors themselves.
 *
 * @param {'new'|'old'} p - trigger row reference
 * @param {'upsert'|'delete'} [op]
 * @returns {string}
 */
function embMark(p, op = 'upsert') {
  const key = `(SELECT hash FROM memory WHERE id = ${p}.memory_id) || '|' || ${p}.model`
  return `BEGIN
    UPDATE sync_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'lamport';
    INSERT INTO sync_emb_dirty (row_key, text_hash, lamport, device, op, created_at)
    VALUES (${key}, ${p}.text_hash,
      (SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'lamport'),
      (SELECT value FROM sync_meta WHERE key = 'device'),
      '${op}', CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT(row_key) DO UPDATE SET
      text_hash = excluded.text_hash, lamport = excluded.lamport,
      device = excluded.device, op = '${op}', created_at = excluded.created_at;
    INSERT INTO sync_rowstate (tbl, row_key, lamport, device, op, updated_at)
    VALUES ('memory_embeddings', ${key},
      (SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'lamport'),
      (SELECT value FROM sync_meta WHERE key = 'device'),
      '${op}', CAST(strftime('%s','now') AS INTEGER) * 1000)
    ON CONFLICT(tbl, row_key) DO UPDATE SET
      lamport = excluded.lamport, device = excluded.device, op = excluded.op, updated_at = excluded.updated_at;
  END`
}

/**
 * Create the tables, seed `sync_meta`, and install the triggers.
 *
 * Idempotent: safe to call on every open. Seeding uses `INSERT OR IGNORE`, so a
 * second open never rotates the device id (rotating it would make peers treat
 * this machine as a new device and re-fetch everything).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ created: boolean, device: string }}
 */
export function ensureSyncSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_oplog (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id      TEXT NOT NULL UNIQUE,
      device     TEXT NOT NULL,
      lamport    INTEGER NOT NULL,
      tbl        TEXT NOT NULL,
      row_key    TEXT NOT NULL,
      op         TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_oplog_seq ON sync_oplog(seq);

    CREATE TABLE IF NOT EXISTS sync_peer (
      peer      TEXT PRIMARY KEY,
      cursor    INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_pending (
      op_id      TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_rowstate (
      tbl        TEXT NOT NULL,
      row_key    TEXT NOT NULL,
      lamport    INTEGER NOT NULL,
      device     TEXT NOT NULL,
      op         TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tbl, row_key)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS sync_undo (
      op_id      TEXT PRIMARY KEY,
      tbl        TEXT NOT NULL,
      row_key    TEXT NOT NULL,
      before     TEXT,
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_undo_at ON sync_undo(applied_at);

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_tombstone (
      tbl        TEXT NOT NULL,
      row_key    TEXT NOT NULL,
      lamport    INTEGER NOT NULL,
      device     TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (tbl, row_key)
    );

    -- Vectors are too fat for the oplog (8–16 KB per row), so the trigger only
    -- marks a row dirty; the engine reads the blob back and ships it in its own
    -- object class (see sync/vectors.js). A row is removed once uploaded.
    CREATE TABLE IF NOT EXISTS sync_emb_dirty (
      row_key    TEXT PRIMARY KEY,   -- <memory.hash>|<model>
      text_hash  TEXT NOT NULL,
      lamport    INTEGER NOT NULL,
      device     TEXT NOT NULL,
      op         TEXT NOT NULL,      -- upsert | delete
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    INSERT OR IGNORE INTO sync_meta(key, value) VALUES
      ('device',   '${randomUUID()}'),
      ('lamport',  '0'),
      ('applying', '0'),
      ('enabled',  '0'),
      ('epoch',    '1'),
      ('schema',   '${SYNC_SCHEMA_VERSION}');
  `)

  // A trigger body is only created when it does not exist yet, so an older
  // install would keep the pre-tombstone definitions forever. Bumping the
  // stored schema version and redropping once is the migration: the oplog rows
  // already captured stay, nothing else is touched.
  const schemaVersion = Number(db.prepare("SELECT value FROM sync_meta WHERE key = 'schema'").get()?.value ?? '0') || 0
  const migrating = schemaVersion < SYNC_SCHEMA_VERSION
  if (migrating) {
    // DDL is transactional in SQLite: if any trigger fails to build, the old set
    // must survive whole instead of leaving the database with zero capture.
    db.exec('BEGIN')
    for (const name of SYNC_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`)
  }
  try {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_memory_ai AFTER INSERT ON memory
    WHEN ${GUARD}
    ${emit('memory', 'upsert', 'new.hash', memoryPayload('new'))};

    CREATE TRIGGER IF NOT EXISTS sync_memory_au AFTER UPDATE ON memory
    WHEN ${GUARD} AND ${MEMORY_CHANGED}
    ${emit('memory', 'upsert', 'new.hash', memoryPayload('new'))};

    -- The row key *is* the content hash, so editing the body renames the row.
    -- Without this the peer would keep the old hash forever and gain a second
    -- copy of the same fact (one stale, one new). Emit a delete for the retired
    -- key; the upsert above already carries the new one.
    CREATE TRIGGER IF NOT EXISTS sync_memory_ak AFTER UPDATE ON memory
    WHEN ${GUARD} AND old.hash IS NOT new.hash
    ${emit(
      'memory',
      'delete',
      'old.hash',
      `json_object('hash', old.hash, 'deleted_at', CAST(strftime('%s','now') AS INTEGER) * 1000)`,
      recordTombstone('memory', 'old.hash'),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_memory_ad AFTER DELETE ON memory
    WHEN ${GUARD}
    ${emit(
      'memory',
      'delete',
      'old.hash',
      `json_object('hash', old.hash, 'deleted_at', CAST(strftime('%s','now') AS INTEGER) * 1000)`,
      recordTombstone('memory', 'old.hash'),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_l0_ai AFTER INSERT ON l0_turns
    WHEN ${GUARD}
    ${emit(
      'l0_turns',
      'upsert',
      `new.session_id || '#' || new.turn`,
      `json_object('session_id', new.session_id, 'turn', new.turn, 'project', new.project,
        'user_text', new.user_text, 'assistant_text', new.assistant_text,
        'tool_names', new.tool_names, 'created_at', new.created_at)`,
    )};

    CREATE TRIGGER IF NOT EXISTS sync_scene_ai AFTER INSERT ON l2_scenes
    WHEN ${GUARD}
    ${emit(
      'l2_scenes',
      'upsert',
      `new.scope || '|' || ifnull(new.project, '') || '|' || new.name`,
      `json_object('scope', new.scope, 'project', new.project, 'name', new.name,
        'summary', new.summary, 'body', new.body, 'heat', new.heat,
        'fact_count', new.fact_count, 'created_at', new.created_at, 'updated_at', new.updated_at)`,
    )};

    CREATE TRIGGER IF NOT EXISTS sync_scene_au AFTER UPDATE ON l2_scenes
    WHEN ${GUARD} AND (old.body IS NOT new.body OR old.summary IS NOT new.summary
      OR old.name IS NOT new.name OR old.heat IS NOT new.heat OR old.fact_count IS NOT new.fact_count)
    ${emit(
      'l2_scenes',
      'upsert',
      `new.scope || '|' || ifnull(new.project, '') || '|' || new.name`,
      `json_object('scope', new.scope, 'project', new.project, 'name', new.name,
        'summary', new.summary, 'body', new.body, 'heat', new.heat,
        'fact_count', new.fact_count, 'created_at', new.created_at, 'updated_at', new.updated_at)`,
    )};

    -- Renaming a scene changes its cross-device key; retire the old one.
    CREATE TRIGGER IF NOT EXISTS sync_scene_ak AFTER UPDATE ON l2_scenes
    WHEN ${GUARD} AND (old.name IS NOT new.name OR old.scope IS NOT new.scope OR ifnull(old.project, '') IS NOT ifnull(new.project, ''))
    ${emit(
      'l2_scenes',
      'delete',
      `old.scope || '|' || ifnull(old.project, '') || '|' || old.name`,
      `json_object('scope', old.scope, 'project', old.project, 'name', old.name)`,
      recordTombstone('l2_scenes', `old.scope || '|' || ifnull(old.project, '') || '|' || old.name`),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_scene_ad AFTER DELETE ON l2_scenes
    WHEN ${GUARD}
    ${emit(
      'l2_scenes',
      'delete',
      `old.scope || '|' || ifnull(old.project, '') || '|' || old.name`,
      `json_object('scope', old.scope, 'project', old.project, 'name', old.name)`,
      recordTombstone('l2_scenes', `old.scope || '|' || ifnull(old.project, '') || '|' || old.name`),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_persona_ai AFTER INSERT ON l3_persona
    WHEN ${GUARD}
    ${emit(
      'l3_persona',
      'upsert',
      `new.scope || '|' || ifnull(new.project, '')`,
      `json_object('scope', new.scope, 'project', new.project, 'body', new.body,
        'version', new.version, 'updated_at', new.updated_at)`,
    )};

    CREATE TRIGGER IF NOT EXISTS sync_persona_au AFTER UPDATE ON l3_persona
    WHEN ${GUARD} AND (old.body IS NOT new.body OR old.version IS NOT new.version)
    ${emit(
      'l3_persona',
      'upsert',
      `new.scope || '|' || ifnull(new.project, '')`,
      `json_object('scope', new.scope, 'project', new.project, 'body', new.body,
        'version', new.version, 'updated_at', new.updated_at)`,
    )};

    -- Re-scoping a persona changes its cross-device key; retire the old one.
    CREATE TRIGGER IF NOT EXISTS sync_persona_ak AFTER UPDATE ON l3_persona
    WHEN ${GUARD} AND (old.scope IS NOT new.scope OR ifnull(old.project, '') IS NOT ifnull(new.project, ''))
    ${emit(
      'l3_persona',
      'delete',
      `old.scope || '|' || ifnull(old.project, '')`,
      `json_object('scope', old.scope, 'project', old.project)`,
      recordTombstone('l3_persona', `old.scope || '|' || ifnull(old.project, '')`),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_persona_ad AFTER DELETE ON l3_persona
    WHEN ${GUARD}
    ${emit(
      'l3_persona',
      'delete',
      `old.scope || '|' || ifnull(old.project, '')`,
      `json_object('scope', old.scope, 'project', old.project)`,
      recordTombstone('l3_persona', `old.scope || '|' || ifnull(old.project, '')`),
    )};

    CREATE TRIGGER IF NOT EXISTS sync_history_ai AFTER INSERT ON memory_history
    WHEN ${GUARD}
    ${emit(
      'memory_history',
      'upsert',
      `(SELECT hash FROM memory WHERE id = new.memory_id) || '#' || new.version`,
      `json_object('version', new.version, 'op', new.op, 'text', new.text, 'created_at', new.created_at,
        'hash', (SELECT hash FROM memory WHERE id = new.memory_id))`,
    )};

    -- ── vectors (v4) ─────────────────────────────────────────────────────────
    -- A dirty mark only; the engine reads the blob back when it pushes. The
    -- hash comes from memory because memory_id is local to one database.
    CREATE TRIGGER IF NOT EXISTS sync_emb_ai AFTER INSERT ON memory_embeddings
    WHEN ${GUARD} AND (SELECT hash FROM memory WHERE id = new.memory_id) IS NOT NULL
    ${embMark('new')};

    CREATE TRIGGER IF NOT EXISTS sync_emb_au AFTER UPDATE ON memory_embeddings
    WHEN ${GUARD} AND (SELECT hash FROM memory WHERE id = new.memory_id) IS NOT NULL
      AND (old.vec IS NOT new.vec OR old.text_hash IS NOT new.text_hash OR old.dims IS NOT new.dims)
    ${embMark('new')};

    CREATE TRIGGER IF NOT EXISTS sync_emb_ad AFTER DELETE ON memory_embeddings
    WHEN ${GUARD} AND (SELECT hash FROM memory WHERE id = old.memory_id) IS NOT NULL
    ${embMark('old', 'delete')};
  `)
    if (migrating) {
      setSyncMeta(db, 'schema', SYNC_SCHEMA_VERSION)
      db.exec('COMMIT')
    }
  } catch (error) {
    if (migrating) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the transaction is already gone */
      }
    }
    throw error
  }

  // A crash in the middle of applying remote ops leaves `applying=1` behind, which
  // would silently suppress capture forever after. Opening the database is proof
  // that no apply is in flight.
  db.exec("UPDATE sync_meta SET value = '0' WHERE key = 'applying' AND value = '1'")

  const device = String(db.prepare("SELECT value FROM sync_meta WHERE key = 'device'").get()?.value ?? '')
  return { created: true, device }
}

/**
 * Remove everything this module added. Existing tables are untouched.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function dropSyncSchema(db) {
  for (const name of SYNC_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`)
  for (const name of [...SYNC_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${name}`)
}

/**
 * Read one `sync_meta` value.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function getSyncMeta(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key)
  return row === undefined || row.value === null ? fallback : String(row.value)
}

/**
 * Write one `sync_meta` value.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string|number} value
 */
export function setSyncMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO sync_meta(key, value) VALUES (?, ?)').run(key, String(value))
}

/**
 * Turn capture on or off without dropping the triggers.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {boolean} enabled
 */
export function setSyncEnabled(db, enabled) {
  setSyncMeta(db, 'enabled', enabled ? '1' : '0')
}

/**
 * Every remembered deletion, oldest first so a snapshot replays them in order.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ tbl: string, rowKey: string, lamport: number, device: string, deletedAt: number }>}
 */
export function listTombstones(db) {
  try {
    return db
      .prepare('SELECT tbl, row_key AS rowKey, lamport, device, deleted_at AS deletedAt FROM sync_tombstone ORDER BY deleted_at ASC')
      .all()
      .map((row) => ({
        tbl: String(row.tbl),
        rowKey: String(row.rowKey),
        lamport: Number(row.lamport) || 0,
        device: String(row.device ?? ''),
        deletedAt: Number(row.deletedAt) || 0,
      }))
  } catch {
    return []
  }
}

/**
 * Forget tombstones older than `days`. Kept generous on purpose: a peer that
 * has been offline longer than this cannot be reached anyway, and a tombstone
 * costs 60 bytes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} days
 * @returns {number} rows removed
 */
export function pruneTombstones(db, days) {
  const horizon = Number(days)
  if (!Number.isFinite(horizon) || horizon <= 0) return 0
  try {
    const cutoff = Date.now() - horizon * 86_400_000
    const result = db.prepare('DELETE FROM sync_tombstone WHERE deleted_at < ?').run(cutoff)
    return Number(result.changes ?? 0)
  } catch {
    return 0
  }
}

/**
 * Run `fn` with capture suppressed, so applying remote ops cannot echo.
 * Always restores the previous flag, even when `fn` throws.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withoutCapture(db, fn) {
  const previous = getSyncMeta(db, 'applying', '0')
  setSyncMeta(db, 'applying', '1')
  try {
    return fn()
  } finally {
    setSyncMeta(db, 'applying', previous === '1' ? '1' : '0')
  }
}
