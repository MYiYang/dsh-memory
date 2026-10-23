/**
 * L0: the raw turn archive and the per-session extraction cursor.
 *
 * L0 is append-only evidence: each completed turn stores the (unclipped-ish)
 * user/assistant text plus tool names. L1 extraction reads the `extracted_at
 * IS NULL` rows and marks them afterwards, so a crash or an LLM failure never
 * loses the raw turn — it is just retried on the next trigger.
 *
 * @module dsh-memory/l0
 */

/** Per-turn caps for the archive; large enough to keep evidence, small enough to bound the DB. */
export const L0_CAPS = { user: 12_000, assistant: 16_000, transcript: 8_000 }

/**
 * Clip a string, keeping the head.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
export function clip(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * Append one completed turn. Idempotent on (session_id, turn): replaying a
 * session event never duplicates the row.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   turn: number,
 *   project?: string|null,
 *   userText?: string,
 *   assistantText?: string,
 *   toolNames?: string[],
 *   seqFrom?: number|null,
 *   seqTo?: number|null,
 * }} input
 * @param {number} [now]
 * @returns {{ inserted: boolean, id: number }}
 */
export function appendTurn(db, input, now = Date.now()) {
  const sessionId = String(input.sessionId ?? '')
  if (sessionId === '') throw new Error('appendTurn: sessionId is required')
  const turn = Number(input.turn)
  if (!Number.isInteger(turn) || turn < 0) throw new Error('appendTurn: turn must be a non-negative integer')
  const toolNames = Array.isArray(input.toolNames) ? input.toolNames.slice(0, 16).map(String) : []
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO l0_turns
         (session_id, turn, project, user_text, assistant_text, tool_names, seq_from, seq_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      turn,
      input.project ?? null,
      clip(input.userText, L0_CAPS.user),
      clip(input.assistantText, L0_CAPS.assistant),
      JSON.stringify(toolNames),
      input.seqFrom ?? null,
      input.seqTo ?? null,
      now,
    )
  const row = db
    .prepare('SELECT id FROM l0_turns WHERE session_id = ? AND turn = ?')
    .get(sessionId, turn)
  return { inserted: Number(result.changes) > 0, id: Number(row?.id ?? 0) }
}

/**
 * Turns not yet handed to L1 extraction, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {number} [limit]
 * @returns {Array<Record<string, any>>}
 */
export function pendingTurns(db, sessionId, limit = 20) {
  return db
    .prepare(
      `SELECT * FROM l0_turns
        WHERE session_id = ? AND extracted_at IS NULL
        ORDER BY id
        LIMIT ?`,
    )
    .all(sessionId, Math.max(1, Math.min(100, limit)))
}

/**
 * Sessions that still have un-extracted turns, oldest backlog first.
 *
 * Used by the manual `memory_extract` maintenance path: the idle scheduler is
 * process-local, so after a restart nothing ever retries a session that is no
 * longer active. This query is what lets the user drain that backlog.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [limit]
 * @returns {Array<{ sessionId: string, pending: number, firstId: number }>}
 */
export function pendingSessionIds(db, limit = 20) {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS pending, MIN(id) AS first_id
         FROM l0_turns WHERE extracted_at IS NULL
        GROUP BY session_id ORDER BY first_id
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit)))
  return rows.map((row) => ({
    sessionId: String(row.session_id),
    pending: Number(row.pending ?? 0),
    firstId: Number(row.first_id ?? 0),
  }))
}

/**
 * Number of turns waiting for extraction in one session.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {number}
 */
export function pendingCount(db, sessionId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM l0_turns WHERE session_id = ? AND extracted_at IS NULL')
    .get(sessionId)
  return Number(row?.n ?? 0)
}

/**
 * Mark turns as handled. `discarded` also marks them extracted so a poison
 * batch cannot loop forever; the reason is recorded separately by the caller.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @param {number} [now]
 * @returns {number}
 */
export function markTurnsExtracted(db, ids, now = Date.now()) {
  const list = ids.filter((id) => Number.isInteger(id) && id > 0)
  if (list.length === 0) return 0
  const placeholders = list.map(() => '?').join(',')
  const result = db
    .prepare(`UPDATE l0_turns SET extracted_at = ? WHERE id IN (${placeholders})`)
    .run(now, ...list)
  return Number(result.changes)
}

/**
 * Count one failed extraction attempt per turn.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @returns {number}
 */
export function bumpAttempts(db, ids) {
  const list = ids.filter((id) => Number.isInteger(id) && id > 0)
  if (list.length === 0) return 0
  const placeholders = list.map(() => '?').join(',')
  const result = db
    .prepare(`UPDATE l0_turns SET extract_attempts = extract_attempts + 1 WHERE id IN (${placeholders})`)
    .run(...list)
  return Number(result.changes)
}

/**
 * Read one session cursor, creating the row on first use.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {number} [now]
 * @returns {{
 *   sessionId: string, lastTurn: number, sinceExtract: number,
 *   threshold: number, pendingSince: number|null
 * }}
 */
export function getCursor(db, sessionId, now = Date.now()) {
  let row = db.prepare('SELECT * FROM l0_cursor WHERE session_id = ?').get(sessionId)
  if (row === undefined) {
    db.prepare('INSERT OR IGNORE INTO l0_cursor(session_id, updated_at) VALUES (?, ?)').run(sessionId, now)
    row = db.prepare('SELECT * FROM l0_cursor WHERE session_id = ?').get(sessionId)
  }
  return {
    sessionId,
    lastTurn: Number(row?.last_turn ?? 0),
    sinceExtract: Number(row?.conversations_since_extract ?? 0),
    threshold: Number(row?.threshold ?? 1),
    pendingSince: row?.pending_since === null || row?.pending_since === undefined ? null : Number(row.pending_since),
  }
}

/**
 * Patch one cursor row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {{ lastTurn?: number, sinceExtract?: number, threshold?: number, pendingSince?: number|null }} patch
 * @param {number} [now]
 */
export function updateCursor(db, sessionId, patch, now = Date.now()) {
  getCursor(db, sessionId, now)
  const sets = []
  const params = []
  if (patch.lastTurn !== undefined) {
    sets.push('last_turn = ?')
    params.push(patch.lastTurn)
  }
  if (patch.sinceExtract !== undefined) {
    sets.push('conversations_since_extract = ?')
    params.push(patch.sinceExtract)
  }
  if (patch.threshold !== undefined) {
    sets.push('threshold = ?')
    params.push(patch.threshold)
  }
  if (patch.pendingSince !== undefined) {
    sets.push('pending_since = ?')
    params.push(patch.pendingSince)
  }
  sets.push('updated_at = ?')
  params.push(now)
  params.push(sessionId)
  db.prepare(`UPDATE l0_cursor SET ${sets.join(', ')} WHERE session_id = ?`).run(...params)
}

/**
 * Drop old extracted turns, keeping the newest `keep` per session.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {number} [keep]
 * @returns {number} rows deleted
 */
export function pruneTurns(db, sessionId, keep = 5000) {
  const result = db
    .prepare(
      `DELETE FROM l0_turns
        WHERE session_id = ? AND extracted_at IS NOT NULL
          AND id NOT IN (
            SELECT id FROM l0_turns
             WHERE session_id = ? AND extracted_at IS NOT NULL
             ORDER BY id DESC LIMIT ?
          )`,
    )
    .run(sessionId, sessionId, Math.max(1, keep))
  return Number(result.changes)
}

/**
 * Render pending turns as the transcript an extraction prompt receives.
 * Keeps the newest turns that fit the budget, then restores chronological
 * order; each turn is clipped so one huge answer cannot crowd out the rest.
 *
 * @param {Array<Record<string, any>>} turns
 * @param {{ maxChars?: number, perTurn?: number }} [options]
 * @returns {{ text: string, used: Array<Record<string, any>>, clipped: boolean }}
 */
export function buildTranscript(turns, options = {}) {
  const maxChars = Math.max(50, options.maxChars ?? L0_CAPS.transcript)
  const perTurn = Math.max(30, options.perTurn ?? 1_600)
  /** @type {string[]} */
  const parts = []
  /** @type {Array<Record<string, any>>} */
  const used = []
  let size = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const row = turns[i]
    let tools = []
    try {
      tools = JSON.parse(row.tool_names ?? '[]')
    } catch {
      tools = []
    }
    const header = `#${row.turn}${tools.length > 0 ? ` [tool: ${tools.join(', ')}]` : ''}`
    const segment = [header, `用户: ${clip(row.user_text, perTurn)}`, `助手: ${clip(row.assistant_text, perTurn)}`].join('\n')
    if (size + segment.length > maxChars && used.length > 0) break
    parts.push(segment)
    used.push(row)
    size += segment.length + 2
  }
  return { text: parts.reverse().join('\n\n'), used: used.reverse(), clipped: used.length < turns.length }
}
