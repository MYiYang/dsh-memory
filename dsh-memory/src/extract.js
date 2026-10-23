/**
 * L1 extraction: prompt contracts, tolerant JSON parsing, and the mapping from
 * model output to store decisions.
 *
 * This module is pure (no cordis, no network) so every branch is unit-testable
 * with canned model output. The LLM call itself lives in `llm.js`; wiring lives
 * in `index.js` / `pipeline.js`.
 *
 * @module dsh-memory/extract
 */
import { applyDecision, decideHeuristically, findCandidates, normalizeKind, clampPriority } from './l1.js'

/** Hard caps for one extraction batch. */
export const EXTRACT_LIMITS = { memories: 10, text: 400, scene: 40, candidates: 4 }

/** Closed set recorded in `meta['l1-last-reason']` for grepping. */
export const EXTRACT_REASONS = /** @type {const} */ (['ok', 'empty', 'parse', 'timeout', 'llm_error', 'filtered'])

/** System prompt: fixed contract, no conversation content. */
export const EXTRACTION_SYSTEM = [
  '你是记忆整理器。只输出 JSON，不要解释、不要 markdown 围栏。',
  '任务：从一段对话里抽取值得长期记住的原子事实，每条不超过 200 字。',
  'kind 只能是：',
  '- persona：用户/团队的长期偏好或身份（如「偏好 pwsh」「中文交流」）',
  '- instruction：明确要求以后遵守的规则（如「不要自动 git push」）',
  '- work_fact：项目事实（技术栈、目录、端口、数据源）',
  '- work_method：跑通过的方法/流程（命令、步骤、坑）',
  '- work_task：进行中的任务状态（做到哪、下一步）',
  '- work_artifact：产物位置（文件、表、服务、URL）',
  '- episodic：一次性事件（某天做了什么）',
  'priority 0-100：长期偏好/硬规则 80+；项目事实 60-79；任务状态 40-59；一次性事件 10-39。',
  '跨项目成立的偏好（称呼、语言、语气、沟通风格）写成不绑定某个项目的通用表述，避免同一约定在每个项目各存一份。',
  '如果这条偏好/规则在任何项目里都成立（称呼、语言、语气、身份、通用硬规则），加 "scope":"global"；其余一律省略（默认项目内）。',
  'scene 是 2-6 个字的场景名（如「构建与工具链」「数据库」「部署」）。',
  '不要抽取：寒暄、临时调试输出、模型推理过程、重复内容。',
  '输出格式：{"memories":[{"kind":"work_fact","text":"…","priority":60,"scene":"数据库"}]}',
  '没有值得记住的内容时输出：{"memories":[]}',
].join('\n')

/** System prompt for the dedupe/conflict pass. */
export const DEDUPE_SYSTEM = [
  '你是记忆去重器。只输出 JSON 数组，不要解释。',
  '输入是若干「新事实」及每个新事实的「已有候选」。对每条新事实决定：',
  '- store：与候选都不等价，新增',
  '- update：新事实修正/补充了某个候选，target_id 指向它',
  '- merge：新事实是多个候选的合并结果，target_id 为主，merge_ids 列出被吸收的',
  '- skip：候选里已有等价事实',
  '候选可能来自其他项目，也可能是全局规则（scope=global）：只要语义等价就 skip 或 merge，不要因为不在同一项目就新增一条平行的偏好。',
  'text 输出合并/修正后的最终文本（不超过 200 字）。',
  '输出格式：[{"i":0,"op":"update","target_id":12,"merge_ids":[],"text":"最终文本"}]',
].join('\n')

/**
 * Clip text to a limit (head kept).
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * Strip reasoning wrappers (`<think>…</think>`, ` reasoning…`) and markdown fences.
 * @param {string} raw
 * @returns {string}
 */
export function stripNoise(raw) {
  let text = String(raw ?? '')
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
  text = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
  return text.trim()
}

/**
 * Repair raw string-literal damage that makes JSON.parse throw.
 *
 * The model often pastes Windows paths into a fact (`C:\Users\…`) without
 * escaping the backslashes; JSON only allows `\" \\ \/ \b \f \n \r \t \uXXXX`.
 * It also occasionally emits a literal newline/tab inside a string. Both are
 * repaired here, string-aware, so valid escapes are left untouched.
 *
 * @param {string} text
 * @returns {string}
 */
export function repairStringEscapes(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  const validSimple = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch === '\\') {
      const next = source[i + 1]
      if (next !== undefined && validSimple.has(next)) {
        out += ch + next
        i += 1
        continue
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
        out += source.slice(i, i + 6)
        i += 5
        continue
      }
      // A lone backslash (typical Windows path): escape the slash itself and
      // let the following character be processed normally.
      out += '\\\\'
      continue
    }
    if (ch === '\n') {
      out += '\\n'
      continue
    }
    if (ch === '\r') {
      out += '\\r'
      continue
    }
    if (ch === '\t') {
      out += '\\t'
      continue
    }
    if (ch.charCodeAt(0) < 0x20) {
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * Light JSON repair for the usual model slips: trailing commas, bare keys,
 * single-quoted strings, unquoted numeric priority, and invalid string escapes.
 * @param {string} text
 * @returns {string}
 */
export function repairJson(text) {
  let value = String(text ?? '')
  value = value.replace(/,\s*([}\]])/g, '$1')
  value = value.replace(/([{,]\s*)'([^'\\]+)'(\s*:)/g, '$1"$2"$3')
  value = value.replace(/(:\s*)'([^'\\]*)'/g, '$1"$2"')
  // {"priority": 60} is fine; `priority: 60` (bare key) is not
  value = value.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
  // Must run last: it rewrites backslashes only inside string literals.
  return repairStringEscapes(value)
}

/**
 * Track string/bracket state of a JSON document.
 * @param {string} text
 * @returns {{ inString: boolean, trailingEscape: boolean, stack: string[] }}
 */
function scanJsonState(text) {
  let inString = false
  let trailingEscape = false
  /** @type {string[]} */
  const stack = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (trailingEscape) trailingEscape = false
      else if (ch === '\\') trailingEscape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return { inString, trailingEscape, stack }
}

/**
 * Close a truncated JSON document: terminate an open string, drop a dangling
 * separator, then append the brackets still missing. Returns null when the
 * text cannot be closed into something parseable-looking.
 *
 * A model that runs out of output budget mid-answer produces exactly this
 * shape (`{"memories":[{"text":"…`) and strict parsing throws the whole batch
 * away — the partial facts are worth keeping.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function closeTruncatedJson(text) {
  let out = String(text ?? '').replace(/\s+$/, '')
  if (out === '') return null
  if (!/^[{[]/.test(out)) return null
  let { inString, trailingEscape, stack } = scanJsonState(out)
  if (inString) {
    if (trailingEscape) out += '\\'
    out += '"'
    const rest = scanJsonState(out)
    stack = rest.stack
    inString = false
  }
  out = out.replace(/[,:]\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}

/**
 * Salvage a truncated JSON answer: try the tail as-is, then progressively cut
 * back to earlier closing brackets (which drops the incomplete last element).
 *
 * @param {string} text
 * @returns {unknown|null}
 */
export function salvageTruncatedJson(text) {
  const source = String(text ?? '')
  const start = source.search(/[{[]/)
  if (start < 0) return null
  const tail = stripNoise(source.slice(start))
  if (tail === '') return null
  // Only cut at a closing bracket: the element that ended there is complete, so
  // no half-written fact can slip into the store. Longest prefix first, so a
  // document truncated just before its final `]` keeps every element.
  /** @type {number[]} */
  const cuts = []
  for (let i = tail.length - 1; i >= 0 && cuts.length < 40; i--) {
    const ch = tail[i]
    if (ch === '}' || ch === ']') cuts.push(i)
  }
  for (const cut of cuts) {
    const closed = closeTruncatedJson(tail.slice(0, cut + 1))
    if (closed === null) continue
    for (const attempt of [closed, repairJson(closed)]) {
      try {
        return JSON.parse(attempt)
      } catch {
        /* try the next, shorter candidate */
      }
    }
  }
  return null
}

/**
 * Find the first balanced JSON value (object or array) in `text`.
 * String-aware so braces inside strings do not end the scan early.
 * @param {string} text
 * @returns {string|null}
 */
export function extractJsonSlice(text) {  const source = String(text ?? '')
  let start = -1
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{' || ch === '[') {
      start = i
      break
    }
  }
  if (start < 0) return null
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/**
 * All top-level JSON slices in `text`, in source order.
 *
 * Models (and the headless runner) sometimes print an illustrative example
 * object before the real answer. Taking only the first slice then parses the
 * example or fails on it; extraction instead needs to consider every slice and
 * pick the one shaped like `{"memories": [...]}` / a decisions array.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractJsonSlices(text) {
  const source = stripNoise(text)
  /** @type {string[]} */
  const slices = []
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const slice = extractJsonSlice(rest)
    if (slice === null) break
    const start = index + rest.indexOf(slice)
    slices.push(slice)
    index = start + slice.length
  }
  return slices
}

/**
 * Parse every JSON slice, tolerantly. Invalid slices are simply skipped.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseJsonCandidates(text) {
  /** @type {unknown[]} */
  const values = []
  const slices = extractJsonSlices(text)
  for (const slice of slices) {
    try {
      values.push(JSON.parse(slice))
      continue
    } catch {
      /* try repair below */
    }
    try {
      values.push(JSON.parse(repairJson(slice)))
    } catch {
      /* not JSON after all */
    }
  }
  // A response cut off by the output budget has no balanced slice at all, so the
  // loop above finds nothing. Salvage the tail after the last complete slice (or
  // the whole source when there is none).
  const source = stripNoise(text)
  const lastSlice = slices[slices.length - 1]
  const remainder = lastSlice === undefined ? source : source.slice(source.lastIndexOf(lastSlice) + lastSlice.length)
  if (remainder.includes('{') || remainder.includes('[')) {
    const salvaged = salvageTruncatedJson(remainder)
    if (salvaged !== null) values.push(salvaged)
  }
  return values
}

/**
 * Parse one JSON value with repair fallbacks.
 * @param {string} text
 * @returns {unknown|null}
 */
export function parseJsonLoose(text) {
  const slice = extractJsonSlice(stripNoise(text))
  if (slice === null) return salvageTruncatedJson(text)
  try {
    return JSON.parse(slice)
  } catch {
    try {
      return JSON.parse(repairJson(slice))
    } catch {
      return salvageTruncatedJson(text)
    }
  }
}

/**
 * Validate and normalize one extracted memory. Returns null when unusable.
 *
 * `scope` is only accepted for `persona` / `instruction`: a cross-project
 * preference or hard rule belongs in the global layer, everything else is
 * project knowledge and must stay scoped to the project that produced it.
 *
 * @param {unknown} item
 * @returns {{ kind: string, text: string, priority: number, scene: string|null, scope: 'global'|null } | null}
 */
export function normalizeMemoryItem(item) {
  if (item === null || typeof item !== 'object') return null
  const record = /** @type {Record<string, unknown>} */ (item)
  const text = clip(record.text, EXTRACT_LIMITS.text)
  if (text === '') return null
  const sceneRaw = clip(record.scene, EXTRACT_LIMITS.scene)
  const kind = normalizeKind(record.kind)
  const wantsGlobal = String(record.scope ?? '').trim().toLowerCase() === 'global'
  return {
    kind,
    text,
    priority: clampPriority(record.priority),
    scene: sceneRaw === '' ? null : sceneRaw,
    scope: wantsGlobal && (kind === 'persona' || kind === 'instruction') ? 'global' : null,
  }
}

/**
 * Parse one extraction response.
 * @param {string} raw
 * @param {{ maxMemories?: number }} [options]
 * @returns {{ memories: Array<{ kind: string, text: string, priority: number, scene: string|null }>, reason: string }}
 */
export function parseExtraction(raw, options = {}) {
  const maxMemories = Math.max(1, Math.min(50, options.maxMemories ?? EXTRACT_LIMITS.memories))
  const values = parseJsonCandidates(raw)
  if (values.length === 0) return { memories: [], reason: 'parse' }

  /** @type {{ memories: Array<{ kind: string, text: string, priority: number, scene: string|null, scope?: 'global'|null }>, listLength: number } | null} */
  let best = null
  for (const value of values) {
    const list = Array.isArray(value)
      ? value
      : value !== null && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).memories)
        ? /** @type {any} */ (value).memories
        : null
    if (list === null) continue
    /** @type {Array<{ kind: string, text: string, priority: number, scene: string|null }>} */
    const memories = []
    for (const item of list) {
      const normalized = normalizeMemoryItem(item)
      if (normalized === null) continue
      if (memories.some((entry) => entry.text === normalized.text)) continue
      memories.push(normalized)
      if (memories.length >= maxMemories) break
    }
    // Prefer the candidate with the most usable memories: a reasoning trace may
    // print `{"memories":[...]}` as an example before the real answer. On a tie
    // the later candidate wins, because the model's final answer comes last.
    if (best === null || memories.length > best.memories.length || (memories.length > 0 && memories.length === best.memories.length)) {
      best = { memories, listLength: list.length }
    }
  }
  if (best === null) return { memories: [], reason: 'parse' }
  if (best.memories.length === 0) return { memories: [], reason: best.listLength === 0 ? 'empty' : 'filtered' }
  return { memories: best.memories, reason: 'ok' }
}

/**
 * Build the extraction request messages.
 * @param {string} transcript
 * @param {{ maxMemories?: number }} [options]
 * @returns {{ system: string, user: string }}
 */
export function buildExtractionPrompt(transcript, options = {}) {
  const maxMemories = Math.max(1, Math.min(50, options.maxMemories ?? EXTRACT_LIMITS.memories))
  const user = [
    `下面是待整理的对话记录（按时间顺序）：`,
    '<conversation>',
    String(transcript ?? '').trim(),
    '</conversation>',
    `最多抽取 ${maxMemories} 条。只输出约定的 JSON。`,
  ].join('\n')
  return { system: EXTRACTION_SYSTEM, user }
}

/**
 * Build the dedupe request from new memories and their candidates.
 * @param {Array<{ fact: { kind: string, text: string, priority: number, scene: string|null }, candidates: Array<Record<string, any>> }>} plan
 * @returns {{ system: string, user: string }}
 */
export function buildDedupePrompt(plan) {
  const relevant = plan.filter((entry) => entry.candidates.length > 0)
  const payload = relevant.map((entry) => ({
    i: Number.isInteger(entry.index) ? entry.index : plan.indexOf(entry),
    new_fact: {
      kind: entry.fact.kind,
      text: entry.fact.text,
      priority: entry.fact.priority,
      scene: entry.fact.scene,
    },
    candidates: entry.candidates.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      text: String(row.text ?? '').slice(0, 200),
    })),
  }))
  return {
    system: DEDUPE_SYSTEM,
    user: ['<dedupe_input>', JSON.stringify(payload, null, 0), '</dedupe_input>', '只输出约定的 JSON 数组。'].join('\n'),
  }
}

/**
 * Parse the dedupe response into decisions keyed by fact index.
 * Invalid entries are dropped; missing indices fall back to the heuristic.
 *
 * @param {string} raw
 * @param {number} count
 * @returns {Array<{ index: number, op: 'store'|'update'|'merge'|'skip', targetId: number|null, mergeIds: number[], text: string|null }>}
 */
export function parseDedupe(raw, count) {
  const values = parseJsonCandidates(raw)
  const ops = new Set(['store', 'update', 'merge', 'skip'])
  /** @type {Array<any>} */
  let best = []
  for (const value of values) {
    const list = Array.isArray(value)
      ? value
      : value !== null && typeof value === 'object' && Array.isArray(/** @type {any} */ (value).decisions)
        ? /** @type {any} */ (value).decisions
        : null
    if (list === null) continue
    /** @type {Array<any>} */
    const decisions = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const record = /** @type {Record<string, unknown>} */ (item)
      const index = Number(record.i ?? record.index)
      if (!Number.isInteger(index) || index < 0 || index >= count) continue
      const op = String(record.op ?? '').trim()
      if (!ops.has(op)) continue
      const targetId = Number(record.target_id ?? record.targetId ?? 0)
      const mergeIds = Array.isArray(record.merge_ids)
        ? record.merge_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
        : []
      const text = typeof record.text === 'string' && record.text.trim() !== '' ? clip(record.text, EXTRACT_LIMITS.text) : null
      decisions.push({ index, op, targetId: targetId > 0 ? targetId : null, mergeIds, text })
      if (decisions.length >= count) break
    }
    if (decisions.length > best.length) best = decisions
  }
  return best
}

/**
 * Pair each extracted fact with its existing candidates, so the dedupe call
 * only receives facts that actually have overlap.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ kind: string, text: string, priority: number, scene: string|null }>} memories
 * @param {{ project?: string|null }} [options]
 * @returns {Array<{ fact: any, candidates: Array<Record<string, any>> }>}
 */
export function withCandidates(db, memories, options = {}) {
  return memories.map((fact, index) => ({
    index,
    fact,
    candidates: findCandidates(db, fact.text, { project: options.project ?? null, limit: EXTRACT_LIMITS.candidates }),
  }))
}

/**
 * Apply parsed decisions (or the deterministic fallback) to the store.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ fact: any, candidates: Array<Record<string, any>> }>} plan
 * @param {Array<{ index: number, op: string, targetId: number|null, mergeIds: number[], text: string|null }>} decisions
 * @param {{ project?: string|null, sessionId?: string|null, sourceSeqs?: number[], now?: number }} [ctx]
 * @returns {{ store: number, update: number, merge: number, skip: number, ids: number[] }}
 */
export function applyDecisions(db, plan, decisions, ctx = {}) {
  const summary = { store: 0, update: 0, merge: 0, skip: 0, ids: [] }
  const byIndex = new Map(decisions.map((decision) => [decision.index, decision]))
  for (let index = 0; index < plan.length; index++) {
    const entry = plan[index]
    const decision = byIndex.get(index) ?? { ...decideHeuristically(entry.fact, entry.candidates), text: null }
    const targetId = decision.targetId ?? null
    const text = decision.text ?? entry.fact.text
    let op = decision.op
    if ((op === 'update' || op === 'merge') && targetId === null) op = 'store'
    const result = applyDecision(
      db,
      {
        op: /** @type {any} */ (op),
        kind: entry.fact.kind,
        text,
        priority: entry.fact.priority,
        scene: entry.fact.scene,
        scope: entry.fact.scope ?? undefined,
        targetId,
        mergeIds: decision.mergeIds ?? [],
      },
      { ...ctx, now: ctx.now },
    )
    const key = /** @type {'store'|'update'|'merge'|'skip'} */ (result.op)
    summary[key] += 1
    if (result.id !== null) summary.ids.push(result.id)
  }
  return summary
}
