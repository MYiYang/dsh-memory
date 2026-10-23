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
 * @returns {{ system: string, user: string }}
 */
export function buildPersonaPrompt(facts, existing = {}, limits = 1200, scope = 'project') {
  const maxChars = typeof limits === 'number' ? limits : Math.max(200, limits?.maxChars ?? 1200)
  const targetChars = typeof limits === 'number' ? null : limits?.targetChars ?? null
  const lines = facts.slice(0, CONSOLIDATE_LIMITS.personaFacts).map(
    (row) => `- [${row.kind}${row.scope === 'global' ? '/global' : ''}] ${clip(row.text, 240)}`,
  )
  return {
    system: PERSONA_SYSTEM,
    user: [
      `目标画像：${scope === 'global' ? '全局画像' : '项目画像'}`,
      existing.body ? `现有画像：\n${clip(existing.body, 900)}` : '现有画像：无',
      targetChars === null
        ? `目标长度：不超过 ${maxChars} 字。`
        : `长度硬性上限：${targetChars} 字（超出部分会被直接截断丢弃，只保留前几个小标题）。写不下就删次要内容，不要为凑长度灌水。`,
      '压缩要求：与「长期约定」或其他层重复的内容不要写；同一个意思只写一次；优先保留命令、路径、约束这类可执行信息。',
      '事实：',
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
    system: PERSONA_SYSTEM,
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
  const label = scope === 'global' ? '@global' : project
  /** Record the outcome: without this a silent no-op is undiagnosable. */
  const finish = (reason, extra = {}) => {
    setMeta(db, 'l3-last-at', String(now))
    setMeta(db, 'l3-last-reason', `${label}:${reason}`)
    if (Object.keys(extra).length > 0) setMeta(db, 'l3-last-detail', JSON.stringify({ at: now, scope, project, reason, ...extra }))
    return { rewritten: false, reason }
  }
  // `force` is the manual path (memory_compact): rewrite now, skip both the
  // batch threshold and the JEV gate.
  const force = config.force === true
  // A project persona without a project key can never be read back: every read
  // path filters on `project = ?` (listPersonas included), so the row would sit
  // in the database as a ghost while never being injected. Bail out before the
  // batch counter moves, so a cwd-less session cannot push it either.
  if (scope === 'project' && project === null) return finish('no-project')
  const triggerEveryN = Math.max(1, config.triggerEveryN ?? 10)
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
  if (current !== undefined && !force) {
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
      if (!['conflict', 'boundary_change', 'new_rule'].includes(decision)) {
        log('debug', `l3 gate deferred (${decision})`)
        return finish(`gate:${decision}`, { ok: gate.ok, error: gate.error, chars: gate.chars, head: gate.head })
      }
    }
  }

  const prompt = buildPersonaPrompt(facts, current ?? {}, { maxChars, targetChars }, scope)
  let body = ''
  let usage = null
  /** @type {Array<Record<string, unknown>>} */
  const tried = []
  let last = null
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
    body = last.value && typeof last.value.body === 'string' ? last.value.body.trim() : ''
    tried.push({ tokens: plan.maxTokens, effort: plan.reasoningEffort ?? 'default', ok: last.ok, finish: last.reason, chars: last.chars })
    if (body !== '') break
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
  const result = putPersona(db, {
    scope,
    project,
    body: trimmed.text,
    now,
  })
  setMeta(db, batchKey, 0)
  setMeta(db, 'l3-last-at', String(now))
  setMeta(db, 'l3-last-reason', `${label}:written`)
  setMeta(db, 'l3-last-detail', JSON.stringify({
    at: now,
    scope,
    project,
    reason: 'written',
    chars: trimmed.text.length,
    rawChars: body.length,
    trimmed: trimmed.trimmed,
    forced: force,
    attempts: tried,
  }))
  log('info', `l3 persona rewritten (${scope} v${result.version}${force ? ', forced' : ''}, ${trimmed.text.length}/${body.length} chars)`)
  return { rewritten: true, version: result.version, reason: 'written' }
}
