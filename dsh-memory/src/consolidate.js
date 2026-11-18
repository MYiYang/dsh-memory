/**
 * L2/L3 consolidation: turn L1 facts into scene blocks and a persona.
 *
 * Both steps are optional, sequential, and failure-isolated: a failed scene
 * summary or persona rewrite leaves the previous content in place.
 *
 * @module dsh-memory/consolidate
 */
import { addMeta, getMeta, setMeta } from './store.js'
import { getPersona, listScenes, pruneScenes, putPersona, upsertScene } from './profile.js'
import { parseJsonLoose } from './extract.js'
import { createDecisionProvider, DecisionProviderError } from './decision.js'

export const SCENE_SYSTEM = [
  '你是场景归并器。把一批事实归并成一个简洁的场景块。',
  '只输出 JSON，不要解释：{"summary":"一句话摘要（<=60字）","body":"Markdown 正文（分要点/约定/坑，<=800字）"}',
  '只使用给定事实，不要编造；合并重复，删除过时内容。',
  '如果这批事实表明画像已明显过时（新增了硬约束，或推翻了画像里仍在用的结论），可额外带上 "requestPersona":true，请求尽快重写画像；否则省略这个字段。',
].join('\n')

export const PERSONA_SYSTEM = [
  '你是画像整理器。把长期事实整理成稳定的长期画像 Markdown（项目级与全局级通用）。',
  '固定小标题（缺内容可省略）：## 用户偏好 / ## 项目约定 / ## 关键决策 / ## 环境与工具。',
  '只使用给定事实，不要编造；只保留长期有效的内容，不要写一次性事件。',
  '变化处置分五类，只做该做的那一类：强化（并入原句，不新增）/ 补充（新增长期结论）/ 修正（旧结论被推翻）/ 重构（整体压缩重写）/ 不改（无画像级新增）。',
  '输出协议（只输出 JSON，不要解释）：',
  '- 修正：{"mode":"patch","edits":[{"old":"从现有画像里逐字复制的句子","new":"替换后的句子"}]}',
  '- 补充或重构：{"mode":"write","body":"Markdown 画像"}',
  '- 不改：{"mode":"none"}',
  'patch 的 old 必须逐字存在于「现有画像」；找不到就改用 write，不要猜。禁止把同一结论的新旧两种说法并列写入。',
].join('\n')

/** Compression is a pure rewrite: the patch/none protocol would only confuse it. */
export const PERSONA_COMPRESS_SYSTEM = [
  '你是画像压缩器。把给定的画像压到指定长度，保持 Markdown 小标题结构。',
  '只输出 JSON，不要解释：{"body":"压缩后的 Markdown 画像"}',
  '优先保留命令、路径、约束、硬规则这类可执行信息；删除重复、次要、过时内容；同一意思只写一次。',
].join('\n')

export const GATE_SYSTEM = [
  '判断这批新事实是否值得重写画像。只输出 JSON：{"decision":"conflict|boundary_change|new_rule|reinforcement|none"}',
  '- conflict：与现有画像矛盾，必须改',
  '- boundary_change：适用边界/范围变了',
  '- new_rule：出现新的硬规则或长期约定',
  '- reinforcement：只是重复确认已有内容',
  '- none：与画像无关',
].join('\n')

/**
 * The judgment asked of a decision provider (`persona.triggerMode = "jev"`).
 *
 * Labels and priority order are the upstream ones, and so are the two
 * counter-intuitive rules that keep a gate from firing on noise: a rule whose
 * *scope* changes is a boundary change rather than a new rule, and a scene that
 * narrates an old-to-new history is reinforcement rather than a conflict.
 */
export const JEV_PROMPT_VERSION = 'l3-memory-change-v1'

/** Question id used by the decision provider protocol. */
export const DECISION_QUESTION_ID = 'memory_change'

export const JEV_INSTRUCTIONS = [
  '你在判断：自上次画像更新以来发生变化的场景块，是否足以让画像重写。',
  '把每个变化场景的当前结论与现有画像逐条比较，然后只返回一个标签，按下述优先级从严到宽：',
  '1) conflict：任何变化场景推翻、反驳或替换了现有画像仍在陈述的事实或原则。',
  '2) boundary_change：任何变化场景持久地改变了现有画像中某条规则的适用范围。',
  '   把既有规则的范围收窄或扩大，算 boundary_change，不算 new_rule。',
  '3) new_rule：任何变化场景新增了一条独立的、画像级的长期规则，且这不是对既有规则的适用性调整。',
  '4) reinforcement：变化场景只是支持或复述了画像已有内容。',
  '   例如「从旧结论改到新结论」的历史叙述：若画像已含新结论，算 reinforcement，不算 conflict。',
  '5) none：变化场景没有带来画像级的新信息。',
  '注意：场景里的历史陈述只是上下文，本身不是当前信念；不能让「支持或无关」的场景压倒真正更高优先级的变化。',
  '优先级：conflict > boundary_change > new_rule > reinforcement > none。',
].join('\n')

export const JEV_CRITERIA = {
  conflict: '变化场景推翻或替换了画像仍在陈述的结论。',
  boundary_change: '变化场景持久地收窄或扩大了画像中某条规则的适用范围。',
  new_rule: '变化场景新增了一条独立的画像级长期规则，而非范围调整。',
  reinforcement: '变化场景只是支持或复述画像已有内容（含已同步的新旧更替叙述）。',
  none: '变化场景没有带来画像级的新信息。',
}

/** Ring size of the gate diagnostic log kept in `meta['l3-gate-log']`. */
export const GATE_LOG_LIMIT = 200

/**
 * Guards for one consolidation batch.
 *
 * `sceneUpdates` is the number of scenes a batch may actually rewrite. The two
 * counters next to it bound the **calls**, not the writes: without them a batch
 * that keeps getting empty answers walks every due scene (measured: 107 due
 * scenes, 90 calls in one run) and blocks the serial extraction queue for
 * minutes. `sceneAttempts` caps the calls outright, `sceneFailures` stops after
 * a run of empty answers instead of asking the rest of the list.
 */
export const CONSOLIDATE_LIMITS = {
  sceneUpdates: 3,
  sceneAttempts: 6,
  sceneFailures: 3,
  sceneFacts: 20,
  personaFacts: 30,
}

/** Clamp a string for a prompt line. */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/**
 * Group active facts by scene name, with a per-scene quota.
 *
 * The old shape was one global `LIMIT 300` over the whole pool: once the corpus
 * grew past that, whole scenes became invisible to L2 (measured: 148 groups,
 * 380 scene facts, 22 groups never read at LIMIT 300). A per-group window keeps
 * every scene's own top rows, so "biggest backlog" really means the group that
 * owes the most, not whoever happened to sort into the first 300 rows.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null, perScene?: number }} options
 * @returns {Map<string, Array<Record<string, any>>>}
 */
export function factsByScene(db, options = {}) {
  const quota = Math.max(1, Math.min(200, Number(options.perScene ?? CONSOLIDATE_LIMITS.sceneFacts)))
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY scene
           ORDER BY priority DESC, updated_at DESC
         ) AS rn
           FROM memory
          WHERE superseded_by IS NULL AND scene IS NOT NULL AND scene <> ''
            AND (scope = 'global' OR project = ?)
       ) WHERE rn <= ?`,
    )
    .all(options.project ?? null, quota)
  const groups = new Map()
  for (const row of rows) {
    const name = String(row.scene ?? '').trim()
    if (name === '') continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(row)
  }
  return groups
}

/** Hard cap on one JEV gate input (mirrors the upstream 32k state limit). */
export const JEV_STATE_LIMIT_CHARS = 32_000

/** Gate decisions that justify a rewrite; anything else is a deferral. */
export const GATE_ACCEPT = new Set(['conflict', 'boundary_change', 'new_rule'])

/**
 * How the L3 rewrite is scheduled:
 *   - `current` (default, upstream parity): a trigger decides, the gate is not
 *     consulted at all. Cost is bounded by the fact threshold.
 *   - `jev`: the trigger still wins, the gate only gets a chance when the
 *     trigger says no (upstream's `triggerMode: "jev"`).
 *   - `legacy`: the old batch counter + gate-on-facts path, kept for rollback.
 */
export const TRIGGER_MODES = ['current', 'jev', 'legacy']

/** Meta key holding the timestamp of the last real persona write for one bucket. */
export function watermarkKey(label) {
  return `l3-persona-time:${label}`
}

/**
 * Timestamp of the last real persona write, or `null` when the bucket never
 * wrote one. This is the baseline every "what changed" question is answered
 * against — a batch counter cannot answer it, which is why the old path kept
 * asking the gate about the same snapshot.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} label
 * @returns {number|null}
 */
export function readWatermark(db, label) {
  const raw = getMeta(db, watermarkKey(label))
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Scene rows visible from one bucket: global rows plus the project's own.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function listBucketScenes(db, options = {}) {
  return db
    .prepare(`SELECT * FROM l2_scenes WHERE scope = 'global' OR project = ?`)
    .all(options.project ?? null)
}

/**
 * Scene rows rewritten after `since` (every row when `since` is null).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null, since?: number|null }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function changedScenesSince(db, options = {}) {
  const rows = listBucketScenes(db, options)
  if (options.since === null || options.since === undefined) return rows
  return rows.filter((row) => Number(row.updated_at ?? 0) > options.since)
}

/** SQL fragment + args for one bucket's active facts. */
function bucketFactWhere(scope, project) {
  return scope === 'global'
    ? { clause: `scope = 'global'`, args: [] }
    : { clause: `(scope = 'global' OR project = ?)`, args: [project ?? null] }
}

/**
 * Number of facts written after `since` — the upstream
 * `memories_since_last_persona`, counted in SQL so the prompt's `LIMIT` can
 * never make the threshold look smaller than it is.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope?: 'project'|'global', project?: string|null, since?: number|null }} [options]
 * @returns {number}
 */
export function countFactsSince(db, options = {}) {
  const bucket = bucketFactWhere(options.scope === 'global' ? 'global' : 'project', options.project)
  const fresh = options.since !== null && options.since !== undefined
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory
        WHERE superseded_by IS NULL AND ${bucket.clause}${fresh ? ' AND updated_at > ?' : ''}`,
    )
    .get(...bucket.args, ...(fresh ? [options.since] : []))
  return Number(row?.n ?? 0)
}

/**
 * Facts written after `since`, ranked like the persona prompt expects.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope?: 'project'|'global', project?: string|null, since?: number|null, limit?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function factsSince(db, options = {}) {
  const bucket = bucketFactWhere(options.scope === 'global' ? 'global' : 'project', options.project)
  const fresh = options.since !== null && options.since !== undefined
  return db
    .prepare(
      `SELECT * FROM memory
        WHERE superseded_by IS NULL AND ${bucket.clause}${fresh ? ' AND updated_at > ?' : ''}
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(...bucket.args, ...(fresh ? [options.since] : []), Math.max(1, Math.min(200, options.limit ?? CONSOLIDATE_LIMITS.personaFacts)))
}

/** Meta key of a pending explicit persona request (upstream trigger P1). */
export function personaRequestKey(project) {
  return `l3-persona-request:${project ?? '@global'}`
}

/** Meta key of the "first scene block finished" signal (upstream trigger P3). */
export function firstSceneKey(project) {
  return `l3-first-scene:${project ?? '@global'}`
}

/**
 * Apply the model's `patch` edits to the current body.
 *
 * A patch is applied only when `old` occurs **verbatim** in the current body:
 * the point of a patch is to make the superseded sentence disappear, so a
 * fuzzy match would risk deleting the wrong line. Each edit replaces the first
 * occurrence only, and every miss is reported instead of guessed at.
 *
 * @param {string} body
 * @param {Array<{ old?: unknown, new?: unknown }>} edits
 * @returns {{ text: string, hit: number, misses: Array<{ reason: string, old?: string }> }}
 */
export function applyPersonaPatch(body, edits) {
  let text = String(body ?? '')
  let hit = 0
  /** @type {Array<{ reason: string, old?: string }>} */
  const misses = []
  for (const edit of Array.isArray(edits) ? edits : []) {
    const old = typeof edit?.old === 'string' ? edit.old : ''
    const next = typeof edit?.new === 'string' ? edit.new : ''
    if (old.trim() === '') {
      misses.push({ reason: 'empty-old' })
      continue
    }
    const at = text.indexOf(old)
    if (at === -1) {
      misses.push({ reason: 'not-found', old: clip(old, 80) })
      continue
    }
    text = text.slice(0, at) + next + text.slice(at + old.length)
    hit += 1
  }
  return { text, hit, misses }
}

/**
 * Decide whether this bucket is due for a rewrite.
 *
 * Mirrors the upstream `PersonaTrigger`: the five priorities are P1 explicit
 * request, P2 cold start, P2.5 recovery, P3 first scene block, P4 threshold.
 * The bloat line is kept as an always-on safety valve: an oversized persona
 * does not fit the stable block, so whether the facts are "worth" a rewrite is
 * no longer the question.
 *
 * @param {{
 *   current?: Record<string, any>,
 *   sceneRows: Array<Record<string, any>>,
 *   freshFactCount: number,
 *   targetChars: number,
 *   factThreshold: number,
 *   poolSize: number,
 *   requested?: boolean,
 *   firstScene?: boolean,
 * }} input
 * @returns {{ should: boolean, reason: string }}
 */
export function evaluatePersonaTrigger(input) {
  const { current, sceneRows, freshFactCount, targetChars, factThreshold, poolSize } = input
  // P1: an explicit request (the scene agent saw the persona go stale) outranks
  // every other condition — the same priority order as the upstream trigger.
  if (input.requested === true) return { should: true, reason: 'requested' }
  if (current === undefined) {
    // Cold start: the first persona is always worth one call once there is
    // anything to read (upstream P2/P3).
    if (poolSize === 0 && sceneRows.length === 0) return { should: false, reason: 'no-input' }
    return { should: true, reason: 'cold-start' }
  }
  if (String(current.body ?? '').trim() === '') return { should: true, reason: 'recovery' }
  const bloatLimit = Math.floor(targetChars * 1.4)
  if (String(current.body ?? '').length > bloatLimit) return { should: true, reason: 'bloat' }
  // P3: the first scene block is in and there is new evidence to fold in. The
  // signal is one-shot (cleared after a successful write), so a project that
  // only ever has one scene does not rewrite its persona on every batch.
  if (input.firstScene === true && Number(freshFactCount ?? 0) > 0) return { should: true, reason: 'first-scene' }
  if (freshFactCount >= factThreshold) return { should: true, reason: `facts:${freshFactCount}>=${factThreshold}` }
  return { should: false, reason: `below-threshold:${freshFactCount}/${factThreshold}` }
}

/** Normalize a persona body so "the model restated it" is detectable. */
export function normalizeBody(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Build the gate *state* for the scene-diff input (upstream shape: the current
 * persona plus the scenes that changed since the last write). Returns `null`
 * when there is nothing to judge or the state would blow the input cap, so the
 * caller can defer without paying for a call.
 *
 * @param {{ body?: string }} persona
 * @param {Array<Record<string, any>>} scenes
 * @returns {string|null}
 */
export function buildGateState(persona, scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) return null
  const lines = scenes.slice(0, 5).map((scene) => {
    const summary = clip(scene.summary ?? '', 160)
    const body = clip(scene.body ?? '', 700)
    return [`### ${String(scene.name ?? '').trim()}`, summary ? `摘要：${summary}` : '', body ? `正文：\n${body}` : '']
      .filter((line) => line !== '')
      .join('\n')
  })
  const state = [
    `现有画像：\n${clip(persona?.body ?? '', 900)}`,
    '自上次画像更新以来发生变化的场景：',
    ...lines,
  ].join('\n')
  return state.length > JEV_STATE_LIMIT_CHARS ? null : state
}

/**
 * The same input as a ready-made prompt. Kept for diagnostics and for callers
 * that want to see exactly what the `llm` provider will be asked.
 *
 * @param {{ body?: string }} persona
 * @param {Array<Record<string, any>>} scenes
 * @returns {{ system: string, user: string } | null}
 */
export function buildSceneGatePrompt(persona, scenes) {
  const state = buildGateState(persona, scenes)
  return state === null ? null : { system: JEV_INSTRUCTIONS, user: state }
}

/**
 * Cumulative patch counters: how many edits the model proposed and how many of
 * them matched the body verbatim. `null` means no patch has ever been written,
 * which lets the status line stay silent instead of printing `patch=0/0`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ writes: number, patches: number, edits: number, hits: number, misses: number } | null}
 */
export function readPatchStats(db) {
  const raw = getMeta(db, 'l3-patch-stats')
  if (raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return {
      writes: Number(parsed.writes ?? 0),
      patches: Number(parsed.patches ?? 0),
      edits: Number(parsed.edits ?? 0),
      hits: Number(parsed.hits ?? 0),
      misses: Number(parsed.misses ?? 0),
    }
  } catch {
    return null
  }
}

/**
 * Cumulative gate counters, kept next to the ring log so the question "did the
 * gate ever fire" has an answer without grepping logs.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ called: number, hit: number, deferred: number, unavailable: number }}
 */
export function readGateStats(db) {
  const empty = { called: 0, hit: 0, deferred: 0, unavailable: 0 }
  const raw = getMeta(db, 'l3-gate-stats')
  if (raw === undefined || raw === '') return empty
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    return {
      called: Number(parsed.called ?? 0),
      hit: Number(parsed.hit ?? 0),
      deferred: Number(parsed.deferred ?? 0),
      unavailable: Number(parsed.unavailable ?? 0),
    }
  } catch {
    return empty
  }
}

/**
 * Record one gate event: a line in the `l3-gate-log` ring plus the counters.
 * Diagnostics must never break the gate, so every write is wrapped.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(level: string, message: string) => void} log
 * @param {'off'|'metadata'|'full'} mode
 * @param {Record<string, any>} entry
 */
export function recordGate(db, log, mode, entry) {
  if (mode === 'off') return
  try {
    const raw = getMeta(db, 'l3-gate-log')
    let list = []
    if (raw !== undefined && raw !== '') {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    }
    list.push(entry)
    if (list.length > GATE_LOG_LIMIT) list = list.slice(list.length - GATE_LOG_LIMIT)
    setMeta(db, 'l3-gate-log', JSON.stringify(list))
    const stats = readGateStats(db)
    if (entry.action === 'immediate') {
      stats.called += 1
      stats.hit += 1
    } else if (entry.action === 'defer') {
      stats.called += 1
      stats.deferred += 1
    } else if (entry.action === 'unavailable') {
      stats.unavailable += 1
    }
    setMeta(db, 'l3-gate-stats', JSON.stringify(stats))
  } catch {
    /* bookkeeping only */
  }
  const line = JSON.stringify(entry)
  if (mode === 'full') log('info', `[l3-jev] ${line}`)
  else log('debug', `[l3-jev] ${line}`)
}

/**
 * Resolve `persona.jev.apiKeyRef`: a credential reference goes through the host
 * credentials service and then the environment; anything that does not look
 * like an identifier is used literally.
 *
 * @param {string} ref
 * @param {(ref: string) => Promise<string|null>} [resolveSecret]
 * @returns {Promise<string>}
 */
export async function resolveDecisionApiKey(ref, resolveSecret) {
  const text = String(ref ?? '').trim()
  if (text === '') return ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return text
  try {
    const value = await resolveSecret?.(text)
    if (typeof value === 'string' && value !== '') return value
  } catch {
    /* fall through to the environment */
  }
  const fromEnv = process.env[text]
  return typeof fromEnv === 'string' ? fromEnv.trim() : ''
}

/**
 * Build the scene prompt.
 * @param {string} name
 * @param {Array<Record<string, any>>} facts
 * @param {{ summary?: string, body?: string }} [existing]
 * @returns {{ system: string, user: string }}
 */
export function buildScenePrompt(name, facts, existing = {}) {
  const lines = facts.slice(0, CONSOLIDATE_LIMITS.sceneFacts).map(
    (row) => `- [${row.kind}] ${clip(row.text, 240)}`,
  )
  return {
    system: SCENE_SYSTEM,
    user: [
      `场景：${name}`,
      existing.summary ? `现有摘要：${clip(existing.summary, 120)}` : '',
      existing.body ? `现有正文：\n${clip(existing.body, 600)}` : '',
      '事实：',
      ...lines,
      '只输出约定的 JSON。',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  }
}

/**
 * Build the persona rewrite prompt.
 *
 * `maxChars` is only the hard cap (the model happily fills it, which is how a
 * persona ends up twice the size the stable block can afford). When a
 * `targetChars` is given the prompt asks for that length instead, so the
 * generator itself stays lean.
 *
 * @param {Array<Record<string, any>>} facts
 * @param {{ body?: string }} [existing]
 * @param {number | { maxChars?: number, targetChars?: number }} [limits]
 * @param {'global'|'project'} [scope] - which persona is being written
 * @param {{ scenes?: Array<Record<string, any>>, incremental?: boolean, since?: number|null }} [extras]
 *   `scenes` are the scene blocks that changed since the last write. When they
 *   are present the prompt switches to an incremental revision: the changed
 *   scenes outrank the old body, and superseded conclusions must be dropped
 *   instead of being kept next to their replacement.
 * @returns {{ system: string, user: string }}
 */
export function buildPersonaPrompt(facts, existing = {}, limits = 1200, scope = 'project', extras = {}) {
  const maxChars = typeof limits === 'number' ? limits : Math.max(200, limits?.maxChars ?? 1200)
  const targetChars = typeof limits === 'number' ? null : limits?.targetChars ?? null
  const lines = facts.slice(0, CONSOLIDATE_LIMITS.personaFacts).map(
    (row) => `- [${row.kind}${row.scope === 'global' ? '/global' : ''}] ${clip(row.text, 240)}`,
  )
  const scenes = Array.isArray(extras.scenes) ? extras.scenes : []
  const sceneSection = scenes.length === 0
    ? []
    : [
        '变化场景（自上次画像后有更新，优先级高于下面的事实）：',
        ...scenes.slice(0, 6).map((scene) =>
          [
            `### ${String(scene.name ?? '').trim()}`,
            scene.summary ? `摘要：${clip(scene.summary, 160)}` : '',
            scene.body ? `正文：\n${clip(scene.body, 700)}` : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        ),
        '修订要求：以变化场景为准——新结论覆盖旧结论，删除已被推翻的条目；同一件事只保留最新版本，不要把新旧两种说法并列写出来。',
      ]
  return {
    system: PERSONA_SYSTEM,
    user: [
      `目标画像：${scope === 'global' ? '全局画像' : '项目画像'}`,
      existing.body ? `现有画像：\n${clip(existing.body, 900)}` : '现有画像：无',
      targetChars === null
        ? `目标长度：不超过 ${maxChars} 字。`
        : `长度硬性上限：${targetChars} 字（超出部分会被直接截断丢弃，只保留前几个小标题）。写不下就删次要内容，不要为凑长度灌水。`,
      '压缩要求：与「长期约定」或其他层重复的内容不要写；同一个意思只写一次；优先保留命令、路径、约束这类可执行信息。',
      '改写方式：修正旧结论用 {"mode":"patch","edits":[{"old":"从现有画像逐字复制的句子","new":"替换后的句子"}]}；补充或重构用 {"mode":"write","body":"完整画像"}；不值得改就 {"mode":"none"}。',
      ...(existing.body ? ['现有画像已存在：只要改的是个别结论，优先用 patch 让旧句物理消失；只有整体重构才用 write。'] : []),
      ...sceneSection,
      extras.incremental === true ? '新增事实（自上次画像后写入）：' : '事实：',
      ...lines,
      '只输出约定的 JSON。',
    ].join('\n'),
  }
}

/**
 * Build the "compress this persona" prompt used when the model overshoots the
 * length target. A dedicated pass keeps the section structure and the
 * executable details; a blind slice would cut the last sections off.
 *
 * @param {string} body
 * @param {number} limit
 * @returns {{ system: string, user: string }}
 */
export function buildPersonaCompressPrompt(body, limit) {
  return {
    system: PERSONA_COMPRESS_SYSTEM,
    user: [
      `把下面这份画像压缩到不超过 ${limit} 字。`,
      '要求：保留 Markdown 小标题结构；优先保留命令、路径、约束、硬规则这类可执行信息；删除重复、次要、过时内容；同一意思只写一次。',
      '现有画像：',
      clip(body, 4_000),
      '只输出约定的 JSON。',
    ].join('\n'),
  }
}

/**
 * Trim a persona body down to `limit` chars.
 *
 * The model treats "about N chars" as advice: asked for ~700 it happily wrote
 * 2_600. A tail cut would drop whole sections (the operations rules sit last),
 * so the trim is section-aware: keep every `## ` heading and its first lines,
 * widening line by line until the budget is used up. Only when even one line
 * per section does not fit does it fall back to a line-boundary head cut.
 *
 * @param {string} body
 * @param {number} limit
 * @returns {{ text: string, trimmed: boolean }}
 */
export function trimPersonaBody(body, limit) {
  const text = String(body ?? '').trim()
  const max = Math.max(1, Math.floor(limit))
  if (text.length <= max) return { text, trimmed: false }

  /** @type {Array<{ header: string, lines: string[] }>} */
  const sections = []
  for (const line of text.split('\n')) {
    if (line.startsWith('## ') || sections.length === 0) {
      if (line.startsWith('## ') || line.trim() !== '') sections.push({ header: line, lines: [] })
      continue
    }
    sections[sections.length - 1].lines.push(line)
  }
  const maxLines = Math.max(0, ...sections.map((section) => section.lines.length))
  for (let perSection = maxLines; perSection >= 1; perSection--) {
    const rendered = sections
      .map((section) => [section.header, ...section.lines.slice(0, perSection)].join('\n'))
      .join('\n')
      .trim()
    if (rendered.length + 1 <= max) {
      return { text: `${rendered}…`, trimmed: true }
    }
  }

  // Even one line per section is too long: fall back to a head cut at a line end.
  const kept = []
  let used = 0
  for (const line of text.split('\n')) {
    const cost = line.length + 1
    if (used + cost > max - 1) break
    kept.push(line)
    used += cost
  }
  let out = kept.join('\n').trim()
  if (out === '') out = text.slice(0, Math.max(0, max - 1)).trim()
  return { text: `${out}…`, trimmed: true }
}

/**
 * Build the JEV-lite gate prompt.
 * @param {{ body?: string }} persona
 * @param {Array<Record<string, any>>} facts
 * @returns {{ system: string, user: string }}
 */
export function buildGatePrompt(persona, facts) {
  const lines = facts.slice(0, 12).map((row) => `- [${row.kind}] ${clip(row.text, 160)}`)
  return {
    system: GATE_SYSTEM,
    user: [`现有画像：\n${clip(persona.body ?? '', 900)}`, '最近事实：', ...lines, '只输出约定的 JSON。'].join('\n'),
  }
}

/**
 * One model round-trip; returns the parsed JSON plus enough diagnostics to tell
 * "the model said nothing usable" from "the model said something else".
 * @param {any} llm
 * @param {{ system: string, user: string }} prompt
 * @param {{ maxTokens?: number, timeoutMs?: number, signal?: AbortSignal, sessionId?: string }} [options]
 */
async function askJson(llm, prompt, options = {}) {
  const response = await llm.complete({
    system: prompt.system,
    user: prompt.user,
    maxTokens: options.maxTokens ?? 800,
    timeoutMs: options.timeoutMs,
    reasoningEffort: options.reasoningEffort,
    purpose: options.purpose ?? 'compaction',
    signal: options.signal,
    sessionId: options.sessionId,
  })
  const ok = response?.ok === true
  const text = String(response?.text ?? '')
  return {
    value: ok ? parseJsonLoose(text) : null,
    usage: response?.usage ?? null,
    ok,
    error: response?.error ?? null,
    reason: response?.reason ?? null,
    chars: text.length,
    head: text.slice(0, 240),
  }
}

/** Record consolidation token usage against the shared counter. */
function track(db, usage) {
  if (!usage) return
  addMeta(db, 'l1_tokens_total', Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0))
}

/**
 * Bounds of the eviction marker: an evicted scene stays out of the navigation
 * until evidence newer than the eviction arrives, but the marker itself must
 * never grow without limit or outlive the data it describes.
 */
export const EVICTED_LIMITS = { entries: 200, maxAgeMs: 90 * 86_400_000 }

/** Meta key of the eviction marker for one project (or the global bucket). */
function evictedKey(project) {
  return `l2-evicted:${project ?? '@global'}`
}

/**
 * Scenes pruned recently, mapped to the timestamp of the prune.
 *
 * Without this marker `runScenes` rebuilds a scene the cap just deleted on the
 * very next batch: its facts are still there, the scene row is not, so the
 * "new scene" path pays one LLM call and the cap deletes the result again — a
 * per-batch leak that grows with the number of cold scenes.
 *
 * Stale entries are dropped on read, so the marker self-heals even for a project
 * that never runs the cap again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} project
 * @param {number} now
 * @returns {Record<string, number>}
 */
function readEvicted(db, project, now) {
  /** @type {Record<string, number>} */
  const map = {}
  const raw = getMeta(db, evictedKey(project))
  if (raw === undefined || raw === '') return map
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return map
    for (const [name, at] of Object.entries(parsed)) {
      const value = Number(at)
      if (name !== '' && Number.isFinite(value) && now - value <= EVICTED_LIMITS.maxAgeMs) map[name] = value
    }
  } catch {
    /* a corrupt marker must never stop consolidation */
  }
  return map
}

/**
 * Persist the eviction marker, capped to the newest {@link EVICTED_LIMITS.entries}.
 * An empty map removes the key instead of leaving `{}` behind, and an unchanged
 * marker is not rewritten (one meta write per batch would be pure overhead).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} project
 * @param {Record<string, number>} map
 */
function writeEvicted(db, project, map) {
  const key = evictedKey(project)
  const entries = Object.entries(map)
  const next =
    entries.length === 0
      ? null
      : JSON.stringify(
          Object.fromEntries(
            // Keep the newest N, then serialize name-sorted so an unchanged map
            // produces a byte-identical string and can be skipped below.
            entries
              .sort((a, b) => b[1] - a[1])
              .slice(0, EVICTED_LIMITS.entries)
              .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
          ),
        )
  const current = getMeta(db, key) ?? null
  if (next === null) {
    if (current !== null) db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    return
  }
  if (current !== next) setMeta(db, key, next)
}

/**
 * L2: rewrite scenes whose fact set grew since the last summary, then cap the
 * navigation at `maxScenes` per bucket.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} llm
 * @param {{ minFacts?: number, maxScenes?: number, halfLifeDays?: number, timeoutMs?: number, sessionId?: string, signal?: AbortSignal }} config
 * @param {{ project?: string|null, now?: number, log?: (level: string, message: string) => void }} ctx
 * @returns {Promise<{ updated: number, skipped: number, pruned: number }>} `pruned` is the
 *   number of scene rows deleted by the cap (0 when the project is inside it).
 */
export async function runScenes(db, llm, config = {}, ctx = {}) {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now()
  const minFacts = Math.max(1, config.minFacts ?? 3)
  const maxScenes = Math.max(1, config.maxScenes ?? 20)
  const halfLifeDays = config.halfLifeDays ?? 14
  const project = ctx.project ?? null
  // Scenes the cap removed in an earlier batch: rebuilding them from the same
  // facts would be undone by the next prune, so they wait for new evidence.
  const evicted = readEvicted(db, project, now)
  const groups = factsByScene(db, { project })
  const existing = new Map(listScenes(db, { project, now, limit: 100 }).map((row) => [row.name, row]))
  let updated = 0
  let skipped = 0
  /** Model calls made in this batch; a failed call still costs a call. */
  let attempted = 0
  /** Consecutive empty or errored answers; stops a run of dead calls early. */
  let failed = 0
  /** The P3 signal fires once per project, not once per new scene in a batch. */
  let firstSceneMarked = false
  // Ask about the scenes that owe the most first. A scene whose fact set grew
  // by ten outranks one that grew by one; otherwise the three successful writes
  // every batch go to whatever happened to sort first and the biggest backlog
  // never drains (measured: 107 due scenes, 3 written per batch).
  const backlog = (name, facts) => facts.length - Math.max(0, Number(existing.get(name)?.fact_count ?? 0))
  const ordered = [...groups.entries()].sort(
    (a, b) => backlog(b[0], b[1]) - backlog(a[0], a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
  for (const [name, facts] of ordered) {
    if (updated >= CONSOLIDATE_LIMITS.sceneUpdates) break
    if (attempted >= CONSOLIDATE_LIMITS.sceneAttempts) {
      log('debug', `l2 scene attempts capped at ${CONSOLIDATE_LIMITS.sceneAttempts} (updated=${updated})`)
      break
    }
    if (failed >= CONSOLIDATE_LIMITS.sceneFailures) {
      log('debug', `l2 scene stopped after ${failed} empty/errored answers (updated=${updated})`)
      break
    }
    if (facts.length < minFacts) {
      skipped += 1
      continue
    }
    const row = existing.get(name)
    const evictedAt = evicted[name]
    if (evictedAt !== undefined) {
      const newest = facts.reduce((max, item) => Math.max(max, Number(item.updated_at ?? 0)), 0)
      // A scene row that exists again means the eviction is moot (another writer
      // recreated it), so only a missing row is actually held back.
      if (row === undefined && newest <= evictedAt) {
        skipped += 1
        continue
      }
      // Fresh evidence: revive the scene and forget the eviction.
      delete evicted[name]
    }
    if (row && Number(row.fact_count ?? 0) >= facts.length) {
      skipped += 1
      continue
    }
    const prompt = buildScenePrompt(name, facts, row ?? {})
    attempted += 1
    /** @type {Record<string, any> | null} */
    let value = null
    try {
      const answer = await askJson(llm, prompt, {
        maxTokens: 700,
        timeoutMs: config.timeoutMs,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      })
      track(db, answer.usage)
      value = answer.value ?? null
    } catch (error) {
      failed += 1
      skipped += 1
      log('warn', `l2 scene "${name}" call failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const summary = value && typeof value.summary === 'string' ? clip(value.summary, 120) : ''
    const body = value && typeof value.body === 'string' ? String(value.body).trim() : ''
    if (summary === '' && body === '') {
      failed += 1
      skipped += 1
      continue
    }
    upsertScene(db, {
      scope: 'project',
      project,
      name,
      summary: summary || row?.summary || '',
      body: body || row?.body || '',
      factCount: facts.length,
      heatDelta: 1,
      now,
    })
    // P1: the scene agent may flag the persona as stale; the signal survives
    // until a persona write consumes it, so a deferred run does not lose it.
    if (value && value.requestPersona === true) setMeta(db, personaRequestKey(project), now)
    // P3: the very first scene block for this project is a one-shot trigger.
    if (row === undefined && existing.size === 0 && !firstSceneMarked) {
      firstSceneMarked = true
      setMeta(db, firstSceneKey(project), now)
    }
    // The scene is back: drop the eviction entry so the marker stays small.
    delete evicted[name]
    updated += 1
  }
  if (updated > 0 || attempted > 0) {
    log('debug', `l2 scenes updated=${updated} skipped=${skipped} attempted=${attempted} failed=${failed}`)
  }
  // The cap runs even when this batch rewrote nothing: scenes accumulate from
  // other sessions and from manual saves, so an idle batch is exactly when the
  // navigation can quietly grow past the limit.
  const pruned = pruneScenes(db, { maxScenes, project, now, halfLifeDays })
  // Remember what this batch removed, keeping older entries: a scene deleted
  // now must not be rebuilt from unchanged facts on the next batch.
  for (const name of pruned.removed) evicted[name] = now
  writeEvicted(db, project, evicted)
  if (pruned.deleted > 0) {
    log(
      'debug',
      `l2 scenes pruned=${pruned.deleted} kept=${pruned.kept} evicted=${Object.keys(evicted).length}${pruned.protected.length > 0 ? ` protected=${pruned.protected.length}` : ''}`,
    )
  }
  return { updated, skipped, pruned: pruned.deleted }
}

/**
 * L3: rewrite the persona when due and worth it.
 *
 * Scheduling depends on `config.triggerMode`:
 *   - `current` (default): a fact-count trigger against the last real write
 *     decides on its own; the JEV gate is never consulted. Cheapest and the
 *     only mode where cost is bounded by a threshold.
 *   - `jev`: the trigger wins when it fires, and the gate only gets a chance
 *     when it does not — the gate is an addition, never a blocker.
 *   - `legacy`: the old batch counter plus a gate over the fact pool.
 *
 * Two personas share this function, and each keeps its own batch counter:
 *   - `scope:'project'` (default) summarizes this project's facts plus the
 *     global ones — "how this project gets built".
 *   - `scope:'global'` summarizes **only** global facts — "how to treat the
 *     user", shared by every project. A new project therefore gets a persona on
 *     its first session instead of waiting for its own fact pool to grow.
 *
 * A shared counter would let whichever scope rewrote last defer the other
 * forever (menm's persona sat 16.9h behind its facts while dsh kept resetting it).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} llm
 * @param {{ triggerMode?: 'current'|'jev'|'legacy', triggerEveryN?: number, defaultThreshold?: number, maxChars?: number, timeoutMs?: number, sessionId?: string, signal?: AbortSignal, force?: boolean }} config
 * @param {{ project?: string|null, scope?: 'project'|'global', now?: number, log?: (level: string, message: string) => void }} ctx
 * @returns {Promise<{ rewritten: boolean, version?: number, reason: string }>}
 */
export async function runPersona(db, llm, config = {}, ctx = {}) {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now()
  const scope = ctx.scope === 'global' ? 'global' : 'project'
  const project = scope === 'project' ? (ctx.project ?? null) : null
  const label = scope === 'global' ? '@global' : project
  /** Record the outcome: without this a silent no-op is undiagnosable. */
  const finish = (reason, extra = {}) => {
    setMeta(db, 'l3-last-at', String(now))
    setMeta(db, 'l3-last-reason', `${label}:${reason}`)
    if (Object.keys(extra).length > 0) setMeta(db, 'l3-last-detail', JSON.stringify({ at: now, scope, project, reason, ...extra }))
    return { rewritten: false, reason }
  }
  /** A fired trigger is one-shot: consume it once a generation actually ran. */
  const consumeTriggerSignals = () => {
    for (const key of [personaRequestKey(project), firstSceneKey(project)]) {
      db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    }
  }
  // `force` is the manual path (memory_compact): rewrite now, skip both the
  // batch threshold and the JEV gate.
  const force = config.force === true
  // A project persona without a project key can never be read back: every read
  // path filters on `project = ?` (listPersonas included), so the row would sit
  // in the database as a ghost while never being injected. Bail out before the
  // batch counter moves, so a cwd-less session cannot push it either.
  if (scope === 'project' && project === null) return finish('no-project')
  const mode = config.triggerMode === 'jev' || config.triggerMode === 'legacy' ? config.triggerMode : 'current'
  const triggerEveryN = Math.max(1, config.triggerEveryN ?? 10)
  // `current`/`jev` count **facts written since the last real persona write**
  // (upstream `memories_since_last_persona`, default 50). `triggerEveryN` keeps
  // its own meaning — L1 batches — for the `legacy` mode only.
  const factThreshold = Math.max(1, config.defaultThreshold ?? 50)
  // Judgment backend for `triggerMode: "jev"`: `llm` (host model, nothing to
  // configure) or `jev` (an external System One-compatible service). Both sit
  // behind the same choice protocol, so the scheduler never learns which one ran.
  const jevConfig = config.jev ?? {}
  const jevDiagnostics =
    jevConfig.diagnostics === 'off' || jevConfig.diagnostics === 'full' ? jevConfig.diagnostics : 'metadata'
  const maxChars = Math.max(200, config.maxChars ?? 1200)
  // The generator aims at `targetChars`; `maxChars` stays the hard cap. Without
  // this the model fills the cap and the persona crowds the stable block.
  const targetChars = Math.min(
    maxChars,
    Math.max(
      120,
      scope === 'global' ? config.globalTargetChars ?? 240 : config.targetChars ?? 700,
    ),
  )
  // Reasoning models spend output budget before the JSON answer; a persona body
  // is the longest thing this plugin asks for. Measured live: at the model's
  // configured `max effort` the whole 3000-token budget went to reasoning and
  // the answer came back as `finish=max-tokens, chars=0`. So: ask for low effort
  // first, then retry with a bigger budget, and finally fall back to the model
  // default effort (a provider that rejects the id still gets a chance).
  const personaTokens = Math.max(400, config.personaMaxTokens ?? 4_000)
  const personaTimeoutMs = Math.max(5_000, config.personaTimeoutMs ?? 120_000)
  const effort = typeof config.personaReasoningEffort === 'string' && config.personaReasoningEffort !== ''
    ? config.personaReasoningEffort
    : 'low'
  const personaAttempts = [
    { reasoningEffort: effort, maxTokens: personaTokens },
    { reasoningEffort: effort, maxTokens: Math.min(32_000, personaTokens * 4) },
    { reasoningEffort: undefined, maxTokens: Math.min(32_000, personaTokens * 4) },
  ]
  // Keep `l3-batches:<project>` unchanged for projects (existing installs have
  // it); the global persona gets its own key so the two never reset each other.
  const batchKey = scope === 'global' ? 'l3-batches:@global' : `l3-batches:${project}`
  const batches = Number(getMeta(db, batchKey) ?? 0) + 1
  addMeta(db, batchKey, 1)

  const facts =
    scope === 'global'
      ? db
          .prepare(
            `SELECT * FROM memory
              WHERE superseded_by IS NULL AND scope = 'global'
              ORDER BY priority DESC, updated_at DESC
              LIMIT ?`,
          )
          .all(CONSOLIDATE_LIMITS.personaFacts)
      : db
          .prepare(
            `SELECT * FROM memory
              WHERE superseded_by IS NULL
                AND (scope = 'global' OR project = ?)
              ORDER BY priority DESC, updated_at DESC
              LIMIT ?`,
          )
          .all(project, CONSOLIDATE_LIMITS.personaFacts)
  if (facts.length === 0) return finish('no-facts')

  const current = getPersona(db, { scope, project })
  // Everything below is answered against the last real write, not a batch count.
  const since = readWatermark(db, label)
  const sceneRows = listBucketScenes(db, { project })
  const freshScenes = changedScenesSince(db, { project, since })
  const freshFactCount = countFactsSince(db, { scope, project, since })
  /** Which branch this batch took; recorded in `l3-last-detail` for diagnosis. */
  let branch = 'forced'
  if (!force && mode === 'legacy') {
    branch = 'legacy'
    if (current !== undefined) {
      // An oversized persona is rewritten immediately: it does not fit the stable
      // budget, so whether the new facts are "worth" a rewrite no longer matters.
      const bloatLimit = Math.floor(targetChars * 1.4)
      if (current.body.length > bloatLimit) {
        setMeta(db, 'l3-last-compact', JSON.stringify({ at: now, scope, project, chars: current.body.length, limit: bloatLimit }))
        log('debug', `l3 compact (${scope} ${current.body.length} > ${bloatLimit} chars)`)
      } else {
        if (batches < triggerEveryN) return finish('deferred', { batches, triggerEveryN, chars: current.body.length })
        const gate = await askJson(llm, buildGatePrompt(current, facts), {
          maxTokens: 400,
          timeoutMs: config.timeoutMs,
          sessionId: ctx.sessionId,
          signal: ctx.signal,
        })
        track(db, gate.usage)
        const decision = typeof gate.value?.decision === 'string' ? gate.value.decision : 'none'
        if (!GATE_ACCEPT.has(decision)) {
          log('debug', `l3 gate deferred (${decision})`)
          return finish(`gate:${decision}`, { ok: gate.ok, error: gate.error, chars: gate.chars, head: gate.head })
        }
        branch = `gate:${decision}`
      }
    }
  } else if (!force) {
    const trigger = evaluatePersonaTrigger({
      current,
      sceneRows,
      freshFactCount,
      targetChars,
      factThreshold,
      poolSize: facts.length,
      requested: getMeta(db, personaRequestKey(project)) !== undefined,
      firstScene: getMeta(db, firstSceneKey(project)) !== undefined,
    })
    if (trigger.reason === 'bloat') {
      const bloatLimit = Math.floor(targetChars * 1.4)
      setMeta(db, 'l3-last-compact', JSON.stringify({ at: now, scope, project, chars: current?.body?.length ?? 0, limit: bloatLimit }))
      log('debug', `l3 compact (${scope} ${current?.body?.length ?? 0} > ${bloatLimit} chars)`)
    }
    // Nothing under an existing persona changed: the model could only restate
    // the same body, so the batch costs nothing (upstream generator short-cut).
    // `bloat` is exempt — an oversized body must shrink whether or not scenes moved.
    const nothingChanged =
      current !== undefined &&
      sceneRows.length > 0 &&
      freshScenes.length === 0 &&
      trigger.reason !== 'bloat' &&
      // A pending explicit request or the one-shot first-scene signal must be
      // consumed by a real generation, not swallowed by the restatement guard.
      trigger.reason !== 'requested' &&
      trigger.reason !== 'first-scene'
    if (mode === 'current') {
      if (!trigger.should) {
        log('debug', `l3 trigger deferred (${trigger.reason})`)
        return finish(`trigger:${trigger.reason}`, {
          trigger: trigger.reason,
          freshFacts: freshFactCount,
          scenes: freshScenes.length,
          chars: current?.body?.length ?? 0,
        })
      }
      if (nothingChanged) return finish('unchanged', { shortCircuit: true, trigger: trigger.reason, freshFacts: freshFactCount })
      branch = `trigger:${trigger.reason}`
    } else if (trigger.should) {
      // An existing trigger policy has priority and bypasses the gate.
      if (nothingChanged) return finish('unchanged', { shortCircuit: true, trigger: trigger.reason, freshFacts: freshFactCount })
      branch = `trigger:${trigger.reason}`
    } else {
      // Nothing moved: the gate would have to judge an empty diff, so say so
      // without building the state or touching the provider.
      if (nothingChanged) {
        return finish('unchanged', { shortCircuit: true, gate: 'skipped', trigger: trigger.reason, freshFacts: freshFactCount })
      }
      // The gate only runs when the trigger stayed quiet, and it judges the
      // scene diff — never the fact pool.
      const state = buildGateState(current, freshScenes)
      if (state === null) {
        recordGate(db, log, jevDiagnostics, {
          at: now,
          scope,
          project: project ?? null,
          event: 'decision',
          action: 'not_applicable',
          reason: 'no_changed_scenes',
          scenes: freshScenes.length,
        })
        return finish('gate:not_applicable', { trigger: trigger.reason, scenes: freshScenes.length, freshFacts: freshFactCount })
      }
      const providerName = typeof jevConfig.provider === 'string' && jevConfig.provider !== '' ? jevConfig.provider : 'llm'
      let provider
      try {
        const apiKey = providerName === 'jev' ? await resolveDecisionApiKey(jevConfig.apiKeyRef, ctx.resolveSecret) : ''
        provider = createDecisionProvider(
          providerName,
          {
            endpoint: jevConfig.endpoint ?? '',
            apiKey,
            model: jevConfig.model ?? '',
            timeoutMs: jevConfig.timeoutMs,
          },
          { llm, fetcher: ctx.fetcher },
        )
      } catch (error) {
        const reason = error instanceof DecisionProviderError ? error.reason : 'invalid_config'
        log('warn', `l3 jev provider "${providerName}" unusable (${reason}); persona left untouched`)
        recordGate(db, log, jevDiagnostics, {
          at: now,
          scope,
          project: project ?? null,
          event: 'decision',
          action: 'unavailable',
          provider: providerName,
          reason,
          stateChars: state.length,
        })
        return finish('gate:invalid_config', { provider: providerName, reason })
      }
      // A remote provider object exists even when it is missing endpoint/model/key;
      // asking it would only burn a call to learn the same thing.
      if (typeof provider.isUsable === 'function' && provider.isUsable() !== true) {
        log('warn', `l3 jev provider "${provider.name}" is not usable (missing endpoint/model/key); persona left untouched`)
        recordGate(db, log, jevDiagnostics, {
          at: now,
          scope,
          project: project ?? null,
          event: 'decision',
          action: 'unavailable',
          provider: provider.name,
          reason: 'invalid_config',
          stateChars: state.length,
        })
        return finish('gate:invalid_config', { provider: provider.name, reason: 'invalid_config' })
      }
      const gateStarted = Date.now()
      try {
        const answers = await provider.askChoices(
          state,
          [{ id: DECISION_QUESTION_ID, instructions: JEV_INSTRUCTIONS, criteria: JEV_CRITERIA }],
          { timeoutMs: jevConfig.timeoutMs, signal: ctx.signal, sessionId: ctx.sessionId },
        )
        const answer = answers.get(DECISION_QUESTION_ID)
        if (answer?.usage) track(db, answer.usage)
        const decision = typeof answer?.choice === 'string' ? answer.choice : 'none'
        const immediate = GATE_ACCEPT.has(decision)
        recordGate(db, log, jevDiagnostics, {
          at: now,
          scope,
          project: project ?? null,
          event: 'decision',
          action: immediate ? 'immediate' : 'defer',
          label: decision,
          provider: provider.name,
          providerModel: provider.model,
          latencyMs: Date.now() - gateStarted,
          stateChars: state.length,
          ...(answer?.confidence === undefined ? {} : { confidence: answer.confidence }),
        })
        if (!immediate) {
          log('debug', `l3 gate deferred (${decision})`)
          return finish(`gate:${decision}`, { trigger: trigger.reason, provider: provider.name, chars: state.length })
        }
        branch = `gate:${decision}`
      } catch (error) {
        const reason = error instanceof DecisionProviderError ? error.reason : 'fetch_failed'
        const status = error instanceof DecisionProviderError ? error.status : undefined
        log('warn', `l3 jev unavailable (${reason}${status === undefined ? '' : ` http=${status}`}); persona left untouched`)
        recordGate(db, log, jevDiagnostics, {
          at: now,
          scope,
          project: project ?? null,
          event: 'decision',
          action: 'unavailable',
          provider: provider.name,
          providerModel: provider.model,
          reason,
          ...(status === undefined ? {} : { status }),
          latencyMs: Date.now() - gateStarted,
          stateChars: state.length,
        })
        return finish('gate:unavailable', { provider: provider.name, reason, status, chars: state.length })
      }
    }
  }

  const promptFacts = mode !== 'legacy' && since !== null && freshFactCount > 0
    ? factsSince(db, { scope, project, since })
    : facts
  const prompt = buildPersonaPrompt(
    promptFacts,
    current ?? {},
    { maxChars, targetChars },
    scope,
    mode === 'legacy' ? {} : { scenes: freshScenes, incremental: current !== undefined, since },
  )
  let body = ''
  let usage = null
  /** @type {Array<Record<string, unknown>>} */
  const tried = []
  let last = null
  /** Whatever the model said: `{mode:'write'|'patch'|'none', body?, edits?}`. */
  let answer = null
  for (const plan of personaAttempts) {
    last = await askJson(llm, prompt, {
      maxTokens: plan.maxTokens,
      reasoningEffort: plan.reasoningEffort,
      timeoutMs: personaTimeoutMs,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    })
    if (last.usage) {
      usage = usage === null
        ? last.usage
        : { inputTokens: Number(usage.inputTokens ?? 0) + Number(last.usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) + Number(last.usage.outputTokens ?? 0) }
    }
    answer = last.value && typeof last.value === 'object' ? last.value : null
    body = answer && typeof answer.body === 'string' ? answer.body.trim() : ''
    const edits = answer && answer.mode === 'patch' && Array.isArray(answer.edits) ? answer.edits : []
    tried.push({ tokens: plan.maxTokens, effort: plan.reasoningEffort ?? 'default', ok: last.ok, finish: last.reason, chars: last.chars })
    if (body !== '' || edits.length > 0 || (answer && answer.mode === 'none')) break
  }
  // `none` is a decision, not a failure: the model judged the delta not worth a
  // rewrite. Nothing is written and the watermark does not move — but the
  // one-shot trigger signals have been consumed.
  if (answer && answer.mode === 'none' && body === '') {
    track(db, usage)
    consumeTriggerSignals()
    log('debug', `l3 persona unchanged (${scope}): the model chose not to rewrite`)
    return finish('unchanged', { mode: 'none', attempts: tried })
  }
  /** Patch outcome, carried into the diagnostics written on success. */
  let patchInfo = null
  if (body === '' && answer && answer.mode === 'patch' && Array.isArray(answer.edits) && answer.edits.length > 0) {
    if (current === undefined) {
      patchInfo = { hit: 0, edits: answer.edits.length, misses: [{ reason: 'no-current-persona' }] }
    } else {
      const applied = applyPersonaPatch(current.body, answer.edits)
      patchInfo = { hit: applied.hit, edits: answer.edits.length, misses: applied.misses.slice(0, 5) }
      // An empty result would make `putPersona` throw; treat it as a miss.
      if (applied.hit > 0 && normalizeBody(applied.text) !== '') body = normalizeBody(applied.text)
    }
    if (body === '') {
      track(db, usage)
      log('warn', `l3 persona patch missed (${scope}): ${answer.edits.length} edit(s), none matched the current body`)
      return finish('patch-miss', { mode: 'patch', edits: answer.edits.length, misses: patchInfo.misses })
    }
  }
  if (body === '') {
    track(db, usage)
    const detail = { attempts: tried, error: last?.error ?? null, head: last?.head ?? '' }
    log('warn', `l3 persona rewrite produced nothing usable (${scope}): ${JSON.stringify(tried)}`)
    return finish('empty', detail)
  }
  // The generator treats "about N chars" as advice (asked for ~700 it wrote
  // 2_600). One dedicated compression pass keeps the important sections, and a
  // line-boundary trim is the last-resort guard so the stored body always fits.
  if (body.length > targetChars) {
    const compressPrompt = buildPersonaCompressPrompt(body, targetChars)
    // The compression call hits the same reason-wall as the generation call, so
    // it escalates the same way instead of giving up on the first max-tokens.
    const compressPlans = [
      { reasoningEffort: effort, maxTokens: Math.min(4_000, personaTokens) },
      { reasoningEffort: effort, maxTokens: Math.min(16_000, Math.max(8_000, personaTokens)) },
      { reasoningEffort: undefined, maxTokens: Math.min(16_000, Math.max(8_000, personaTokens)) },
    ]
    for (const plan of compressPlans) {
      const compressed = await askJson(llm, compressPrompt, {
        maxTokens: plan.maxTokens,
        reasoningEffort: plan.reasoningEffort,
        timeoutMs: personaTimeoutMs,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      })
      if (compressed.usage) {
        usage = usage === null
          ? compressed.usage
          : { inputTokens: Number(usage.inputTokens ?? 0) + Number(compressed.usage.inputTokens ?? 0), outputTokens: Number(usage.outputTokens ?? 0) + Number(compressed.usage.outputTokens ?? 0) }
      }
      const shorter = compressed.value && typeof compressed.value.body === 'string' ? compressed.value.body.trim() : ''
      tried.push({
        stage: 'compress',
        tokens: plan.maxTokens,
        effort: plan.reasoningEffort ?? 'default',
        ok: compressed.ok,
        finish: compressed.reason,
        chars: compressed.chars,
        bodyChars: shorter.length,
      })
      if (shorter !== '' && shorter.length < body.length) {
        body = shorter
        break
      }
    }
  }
  track(db, usage)
  const trimmed = trimPersonaBody(body, Math.min(maxChars, targetChars))
  // The model restating the existing body is not a rewrite: keep the row, keep
  // the watermark, and say so instead of bumping the version for nothing.
  if (current !== undefined && !force && normalizeBody(trimmed.text) === normalizeBody(current.body)) {
    consumeTriggerSignals()
    log('debug', `l3 persona unchanged (${scope}): model restated the current body`)
    return finish('unchanged', { chars: trimmed.text.length, rawChars: body.length, branch, attempts: tried })
  }
  const result = putPersona(db, {
    scope,
    project,
    body: trimmed.text,
    now,
  })
  consumeTriggerSignals()
  // Patch accounting: how many edits the model proposed, how many actually
  // matched the body. This is the number that tells "relabelled" from "rewrote".
  if (patchInfo !== null) {
    let previous = {}
    try {
      const parsed = JSON.parse(getMeta(db, 'l3-patch-stats') ?? '{}')
      if (parsed !== null && typeof parsed === 'object') previous = parsed
    } catch {
      /* a corrupt counter must never block a write */
    }
    setMeta(db, 'l3-patch-stats', JSON.stringify({
      writes: Number(previous.writes ?? 0) + 1,
      patches: Number(previous.patches ?? 0) + 1,
      edits: Number(previous.edits ?? 0) + patchInfo.edits,
      hits: Number(previous.hits ?? 0) + patchInfo.hit,
      misses: Number(previous.misses ?? 0) + patchInfo.misses.length,
    }))
  }
  setMeta(db, batchKey, 0)
  // Only a real write moves the baseline: deferred, unchanged and failed runs
  // must leave `since` alone so the next batch judges the same delta.
  setMeta(db, watermarkKey(label), String(now))
  setMeta(db, 'l3-last-at', String(now))
  setMeta(db, 'l3-last-reason', `${label}:written`)
  setMeta(db, 'l3-last-detail', JSON.stringify({
    at: now,
    scope,
    project,
    reason: 'written',
    branch,
    mode: patchInfo === null ? 'write' : 'patch',
    ...(patchInfo === null ? {} : { patch: patchInfo }),
    chars: trimmed.text.length,
    rawChars: body.length,
    trimmed: trimmed.trimmed,
    forced: force,
    freshFacts: freshFactCount,
    freshScenes: freshScenes.map((scene) => scene.name),
    attempts: tried,
  }))
  log('info', `l3 persona rewritten (${scope} v${result.version}${force ? ', forced' : ''}, ${trimmed.text.length}/${body.length} chars)`)
  return { rewritten: true, version: result.version, reason: 'written' }
}
