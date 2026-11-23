/**
 * Applying remote ops locally.
 *
 * Conflict policy is last-writer-wins per row, ordered by `(lamport, device)`
 * and remembered in `sync_rowstate`. Memory rows are keyed by their content
 * hash, so two devices that learn the same fact converge without coordination.
 *
 * Three details that matter:
 *   - `use_count` / `last_used_at` / vectors are **local**; a remote upsert never
 *     overwrites them.
 *   - a supersede op whose target has not arrived yet is parked in
 *     `sync_pending` instead of being dropped.
 *   - the previous row state is written to `sync_undo` so one op can be undone.
 *
 * @module dsh-memory/sync/apply
 */
import { saveMemory } from '../store.js'
import { historyKey, parseKey, personaKey, sceneKey } from './keys.js'
import { getSyncMeta, setSyncMeta, withoutCapture } from './schema.js'
import { decodeVector } from './vectors.js'

/** @typedef {{ opId: string, tbl: string, key: string, op: string, lamport: number, device: string, payload: any, createdAt: number }} SyncOp */

/**
 * @param {number} lamport
 * @param {string} device
 * @returns {[number, string]}
 */
function stamp(lamport, device) {
  return [Number(lamport) || 0, String(device ?? '')]
}

/**
 * Is the incoming stamp newer than the stored one?
 * @param {[number, string]} incoming
 * @param {[number, string] | null} current
 * @returns {boolean}
 */
function isNewer(incoming, current) {
  if (current === null) return true
  if (incoming[0] !== current[0]) return incoming[0] > current[0]
  return incoming[1] > current[1]
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} tbl
 * @param {string} rowKey
 * @returns {[number, string] | null}
 */
function readState(db, tbl, rowKey) {
  const row = db.prepare('SELECT lamport, device FROM sync_rowstate WHERE tbl = ? AND row_key = ?').get(tbl, rowKey)
  return row === undefined ? null : [Number(row.lamport), String(row.device)]
}

/**
 * /**
 * Remember a deletion for this key. Applied deletes must leave the same mark a
 * local delete would, or a stale segment/snapshot could re-insert the row.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} tbl
 * @param {string} rowKey
 * @param {number} lamport
 * @param {string} device
 */
function recordTombstone(db, tbl, rowKey, lamport, device) {
  db.prepare('INSERT OR REPLACE INTO sync_tombstone (tbl, row_key, lamport, device, deleted_at) VALUES (?, ?, ?, ?, ?)').run(
    String(tbl),
    String(rowKey),
    Number(lamport) || 0,
    String(device ?? ''),
    Date.now(),
  )
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 */
function writeState(db, op) {
  db.prepare(
    `INSERT INTO sync_rowstate (tbl, row_key, lamport, device, op, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tbl, row_key) DO UPDATE SET
       lamport = excluded.lamport, device = excluded.device, op = excluded.op, updated_at = excluded.updated_at`,
  ).run(op.tbl, op.key, Number(op.lamport) || 0, String(op.device ?? ''), String(op.op), Date.now())
}

/**
 * Remember what a row looked like before we overwrite it, so `undo` can restore it.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {Record<string, any> | null} before
 */
function recordUndo(db, op, before) {
  db.prepare('INSERT OR REPLACE INTO sync_undo (op_id, tbl, row_key, before, applied_at) VALUES (?, ?, ?, ?, ?)').run(
    op.opId,
    op.tbl,
    op.key,
    before === null ? null : JSON.stringify(before),
    Date.now(),
  )
}

/**
 * Apply one op. Returns what happened; never throws for data-level problems
 * (caller counts them and moves on).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @returns {'applied' | 'skipped' | 'pending' | 'conflict' | 'failed'}
 */
export function applyOp(db, op) {
  const lamport = Number(op.lamport) || 0
  const device = String(op.device ?? '')
  const incoming = stamp(lamport, device)
  const payload = op.payload ?? {}

  if (op.tbl === 'memory') return applyMemory(db, op, incoming)
  if (op.tbl === 'memory_history') return applyHistory(db, op, incoming)
  if (op.tbl === 'l0_turns') return applyTurn(db, op, incoming)
  if (op.tbl === 'l2_scenes') return applyScene(db, op, incoming, payload)
  if (op.tbl === 'l3_persona') return applyPersona(db, op, incoming, payload)
  if (op.tbl === 'memory_embeddings') return applyEmbedding(db, op, incoming)
  return 'skipped'
}

/**
 * Wire "row X is superseded by row Y" for one key, parking it when Y has not
 * arrived yet. Used by both the insert and the update branch: a snapshot writes
 * rows in table order, so the retired row usually lands before its replacement.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {Record<string, any>} payload
 * @returns {'applied' | 'pending' | 'skipped'}
 */
function applySupersede(db, op, payload) {
  const byHash = String(payload.superseded_by_hash)
  const self = db.prepare('SELECT id FROM memory WHERE hash = ?').get(op.key)
  if (self === undefined) return 'skipped'
  const target = db.prepare('SELECT id FROM memory WHERE hash = ?').get(byHash)
  if (target === undefined) {
    db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
      `${op.opId}:supersede`,
      JSON.stringify({ hash: op.key, byHash }),
      'supersede-target-missing',
      Date.now(),
    )
    return 'pending'
  }
  db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(target.id, self.id)
  return 'applied'
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 */
function applyMemory(db, op, incoming) {
  const payload = op.payload ?? {}
  const existing = db.prepare('SELECT * FROM memory WHERE hash = ?').get(op.key)

  if (op.op === 'delete') {
    if (existing === undefined) {
      if (!isNewer(incoming, readState(db, 'memory', op.key))) return 'conflict'
      recordTombstone(db, 'memory', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
      writeState(db, op)
      return 'skipped'
    }
    if (!isNewer(incoming, readState(db, 'memory', op.key))) return 'conflict'
    recordUndo(db, op, existing)
    db.prepare('DELETE FROM memory WHERE id = ?').run(existing.id)
    recordTombstone(db, 'memory', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
    writeState(db, op)
    return 'applied'
  }

  if (existing === undefined) {
    // The key may have been deleted here or on a peer; a stale segment must not
    // bring it back. Local captures now write rowstate, so this check is real.
    const previous = readState(db, 'memory', op.key)
    if (previous !== null && !isNewer(incoming, previous)) return 'conflict'
    if (typeof payload.text !== 'string' || payload.text.trim() === '') return 'failed'
    const created = saveMemory(
      db,
      {
        text: payload.text,
        kind: payload.kind,
        scope: payload.scope,
        project: payload.project,
        sessionId: payload.session_id,
        title: payload.title,
        tags: Array.isArray(payload.tags) ? payload.tags : safeArray(payload.tags),
        source: payload.source,
        pinned: payload.pinned === 1 || payload.pinned === true,
      },
      Number(payload.created_at) || Date.now(),
    )
    recordUndo(db, op, null)
    db.prepare(
      `UPDATE memory SET priority = ?, version = ?, scene = ?, source_seqs = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      Number(payload.priority ?? 50),
      Number(payload.version ?? 1),
      payload.scene ?? null,
      payload.source_seqs ?? null,
      Number(payload.updated_at) || Date.now(),
      created.id,
    )
    writeState(db, op)
    if (payload.superseded_by_hash) {
      return applySupersede(db, op, payload) === 'pending' ? 'pending' : 'applied'
    }
    return 'applied'
  }

  if (!isNewer(incoming, readState(db, 'memory', op.key))) return 'conflict'
  recordUndo(db, op, existing)
  db.prepare(
    `UPDATE memory SET kind = ?, scope = ?, project = ?, title = ?, text = ?, tags = ?, source = ?,
        priority = ?, pinned = ?, version = ?, scene = ?, source_seqs = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    String(payload.kind ?? existing.kind),
    String(payload.scope ?? existing.scope),
    payload.project ?? null,
    String(payload.title ?? existing.title),
    String(payload.text ?? existing.text),
    typeof payload.tags === 'string' ? payload.tags : JSON.stringify(payload.tags ?? []),
    String(payload.source ?? existing.source),
    Number(payload.priority ?? existing.priority),
    payload.pinned === true || payload.pinned === 1 ? 1 : 0,
    Number(payload.version ?? existing.version ?? 1),
    payload.scene ?? null,
    payload.source_seqs ?? null,
    Number(payload.updated_at) || Date.now(),
    existing.id,
  )
  writeState(db, op)
  if (payload.superseded_by_hash) return applySupersede(db, op, payload) === 'pending' ? 'pending' : 'applied'
  return 'applied'
}

/**
 * Apply one vector row.
 *
 * The op carries `memory.hash|model` rather than `memory_id`, because ids are
 * local. When the fact itself has not arrived yet (a snapshot is applied
 * memory-first, but segments are not ordered), the op is parked and retried by
 * `drainPending` — a vector with no fact to point at is not an error, it is a
 * message that overtook its subject.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 * @returns {'applied' | 'skipped' | 'pending' | 'conflict' | 'failed'}
 */
function applyEmbedding(db, op, incoming) {
  const payload = op.payload ?? {}
  const parsed = parseKey('memory_embeddings', op.key)
  const hash = String(payload.hash ?? parsed.hash ?? '')
  const model = String(payload.model ?? parsed.model ?? '')
  if (hash === '' || model === '') return 'failed'
  const local = db.prepare('SELECT id FROM memory WHERE hash = ?').get(hash)
  if (local === undefined) {
    if (op.op === 'delete') return 'skipped'
    db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
      `${op.opId}:emb`,
      JSON.stringify({ kind: 'emb', op }),
      'emb-target-missing',
      Date.now(),
    )
    return 'pending'
  }
  const existing = db
    .prepare('SELECT dims, text_hash FROM memory_embeddings WHERE memory_id = ? AND model = ?')
    .get(local.id, model)
  if (op.op === 'delete') {
    if (existing === undefined) {
      writeState(db, op)
      return 'skipped'
    }
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ? AND model = ?').run(local.id, model)
    writeState(db, op)
    return 'applied'
  }
  if (!isNewer(incoming, readState(db, 'memory_embeddings', op.key))) return 'conflict'
  if (existing !== undefined && String(existing.text_hash ?? '') === String(payload.text_hash ?? '')) {
    // Same text, same vector: a duplicate upload or a replayed segment. Do not
    // rewrite 16 KB per row for nothing.
    writeState(db, op)
    return 'skipped'
  }
  const dims = Number(payload.dims) || 0
  let blob
  try {
    blob = decodeVector(String(payload.vec ?? ''), dims, /** @type {'f32'|'f16'|'i8'} */ (String(payload.codec ?? 'f32')))
  } catch {
    return 'failed'
  }
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dims, text_hash, vec, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(local.id, model, dims, String(payload.text_hash ?? ''), blob, Number(payload.created_at) || Date.now())
  writeState(db, op)
  return 'applied'
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 */
function applyHistory(db, op, incoming) {
  const payload = op.payload ?? {}
  const hash = String(payload.hash ?? parseKey('memory_history', op.key).hash ?? '')
  const local = db.prepare('SELECT id FROM memory WHERE hash = ?').get(hash)
  if (local === undefined) {
    // Park it rather than lose it: the memory row may still be in flight (a
    // snapshot whose parts were replayed out of order, or a peer that pushed
    // history before the fact). `drainPending` retries once the fact lands.
    db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
      `${op.opId}:history`,
      JSON.stringify({ kind: 'history', op }),
      'history-target-missing',
      Date.now(),
    )
    return 'pending'
  }
  const version = Number(payload.version ?? parseKey('memory_history', op.key).version ?? 0)
  const exists = db.prepare('SELECT 1 AS ok FROM memory_history WHERE memory_id = ? AND version = ?').get(local.id, version)
  if (exists !== undefined) return 'skipped'
  db.prepare('INSERT INTO memory_history (memory_id, version, op, text, created_at) VALUES (?, ?, ?, ?, ?)').run(
    local.id,
    version,
    String(payload.op ?? 'update'),
    String(payload.text ?? ''),
    Number(payload.created_at) || Date.now(),
  )
  writeState(db, { ...op, key: historyKey(hash, version) })
  return 'applied'
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 */
function applyTurn(db, op, incoming) {
  const payload = op.payload ?? {}
  const { session, turn } = parseKey('l0_turns', op.key)
  const exists = db.prepare('SELECT 1 AS ok FROM l0_turns WHERE session_id = ? AND turn = ?').get(session, turn)
  if (exists !== undefined) return 'skipped'
  db.prepare(
    `INSERT OR IGNORE INTO l0_turns (session_id, turn, project, user_text, assistant_text, tool_names, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(payload.session_id ?? session ?? ''),
    Number(payload.turn ?? turn ?? 0),
    payload.project ?? null,
    String(payload.user_text ?? ''),
    String(payload.assistant_text ?? ''),
    String(payload.tool_names ?? '[]'),
    Number(payload.created_at) || Date.now(),
  )
  writeState(db, op)
  return 'applied'
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 * @param {Record<string, any>} payload
 */
function applyScene(db, op, incoming, payload) {
  // The op key is authoritative: a delete payload may omit scope/project (it is
  // the key itself), and guessing defaults would miss a project-scoped row.
  const keyParts = parseKey('l2_scenes', op.key)
  const sceneScope = String(payload.scope ?? keyParts.scope ?? 'project')
  const sceneProject = payload.project ?? (keyParts.project === '' ? null : keyParts.project)
  const sceneName = String(payload.name ?? keyParts.name ?? '')
  const exists = db.prepare("SELECT * FROM l2_scenes WHERE scope = ? AND ifnull(project,'') = ? AND name = ?").get(
    sceneScope,
    String(sceneProject ?? ''),
    sceneName,
  )
  if (op.op === 'delete') {
    if (exists === undefined) {
      if (!isNewer(incoming, readState(db, 'l2_scenes', op.key))) return 'conflict'
      recordTombstone(db, 'l2_scenes', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
      writeState(db, op)
      return 'skipped'
    }
    if (!isNewer(incoming, readState(db, 'l2_scenes', op.key))) return 'conflict'
    recordUndo(db, op, exists)
    db.prepare('DELETE FROM l2_scenes WHERE id = ?').run(exists.id)
    recordTombstone(db, 'l2_scenes', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
    writeState(db, op)
    return 'applied'
  }
  if (exists === undefined) {
    const previous = readState(db, 'l2_scenes', op.key)
    if (previous !== null && !isNewer(incoming, previous)) return 'conflict'
    const result = db
      .prepare(
        `INSERT INTO l2_scenes (scope, project, name, summary, body, heat, fact_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(payload.scope ?? 'project'),
        payload.project ?? null,
        String(payload.name ?? ''),
        String(payload.summary ?? ''),
        String(payload.body ?? ''),
        Number(payload.heat ?? 1),
        Number(payload.fact_count ?? 0),
        Number(payload.created_at) || Date.now(),
        Number(payload.updated_at) || Date.now(),
      )
    recordUndo(db, op, null)
    writeState(db, op)
    void result
    return 'applied'
  }
  if (!isNewer(incoming, readState(db, 'l2_scenes', op.key))) return 'conflict'
  recordUndo(db, op, exists)
  db.prepare(
    `UPDATE l2_scenes SET summary = ?, body = ?, heat = MAX(heat, ?), fact_count = MAX(fact_count, ?), updated_at = ?
      WHERE id = ?`,
  ).run(
    String(payload.summary ?? exists.summary),
    String(payload.body ?? exists.body),
    Number(payload.heat ?? 1),
    Number(payload.fact_count ?? 0),
    Number(payload.updated_at) || Date.now(),
    exists.id,
  )
  writeState(db, op)
  return 'applied'
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp} op
 * @param {[number, string]} incoming
 * @param {Record<string, any>} payload
 */
function applyPersona(db, op, incoming, payload) {
  const keyParts = parseKey('l3_persona', op.key)
  const scope = String(payload.scope ?? keyParts.scope ?? 'global')
  const project = payload.project ?? (keyParts.project === '' ? null : keyParts.project)
  const exists = db.prepare("SELECT * FROM l3_persona WHERE scope = ? AND ifnull(project,'') = ?").get(scope, String(project ?? ''))
  if (op.op === 'delete') {
    if (exists === undefined) {
      if (!isNewer(incoming, readState(db, 'l3_persona', op.key))) return 'conflict'
      recordTombstone(db, 'l3_persona', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
      writeState(db, op)
      return 'skipped'
    }
    if (!isNewer(incoming, readState(db, 'l3_persona', op.key))) return 'conflict'
    recordUndo(db, op, exists)
    db.prepare('DELETE FROM l3_persona WHERE id = ?').run(exists.id)
    recordTombstone(db, 'l3_persona', op.key, Number(op.lamport) || 0, String(op.device ?? ''))
    writeState(db, op)
    return 'applied'
  }
  if (exists !== undefined && Number(payload.version ?? 0) < Number(exists.version ?? 0)) return 'conflict'
  // Equal versions with different bodies means two devices rewrote the persona
  // independently; the stamp decides instead of both sides refusing forever.
  if (!isNewer(incoming, readState(db, 'l3_persona', op.key))) return 'conflict'
  recordUndo(db, op, exists ?? null)
  if (exists === undefined) {
    db.prepare('INSERT INTO l3_persona (scope, project, body, version, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      scope,
      project,
      String(payload.body ?? ''),
      Number(payload.version ?? 1),
      Number(payload.updated_at) || Date.now(),
    )
  } else {
    db.prepare('UPDATE l3_persona SET body = ?, version = ?, updated_at = ? WHERE id = ?').run(
      String(payload.body ?? exists.body),
      Number(payload.version ?? exists.version),
      Number(payload.updated_at) || Date.now(),
      exists.id,
    )
  }
  writeState(db, op)
  return 'applied'
}

/**
 * Apply a batch inside one transaction with capture suppressed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {SyncOp[]} ops
 * @returns {{ applied: number, skipped: number, conflicts: number, pending: number, failed: number }}
 */
export function applyOps(db, ops) {
  const counts = { applied: 0, skipped: 0, conflicts: 0, pending: 0, failed: 0 }
  if (!Array.isArray(ops) || ops.length === 0) return counts
  withoutCapture(db, () => {
    db.exec('BEGIN')
    try {
      for (const op of ops) {
        let outcome = 'failed'
        try {
          outcome = applyOp(db, op)
        } catch {
          outcome = 'failed'
        }
        if (outcome === 'applied') counts.applied += 1
        else if (outcome === 'skipped') counts.skipped += 1
        else if (outcome === 'conflict') counts.conflicts += 1
        else if (outcome === 'pending') counts.pending += 1
        else counts.failed += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  return counts
}

/**
 * Retry parked supersede ops now that more rows may be present.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} resolved count
 */
export function drainPending(db) {
  const rows = db.prepare('SELECT op_id AS opId, payload FROM sync_pending').all()
  let resolved = 0
  for (const row of rows) {
    let parsed
    try {
      parsed = JSON.parse(String(row.payload))
    } catch {
      db.prepare('DELETE FROM sync_pending WHERE op_id = ?').run(row.opId)
      continue
    }
    if (parsed?.kind === 'history' && parsed?.op !== undefined && parsed.op !== null) {
      const op = parsed.op
      const outcome = applyHistory(db, op, stamp(Number(op.lamport) || 0, String(op.device ?? '')))
      if (outcome === 'applied' || outcome === 'skipped') {
        db.prepare('DELETE FROM sync_pending WHERE op_id = ?').run(row.opId)
        resolved += 1
      }
      continue
    }
    if (parsed?.kind === 'emb' && parsed?.op !== undefined && parsed.op !== null) {
      const op = parsed.op
      let outcome = 'failed'
      withoutCapture(db, () => {
        outcome = applyEmbedding(db, op, stamp(Number(op.lamport) || 0, String(op.device ?? '')))
      })
      if (outcome === 'applied' || outcome === 'skipped' || outcome === 'conflict') {
        db.prepare('DELETE FROM sync_pending WHERE op_id = ?').run(row.opId)
        resolved += 1
      }
      continue
    }
    if (parsed?.hash === undefined || parsed?.byHash === undefined) continue
    const target = db.prepare('SELECT id FROM memory WHERE hash = ?').get(String(parsed.hash))
    const by = db.prepare('SELECT id FROM memory WHERE hash = ?').get(String(parsed.byHash))
    if (target === undefined || by === undefined) continue
    withoutCapture(db, () => {
      db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(by.id, target.id)
    })
    db.prepare('DELETE FROM sync_pending WHERE op_id = ?').run(row.opId)
    resolved += 1
  }
  return resolved
}

/**
 * Undo one applied op by restoring its before-image.
 *
 * The restoration is itself a local write, so it produces a compensating op
 * that propagates to peers (capture is *on* here on purpose).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} opId
 * @returns {boolean}
 */
export function undoOp(db, opId) {
  const row = db.prepare('SELECT * FROM sync_undo WHERE op_id = ?').get(opId)
  if (row === undefined) return false
  const before = row.before === null ? null : JSON.parse(String(row.before))
  if (row.tbl === 'memory') {
    const current = db.prepare('SELECT id FROM memory WHERE hash = ?').get(row.row_key)
    if (before === null) {
      if (current !== undefined) db.prepare('DELETE FROM memory WHERE id = ?').run(current.id)
    } else if (current === undefined) {
      saveMemory(db, {
        text: String(before.text ?? ''),
        kind: before.kind,
        scope: before.scope,
        project: before.project,
        title: before.title,
        tags: safeArray(before.tags),
        source: before.source,
        pinned: before.pinned === 1,
      })
    } else {
      db.prepare(
        `UPDATE memory SET kind = ?, scope = ?, project = ?, title = ?, text = ?, tags = ?, priority = ?,
            pinned = ?, version = ?, scene = ?, source_seqs = ?, updated_at = ? WHERE id = ?`,
      ).run(
        String(before.kind ?? 'fact'),
        String(before.scope ?? 'global'),
        before.project ?? null,
        String(before.title ?? ''),
        String(before.text ?? ''),
        String(before.tags ?? '[]'),
        Number(before.priority ?? 50),
        Number(before.pinned ?? 0),
        Number(before.version ?? 1),
        before.scene ?? null,
        before.source_seqs ?? null,
        Date.now(),
        current.id,
      )
    }
  }
  db.prepare('DELETE FROM sync_undo WHERE op_id = ?').run(opId)
  return true
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function safeArray(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

export { sceneKey, personaKey }
