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

export const SCENE_SYSTEM = [
  '你是场景归并器。把一批事实归并成一个简洁的场景块。',
  '只输出 JSON，不要解释：{"summary":"一句话摘要（<=60字）","body":"Markdown 正文（分要点/约定/坑，<=800字）"}',
  '只使用给定事实，不要编造；合并重复，删除过时内容。',
].join('\n')

export const PERSONA_SYSTEM = [
  '你是画像整理器。把长期事实整理成稳定的长期画像 Markdown（项目级与全局级通用）。',
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
 * @param {'global'|'project'} [scope] - which persona is being written
 * @returns {{ system: string, user: string }}
 */
export function buildPersonaPrompt(facts, existing = {}, maxChars = 1200, scope = 'project') {
  const lines = facts.slice(0, CONSOLIDATE_LIMITS.personaFacts).map(
    (row) => `- [${row.kind}${row.scope === 'global' ? '/global' : ''}] ${clip(row.text, 240)}`,
  )
  return {
    system: PERSONA_SYSTEM,
    user: [
      `目标画像：${scope === 'global' ? '全局画像' : '项目画像'}`,
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
  for (const [name, facts] of groups) {
    if (updated >= CONSOLIDATE_LIMITS.sceneUpdates) break
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
      project,
      name,
      summary: summary || row?.summary || '',
      body: body || row?.body || '',
      factCount: facts.length,
      heatDelta: 1,
      now,
    })
    // The scene is back: drop the eviction entry so the marker stays small.
    delete evicted[name]
    updated += 1
  }
  if (updated > 0) log('debug', `l2 scenes updated=${updated} skipped=${skipped}`)
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
 * L3: rewrite the persona when due and worth it (JEV-lite gate).
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
 * @param {{ triggerEveryN?: number, maxChars?: number, timeoutMs?: number, sessionId?: string, signal?: AbortSignal }} config
 * @param {{ project?: string|null, scope?: 'project'|'global', now?: number, log?: (level: string, message: string) => void }} ctx
 * @returns {Promise<{ rewritten: boolean, version?: number, reason: string }>}
 */
export async function runPersona(db, llm, config = {}, ctx = {}) {
  const log = ctx.log ?? (() => {})
  const now = ctx.now ?? Date.now()
  const scope = ctx.scope === 'global' ? 'global' : 'project'
  const project = scope === 'project' ? (ctx.project ?? null) : null
  // A project persona without a project key can never be read back: every read
  // path filters on `project = ?` (listPersonas included), so the row would sit
  // in the database as a ghost while never being injected. Bail out before the
  // batch counter moves, so a cwd-less session cannot push it either.
  if (scope === 'project' && project === null) return { rewritten: false, reason: 'no-project' }
  const triggerEveryN = Math.max(1, config.triggerEveryN ?? 10)
  const maxChars = Math.max(200, config.maxChars ?? 1200)
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
  if (facts.length === 0) return { rewritten: false, reason: 'no-facts' }

  const current = getPersona(db, { scope, project })
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

  const prompt = buildPersonaPrompt(facts, current ?? {}, maxChars, scope)
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
    scope,
    project,
    body: body.slice(0, maxChars),
    now,
  })
  setMeta(db, batchKey, 0)
  log('info', `l3 persona rewritten (${scope} v${result.version})`)
  return { rewritten: true, version: result.version, reason: 'written' }
}
