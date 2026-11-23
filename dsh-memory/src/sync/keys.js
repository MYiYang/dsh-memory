/**
 * Cross-device row keys.
 *
 * A local row id (`memory.id = 42`) means nothing on another machine, so every
 * synced table needs a key that both sides can compute from the row itself.
 * `memory` is content-addressed (`hash`), which also makes concurrent writes of
 * the same fact converge without coordination.
 *
 * @module dsh-memory/sync/keys
 */

/**
 * Stable key for a `memory` row.
 * @param {{ hash?: unknown }} row
 * @returns {string}
 */
export function memoryKey(row) {
  return String(row?.hash ?? '')
}

/**
 * Stable key for one L0 turn.
 * @param {{ session_id?: unknown, sessionId?: unknown, turn?: unknown }} row
 * @returns {string}
 */
export function l0Key(row) {
  const session = row?.session_id ?? row?.sessionId ?? ''
  return `${String(session)}#${Number(row?.turn ?? 0)}`
}

/**
 * Stable key for a scene.
 * @param {{ scope?: unknown, project?: unknown, name?: unknown }} row
 * @returns {string}
 */
export function sceneKey(row) {
  return `${String(row?.scope ?? 'project')}|${row?.project === null || row?.project === undefined ? '' : String(row.project)}|${String(row?.name ?? '')}`
}

/**
 * Stable key for a persona (one per scope + project).
 * @param {{ scope?: unknown, project?: unknown }} row
 * @returns {string}
 */
export function personaKey(row) {
  return `${String(row?.scope ?? 'global')}|${row?.project === null || row?.project === undefined ? '' : String(row.project)}`
}

/**
 * Stable key for one history row.
 * @param {string} hash
 * @param {unknown} version
 * @returns {string}
 */
export function historyKey(hash, version) {
  return `${String(hash ?? '')}#${Number(version ?? 0)}`
}

/**
 * Stable key for one embedding row.
 *
 * `memory_id` is local, so the key travels as `memory.hash|model` — the hash is
 * content-addressed and the model tag already encodes its dimensions.
 *
 * @param {{ hash?: unknown, model?: unknown }} row
 * @returns {string}
 */
export function embKey(row) {
  return `${String(row?.hash ?? '')}|${String(row?.model ?? '')}`
}

/**
 * Split an embedding key back into its two halves. The model tag may itself
 * contain `|` in principle, so only the first separator counts.
 *
 * @param {string} key
 * @returns {{ hash: string, model: string }}
 */
export function parseEmbKey(key) {
  const text = String(key ?? '')
  const at = text.indexOf('|')
  if (at < 0) return { hash: text, model: '' }
  return { hash: text.slice(0, at), model: text.slice(at + 1) }
}

/**
 * Split a key back into its parts. Used when applying a remote op that carries
 * only the key (delete ops carry no payload fields).
 *
 * @param {string} tbl
 * @param {string} key
 * @returns {{ hash?: string, model?: string, session?: string, turn?: number, scope?: string, project?: string, name?: string, version?: number }}
 */
export function parseKey(tbl, key) {
  const text = String(key ?? '')
  if (tbl === 'memory') return { hash: text }
  if (tbl === 'memory_embeddings') return parseEmbKey(text)
  if (tbl === 'l0_turns') {
    const at = text.lastIndexOf('#')
    return at < 0 ? { session: text, turn: 0 } : { session: text.slice(0, at), turn: Number(text.slice(at + 1)) }
  }
  if (tbl === 'l2_scenes') {
    const parts = text.split('|')
    return { scope: parts[0] ?? 'project', project: parts[1] ?? '', name: parts.slice(2).join('|') }
  }
  if (tbl === 'l3_persona') {
    const [scope, project] = text.split('|')
    return { scope: scope ?? 'global', project: project ?? '' }
  }
  if (tbl === 'memory_history') {
    const at = text.lastIndexOf('#')
    return at < 0 ? { hash: text } : { hash: text.slice(0, at), version: Number(text.slice(at + 1)) }
  }
  return {}
}
