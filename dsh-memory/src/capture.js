/**
 * Capture: turn raw DSH messages into compact, searchable episodes.
 *
 * An episode is one completed exchange (`用户: …` / `助手: …`) trimmed for
 * retrieval: long tool outputs and code dumps are clipped so the episode stays
 * useful for recall instead of eating the FTS index.
 *
 * @module dsh-memory/capture
 */
import { saveMemory, textHash } from './store.js'

/** Per-turn character caps (episode text / user text / assistant text). */
export const TURN_CAPS = { episode: 2400, user: 1200, assistant: 1200 }

/**
 * Extract plain text from a DSH/LLM content value.
 *
 * Accepts a string, an array of content blocks (anthropic style
 * `{type:'text',text}` / OpenAI style `{type:'input_text'|'output_text'}`),
 * or an object with `text`/`content`.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function extractText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (block === null || typeof block !== 'object') continue
      const type = String(block.type ?? '')
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        if (typeof block.text === 'string') parts.push(block.text)
      } else if (type === 'thinking' || type === 'reasoning') {
        continue // never store model scratchpad
      } else if (type === 'tool_use' || type === 'tool_result') {
        continue // tool payloads are noise for recall
      } else if (typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object') {
    const record = /** @type {{text?: unknown, content?: unknown}} */ (content)
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return extractText(record.content)
  }
  return ''
}

/**
 * Clip text to a limit, keeping the head and adding an ellipsis marker.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clip(text, limit) {
  const value = String(text ?? '').trim()
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * Build the episode body for one turn. Returns null when the turn carries no
 * durable value (empty exchange, pure tool call, command ack).
 *
 * @param {{ userText: string, assistantText: string, toolNames?: string[] }} turn
 * @returns {string|null}
 */
export function buildEpisodeText(turn) {
  const user = clip(turn.userText ?? '', TURN_CAPS.user)
  const assistant = clip(turn.assistantText ?? '', TURN_CAPS.assistant)
  if (user === '' && assistant === '') return null
  // A bare slash-command or one-word ack is not worth an episode
  if (user.length < 6 && assistant.length < 40) return null
  const tools = Array.isArray(turn.toolNames) && turn.toolNames.length > 0
    ? `工具: ${[...new Set(turn.toolNames)].slice(0, 8).join(', ')}\n`
    : ''
  const body = [user === '' ? '' : `用户: ${user}`, assistant === '' ? '' : `助手: ${assistant}`, tools]
    .filter((line) => line !== '')
    .join('\n')
  return clip(body, TURN_CAPS.episode)
}

/**
 * Persist one turn as an episode. Idempotent per (session, text).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId?: string|null,
 *   project?: string|null,
 *   userText: string,
 *   assistantText: string,
 *   toolNames?: string[],
 *   title?: string,
 *   now?: number,
 * }} turn
 * @returns {{ id: number, inserted: boolean } | null}
 */
export function captureTurn(db, turn) {
  const text = buildEpisodeText(turn)
  if (text === null) return null
  const title = clip(turn.title ?? firstLine(turn.userText), 80)
  const scope = turn.project ? 'project' : 'global'
  return saveMemory(
    db,
    {
      kind: 'episode',
      scope,
      project: turn.project ?? null,
      sessionId: turn.sessionId ?? null,
      text,
      title,
      source: 'turn',
      tags: turn.toolNames ? [...new Set(turn.toolNames)].slice(0, 8) : [],
    },
    turn.now ?? Date.now(),
  )
}

/**
 * First non-empty line of `text`, clipped.
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/).find((value) => value.trim() !== '') ?? ''
  return line.trim().slice(0, 80)
}

/**
 * True when the same exact turn text is already stored (cheap pre-check used
 * by the plugin to avoid re-writing an unchanged final turn).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text
 * @returns {boolean}
 */
export function episodeExists(db, text) {
  const row = db.prepare('SELECT 1 AS hit FROM memory WHERE hash = ? LIMIT 1').get(textHash(text))
  return row !== undefined
}
