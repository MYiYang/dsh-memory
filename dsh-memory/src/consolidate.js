/**
 * L2/L3 consolidation: turn L1 facts into scene blocks and a persona.
 *
 * Both steps are optional, sequential, and failure-isolated: a failed scene
 * summary or persona rewrite leaves the previous content in place.
 *
 * @module dsh-memory/consolidate
 */
import { addMeta, getMeta, setMeta } from './store.js'
import { getPersona, listScenes, putPersona, upsertScene } from './profile.js'
import { parseJsonLoose } from './extract.js'

export const SCENE_SYSTEM = [
  '你是场景归并器。把一批事实归并成一个简洁的场景块。',
  '只输出 JSON，不要解释：{"summary":"一句话摘要（<=60字）","body":"Markdown 正文（分要点/约定/坑，<=800字）"}',
  '只使用给定事实，不要编造；合并重复，删除过时内容。',
].join('\n')

export const PERSONA_SYSTEM = [
  '你是画像整理器。把长期事实整理成稳定的项目画像 Markdown。',
  '只输出 JSON，不要解释：{"body":"Markdown 画像"}',
  '固定小标题（缺内容可省略）：## 用户偏好 / ## 项目约定 / ## 关键决策 / ## 环境与工具。',
  '只使用给定事实，不要编造；只保留长期有效的内容，不要写一次性事件。',
].join('\n')

export const GATE_SYSTEM = [
  '判断这批新事实是否值得重写画像。只输出 JSON：{"decision":"conflict|boundary_change|new_rule|reinforcement|none"}',
  '- conflict：与现有画像矛盾，必须改',
  '- boundary_change：适用边界/范围变了',
  '- new_rule：出现新的硬规则或长期约定',
  '- reinforcement：只是重复确认已有内容',
  '- none：与画像无关',
].join('\n')

/** Maximum scenes rewritten per L1 batch (cost guard). */
export const CONSOLIDATE_LIMITS = { sceneUpdates: 3, sceneFacts: 20, personaFacts: 30 }

/** Clamp a string for a prompt line. */
function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/**
 * Group active facts by scene name.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ project?: string|null }} options
 * @returns {Map<string, Array<Record<string, any>>>}
 */
export function factsByScene(db, options = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM memory
        WHERE superseded_by IS NULL AND scene IS NOT NULL AND scene <> ''
          AND (scope = 'global' OR project = ?)
        ORDER BY priority DESC, updated_at DESC
        LIMIT 300`,
    )
    .all(options.project ?? null)
  const groups = new Map()
  for (const row of rows) {
    const name = String(row.scene ?? '').trim()
    if (name === '') continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(row)
  }
  return groups
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
 * @param {Array<Record<string, any>>} facts
 * @param {{ body?: string }} [existing]
 * @param {number} [maxChars]
 * @returns {{ system: string, user: string }}
 */
export function buildPersonaPrompt(facts, existing = {}, maxChars = 1200) {
  const lines = facts.slice(0, CONSOLIDATE_LIMITS.personaFacts).map(
    (row) => `- [${row.kind}${row.scope === 'global' ? '/global' : ''}] ${clip(row.text, 240)}`,
  )
  return {
    system: PERSONA_SYSTEM,
    user: [
      existing.body ? `现有画像：\n${clip(existing.body, 900)}` : '现有画像：无',
      `目标长度：不超过 ${maxChars} 字。`,
      '事实：',
      ...lines,
      '只输出约定的 JSON。',
    ].join('\n'),
  }
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
 * One model round-trip; returns parsed JSON or null.
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
    signal: options.signal,
    sessionId: options.sessionId,
  })
  if (!response?.ok) return { value: null, usage: response?.usage ?? null }
  return { value: parseJsonLoose(response.text), usage: response.usage ?? null }
}

/** Record consolidation token usage against the shared counter. */
function track(db, usage) {
  if (!usage) return
  addMeta(db, 'l1_tokens_total', Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0))
}

/**
 * L2: rewrite scenes whose fact set grew since the last summary.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} llm
 * @param {{ minFacts?: number, maxScenes?: number, timeoutMs?: number, sessionId?: string, signal?: AbortSignal }} config
 * @param {{ project?: string|null, now?: number, log?: (level: string, message: string) => void }} ctx
 * @returns {Promise<{ updated: number, skipped: number }>}
 */
export async function runScenes(db, llm, config = {}, ctx = {}) {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now()
  const minFacts = Math.max(1, config.minFacts ?? 3)
  const groups = factsByScene(db, { project: ctx.project ?? null })
  const existing = new Map(listScenes(db, { project: ctx.project ?? null, now, limit: 100 }).map((row) => [row.name, row]))
  let updated = 0
  let skipped = 0
  for (const [name, facts] of groups) {
    if (updated >= CONSOLIDATE_LIMITS.sceneUpdates) break
    if (facts.length < minFacts) {
      skipped += 1
      continue
    }
    const row = existing.get(name)
    if (row && Number(row.fact_count ?? 0) >= facts.length) {
      skipped += 1
      continue
    }
    const prompt = buildScenePrompt(name, facts, row ?? {})
    const { value, usage } = await askJson(llm, prompt, {
      maxTokens: 700,
      timeoutMs: config.timeoutMs,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    })
    track(db, usage)
    const summary = value && typeof value.summary === 'string' ? clip(value.summary, 120) : ''
    const body = value && typeof value.body === 'string' ? String(value.body).trim() : ''
    if (summary === '' && body === '') {
      skipped += 1
      continue
    }
    upsertScene(db, {
      scope: 'project',
      project: ctx.project ?? null,
      name,
      summary: summary || row?.summary || '',
      body: body || row?.body || '',
      factCount: facts.length,
      heatDelta: 1,
      now,
    })
    updated += 1
  }
  if (updated > 0) log('debug', `l2 scenes updated=${updated} skipped=${skipped}`)
  return { updated, skipped }
}

/**
 * L3: rewrite the persona when due and worth it (JEV-lite gate).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} llm
 * @param {{ triggerEveryN?: number, maxChars?: number, timeoutMs?: number, sessionId?: string, signal?: AbortSignal }} config
 * @param {{ project?: string|null, now?: number, log?: (level: string, message: string) => void }} ctx
 * @returns {Promise<{ rewritten: boolean, version?: number, reason: string }>}
 */
export async function runPersona(db, llm, config = {}, ctx = {}) {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now()
  const triggerEveryN = Math.max(1, config.triggerEveryN ?? 10)
  const maxChars = Math.max(200, config.maxChars ?? 1200)
  const batches = Number(getMeta(db, 'l3-batches') ?? 0) + 1
  addMeta(db, 'l3-batches', 1)

  const facts = db
    .prepare(
      `SELECT * FROM memory
        WHERE superseded_by IS NULL
          AND (scope = 'global' OR project = ?)
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(ctx.project ?? null, CONSOLIDATE_LIMITS.personaFacts)
  if (facts.length === 0) return { rewritten: false, reason: 'no-facts' }

  const current = getPersona(db, { scope: 'project', project: ctx.project ?? null })
  if (current !== undefined) {
    if (batches < triggerEveryN) return { rewritten: false, reason: 'deferred' }
    const gate = await askJson(llm, buildGatePrompt(current, facts), {
      maxTokens: 120,
      timeoutMs: config.timeoutMs,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    })
    track(db, gate.usage)
    const decision = typeof gate.value?.decision === 'string' ? gate.value.decision : 'none'
    if (!['conflict', 'boundary_change', 'new_rule'].includes(decision)) {
      log('debug', `l3 gate deferred (${decision})`)
      return { rewritten: false, reason: `gate:${decision}` }
    }
  }

  const prompt = buildPersonaPrompt(facts, current ?? {}, maxChars)
  const { value, usage } = await askJson(llm, prompt, {
    maxTokens: 1_200,
    timeoutMs: config.timeoutMs,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
  })
  track(db, usage)
  const body = value && typeof value.body === 'string' ? value.body.trim() : ''
  if (body === '') return { rewritten: false, reason: 'empty' }
  const result = putPersona(db, {
    scope: 'project',
    project: ctx.project ?? null,
    body: body.slice(0, maxChars),
    now,
  })
  setMeta(db, 'l3-batches', 0)
  log('info', `l3 persona rewritten (v${result.version})`)
  return { rewritten: true, version: result.version, reason: 'written' }
}
