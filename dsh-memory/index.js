/**
 * dsh-memory — cross-session memory for DeepSeek Harness.
 *
 * Three jobs:
 *   1. Capture: every completed turn becomes one searchable episode
 *      (user prompt + assistant conclusion + tool names).
 *   2. Recall: before each turn's first model call, search the local memory
 *      database with the turn's user prompt and inject the best matches as one
 *      `plugin` / `recall` context message.
 *   3. Tools: memory_search / memory_save / memory_forget / memory_stats so the
 *      model (and the user) can curate what is remembered.
 *
 * Everything is local: `node:sqlite` + FTS5, no network, no extra process.
 * Every failure degrades to "no memory" and is logged — a broken plugin must
 * never break a conversation.
 *
 * @module dsh-memory
 */
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, saveMemory, forgetMemories, stats, getMeta, coreMemories, touchMemories, CORE_PRIORITY } from './src/store.js'
import { recall, renderMemoryBlock, renderStableBlock } from './src/recall.js'
import { captureTurn, extractText } from './src/capture.js'
import { appendTurn, pendingSessionIds } from './src/l0.js'
import { listPersonas, sceneNavigation } from './src/profile.js'
import { createScheduler } from './src/scheduler.js'
import { createPipeline } from './src/pipeline.js'
import { createLlmClient } from './src/llm.js'
import { registerBundledSkills } from './src/skills.js'

export const name = 'memory'
export const inject = ['tools', 'agents', 'sessions']

/** Plugin tag used in log lines. */
const TAG = '[dsh-memory]'

/**
 * Resolve the database path from config / DSH_HOME.
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function resolveDbPath(config) {
  if (typeof config.dbPath === 'string' && config.dbPath.trim() !== '') {
    return String(config.dbPath).replace(/^~(?=$|[\\/])/, homedir())
  }
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'memory', 'memory.db')
}

/**
 * Normalize the loader-provided config.
 * @param {unknown} raw
 */
function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback
  const section = (value) => (value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {})
  const layers = section(config.layers)
  const extraction = section(config.extraction)
  const scenes = section(config.scenes)
  const persona = section(config.persona)
  const vector = section(config.vector)
  const text = (value, fallback = '') => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  return {
    dbPath: resolveDbPath(config),
    maxItems: number(config.maxItems, 6, 1, 20),
    maxChars: number(config.maxChars, 1400, 200, 8000),
    minScore: number(config.minScore, 0.2, 0, 1),
    capture: config.capture !== false,
    injectGlobalFacts: config.injectGlobalFacts !== false,
    scope: config.scope === 'global' ? 'global' : 'project',
    stableMaxChars: number(config.stableMaxChars, 1800, 300, 6000),
    core: {
      enabled: section(config.core).enabled !== false,
      maxItems: number(section(config.core).maxItems, 6, 1, 20),
      minPriority: number(section(config.core).minPriority, CORE_PRIORITY, 0, 100),
    },
    debug: config.debug === true,
    layers: {
      l0: layers.l0 !== false,
      l1: layers.l1 !== false,
      l2: layers.l2 !== false,
      l3: layers.l3 !== false,
    },
    extraction: {
      enabled: extraction.enabled !== false,
      provider: text(extraction.provider),
      model: text(extraction.model),
      everyN: number(extraction.everyN, 5, 1, 100),
      idleMs: number(extraction.idleMs, 60_000, 1_000, 3_600_000),
      maxInputChars: number(extraction.maxInputChars, 8_000, 500, 60_000),
      maxMemories: number(extraction.maxMemories, 10, 1, 50),
      maxAttempts: number(extraction.maxAttempts, 3, 1, 10),
      timeoutMs: number(extraction.timeoutMs, 60_000, 1_000, 300_000),
      maxTokens: number(extraction.maxTokens, 2400, 64, 8192),
    },
    scenes: {
      enabled: scenes.enabled !== false,
      minFacts: number(scenes.minFacts, 3, 1, 20),
      maxScenes: number(scenes.maxScenes, 20, 1, 100),
      halfLifeDays: number(scenes.halfLifeDays, 14, 1, 365),
    },
    persona: {
      enabled: persona.enabled !== false,
      triggerEveryN: number(persona.triggerEveryN, 10, 1, 100),
      maxChars: number(persona.maxChars, 1200, 200, 8000),
      // L3 also maintains a cross-project profile built from global facts.
      // It has its own batch counter and gate, so it never starves the project one.
      global: persona.global !== false,
    },
    vector: {
      enabled: vector.enabled !== false,
      weight: number(vector.weight, 0.1, 0, 1),
      scanLimit: number(vector.scanLimit, 2000, 0, 5000),
      // Inverted n-gram feature index used as a lexical prefilter before the
      // exact cosine rerank; false forces the bounded brute-force scan only.
      prefilter: vector.prefilter !== false,
      // Query-side feature cap for the pre-filter probe (stored features are
      // fixed at 96 by feature-index.js; probing is capped again at 48).
      featureLimit: number(vector.featureLimit, 96, 16, 96),
    },
    // Bundled skills shipped inside this package (`./skills`).
    skills: {
      enabled: section(config.skills).enabled !== false,
      dir: text(section(config.skills).dir),
    },
  }
}

/**
 * Project key from a session's cwd (basename), or null.
 * @param {{ header?: { cwd?: unknown } } | undefined} session
 * @returns {string|null}
 */
function projectOf(session) {
  try {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return null
    return basename(cwd) || null
  } catch {
    return null
  }
}

/**
 * Build one injected user message.
 *
 * Built by hand (instead of `createUserMessage`) so the plugin carries no
 * import of `@deepseek-ai/dsh-llm` and can be installed by copy alone.
 *
 * `source.kind` must be a **producer-owned** kind: DSH session format v4
 * rejects the retired wrapper `{ kind: 'plugin', plugin: '<name>' }` with
 * "format v4 message requires a producer-owned source kind". A third-party
 * plugin owns the `plugin:<package-name>` namespace, so emit that directly
 * (the same kind the v3→v4 migration rewrites the wrapper to).
 * @param {string} text
 */
function contextMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-memory', form: 'recall' },
  }
}

/** True when the session belongs to a delegated child agent (not the human's main chat). */
function isSubagentSession(session) {
  try {
    const header = session?.header ?? {}
    return header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0
  } catch {
    return false
  }
}

/** True when at least one entering message is a real human prompt. */
function isHumanTurn(messages) {
  return Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')
}

/**
 * Text of the human prompt that opens this step: prefer the entering messages
 * (authoritative for the current step), fall back to the session log.
 * @param {ReadonlyArray<any>|undefined} messages
 * @param {{ events?: ReadonlyArray<{ type?: string, data?: any }> } | undefined} session
 * @returns {string}
 */
function userTextOf(messages, session) {
  try {
    if (Array.isArray(messages)) {
      // The entering messages are authoritative: if this step carries a human
      // message, use *its* text even when it is empty (attachment-only turn).
      // Falling back to "the last non-empty user text in the log" would answer
      // the previous question again on a turn that asked nothing.
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.source?.kind !== 'user') continue
        return extractText(message.content)
      }
    }
  } catch {
    /* ignore */
  }
  return lastUserText(session)
}

/**
 * Text of the newest human-authored user message in the session log.
 * @param {{ events?: ReadonlyArray<{ type?: string, data?: any }> } | undefined} session
 * @returns {string}
 */
function lastUserText(session) {
  try {
    const events = session?.events
    if (!Array.isArray(events)) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue
      const text = extractText(event.data?.content)
      if (text !== '') return text
    }
  } catch {
    /* ignore */
  }
  return ''
}

/**
 * Register the plugin.
 * @param {any} ctx - cordis context
 * @param {unknown} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = (level, message) => {
    try {
      const logger = ctx.logger ?? console
      const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger)
      fn?.(`${TAG} ${message}`)
    } catch {
      /* logging must never throw */
    }
  }

  /** Database handle; opened eagerly but failures only disable the plugin. */
  let db
  let dbReady = false
  const getDb = () => {
    if (db === undefined) {
      db = openDatabase(config.dbPath)
      log('info', `memory db ready: ${config.dbPath}`)
    }
    return db
  }
  try {
    getDb()
    dbReady = true
  } catch (error) {
    log('error', `cannot open memory db (${config.dbPath}): ${error instanceof Error ? error.message : String(error)}`)
  }

  // ── Bundled skills: expose ./skills through the host skill registry ───────
  // Done in memory (a provider), not by copying into ~/.dsh/skills: a published
  // package cannot rely on postinstall (pnpm blocks dependency build scripts)
  // and must not guess the user's home layout. Independent of the db: a broken
  // memory store should not hide the skills.
  if (config.skills.enabled) {
    try {
      registerBundledSkills(ctx, { dir: config.skills.dir || undefined, log })
    } catch (error) {
      log('warn', `bundled skills disabled: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── L0/L1 pipeline: extraction only when enabled and a model is resolvable ──
  /** @type {ReturnType<typeof createPipeline>|null} */
  let pipeline = null
  /** @type {ReturnType<typeof createScheduler>|null} */
  let scheduler = null
  if (dbReady && config.layers.l1 && config.extraction.enabled) {
    try {
      const llm = createLlmClient(ctx, config.extraction, log)
      if (llm.available) {
        pipeline = createPipeline({ db: getDb(), llm, config, log })
        scheduler = createScheduler({
          db: getDb(),
          everyN: config.extraction.everyN,
          idleMs: config.extraction.idleMs,
          onDue: (sessionId, reason) => pipeline?.schedule(sessionId, reason),
        })
        log('debug', `extraction on (everyN=${config.extraction.everyN}, idleMs=${config.extraction.idleMs})`)
      }
    } catch (error) {
      log('warn', `extraction disabled: ${error instanceof Error ? error.message : String(error)}`)
      pipeline = null
      scheduler = null
    }
  }

  ctx.effect(() => {
    return () => {
      try {
        scheduler?.dispose()
      } catch {
        /* ignore */
      }
      try {
        pipeline?.dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-memory: pipeline')

  /** Per-session turn accumulators + injection bookkeeping. */
  const sessions = new Map()
  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { turn: 0, userText: '', assistantText: '', tools: [], seq: null, injectedTurn: -1, globalIds: new Set(), stableInjected: false }
      sessions.set(sessionId, state)
    }
    return state
  }

  // ── Capture: fold session events into one episode + one L0 turn ───────────
  ctx.on('session/event', (session, event) => {
    if (!config.capture && !config.layers.l0) return
    if (isSubagentSession(session)) return
    try {
      const state = stateOf(session.id)
      switch (event?.type) {
        case 'turn/start':
          state.turn = Number(event.data?.turn ?? state.turn + 1)
          state.userText = ''
          state.assistantText = ''
          state.tools = []
          state.seq = Number.isInteger(event.seq) ? event.seq : null
          break
        case 'user/message': {
          // Only real human prompts: plugin-injected context is not the request.
          if (event.data?.source?.kind !== 'user') break
          const text = extractText(event.data?.content)
          if (text !== '') state.userText = text
          break
        }
        case 'assistant/message': {
          const text = extractText(event.data?.message?.content)
          if (text !== '') state.assistantText = text
          break
        }
        case 'tool/call': {
          const toolName = event.data?.name
          if (typeof toolName === 'string' && state.tools.length < 16) state.tools.push(toolName)
          break
        }
        case 'turn/end': {
          // Only durable outcomes are worth remembering; aborted/blocked/error
          // turns would pollute recall with half-finished reasoning.
          const reasonKind = event.data?.reason?.kind
          if (reasonKind !== 'completed' && reasonKind !== 'max-tokens') {
            state.userText = ''
            state.assistantText = ''
            state.tools = []
            state.seq = null
            break
          }
          const saved = config.capture
            ? captureTurn(getDb(), {
                sessionId: session.id,
                project: projectOf(session),
                userText: state.userText,
                assistantText: state.assistantText,
                toolNames: state.tools,
              })
            : null
          if (saved?.inserted) log('debug', `captured turn ${state.turn} as #${saved.id}`)
          if (config.layers.l0) {
            const appended = appendTurn(getDb(), {
              sessionId: session.id,
              turn: state.turn,
              project: projectOf(session),
              userText: state.userText,
              assistantText: state.assistantText,
              toolNames: state.tools,
              seqFrom: state.seq ?? null,
              seqTo: Number.isInteger(event.seq) ? event.seq : null,
            })
            if (appended.inserted) log('debug', `l0 turn ${state.turn} -> #${appended.id}`)
          }
          if (scheduler !== null) {
            const decision = scheduler.noteTurn(session.id, state.turn)
            if (decision.fired) log('debug', `l1 due (threshold=${decision.threshold}, turn=${state.turn})`)
          }
          state.userText = ''
          state.assistantText = ''
          state.tools = []
          state.seq = null
          break
        }
        default:
          break
      }
    } catch (error) {
      log('warn', `capture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── Recall: inject relevant memories at the first step of each turn ──────
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      if (signal?.aborted === true) return decision
      const session = agent?.session
      if (session === undefined) return decision
      if (isSubagentSession(session)) return decision // main chat only
      const state = stateOf(session.id)
      if (state.injectedTurn === turn) return decision // once per turn, not per step
      // step 1 carries the human prompt; a turn opened by cron/compaction has none
      if (!isHumanTurn(messages)) return decision

      const query = userTextOf(messages, session)
      const project = projectOf(session)
      const sections = []
      /** Rows already rendered in an earlier section; avoid paying for them twice. */
      const rendered = new Set()

      // Stable half: standing rules (pinned / high-priority persona+instruction)
      // plus persona and scene navigation. Once per session, before the first
      // model call — and deliberately **not** gated on the query, because it is
      // context-free: an image-only message or a one-word turn must still carry
      // the user's conventions.
      if (!state.stableInjected) {
        try {
          const cores = config.core.enabled
            ? coreMemories(getDb(), { project, limit: config.core.maxItems, minPriority: config.core.minPriority })
            : []
          const personas = config.layers.l3 ? listPersonas(getDb(), { project }) : []
          const scenes = config.layers.l2
            ? sceneNavigation(getDb(), { project, limit: 8, halfLifeDays: config.scenes.halfLifeDays })
            : []
          const stable = renderStableBlock({ cores, personas, scenes, maxChars: config.stableMaxChars })
          if (stable !== '') sections.push(stable)
          if (cores.length > 0) {
            // Count the use so curation can see which standing rules matter.
            try {
              touchMemories(getDb(), cores.map((row) => row.id))
            } catch {
              /* bookkeeping only */
            }
            for (const row of cores) {
              rendered.add(row.id)
              // Seed the session-wide set too: otherwise the globals pass would
              // re-inject a standing rule that the stable block already showed.
              state.globalIds.add(row.id)
            }
            log('debug', `core memories: ${cores.map((row) => `#${row.id}`).join(',')}`)
          }
        } catch (error) {
          log('warn', `stable block failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        state.stableInjected = true
      }

      // Lexical halves need text to match against. A turn without any human text
      // (attachment-only, command) still gets the stable half above and stops here.
      if (query !== '') {
        // Global preferences: re-checked *every* turn, not once per session. The
        // old once-per-session latch meant a first turn like「你好啊」（zero lexical
        // overlap）closed the channel for the whole session. Rows already shown
        // in this session are skipped, so the block does not repeat.
        if (config.injectGlobalFacts) {
          const globals = recall(getDb(), query, {
            scope: 'global',
            project: null,
            maxItems: 3,
            maxChars: Math.max(200, Math.floor(config.maxChars / 3)),
            minScore: config.minScore,
            vector: config.vector,
          })
          if (globals.items.length > 0) {
            // Drop rows already rendered in the stable block (a pinned preference
            // would otherwise be injected twice in the same turn).
            const fresh = globals.items.filter((row) => !rendered.has(row.id) && !state.globalIds.has(row.id))
            if (fresh.length > 0) {
              sections.push(
                renderMemoryBlock(fresh).replace('以下是从历史会话中检索到的相关记忆', '以下是用户/团队的长期偏好与约定'),
              )
              for (const row of fresh) {
                rendered.add(row.id)
                state.globalIds.add(row.id)
              }
            }
          }
        }

        const hits = recall(getDb(), query, {
          scope: config.scope,
          project,
          maxItems: config.maxItems,
          maxChars: config.maxChars,
          minScore: config.minScore,
          vector: config.vector,
        })
        const fresh = hits.items.filter((row) => !rendered.has(row.id))
        if (fresh.length > 0) {
          sections.push(renderMemoryBlock(fresh))
          log('debug', `recall turn ${turn}: ${fresh.length} hit(s) via ${hits.strategy}`)
        }
      }

      state.injectedTurn = turn
      if (sections.length === 0) return decision
      return { kind: 'enter', messages: [...decision.messages, contextMessage(sections.join('\n\n'))] }
    } catch (error) {
      log('warn', `recall failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  // ── Tools ────────────────────────────────────────────────────────────────
  const textOutput = () => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  })

  const projectFromExec = (exec) => {
    try {
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return basename(cwd)
    } catch {
      /* ignore */
    }
    return basename(process.cwd()) || null
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.tools.register({
        name: 'memory_search',
        description:
          'Search long-term memory (past sessions, saved preferences, decisions). Use it when the user refers to something agreed earlier, or before claiming you do not know a preference.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'What to recall, in natural language.' },
            limit: { type: 'integer', description: 'Max results (default 8).' },
            scope: {
              type: 'string',
              enum: ['project', 'global', 'all'],
              description: 'Which scope to search (default: project plus global).',
            },
          },
          required: ['query'],
        },
        output: textOutput(),
        execute: async (args, exec) => {
          const scope = args?.scope === 'global' || args?.scope === 'all' ? args.scope : 'project'
          const limit = Math.max(1, Math.min(20, Number(args?.limit ?? 8)))
          const result = recall(getDb(), String(args?.query ?? ''), {
            scope: scope === 'all' ? 'all' : scope,
            project: projectFromExec(exec),
            maxItems: limit,
            maxChars: 6000,
            minScore: 0,
            vector: config.vector,
          })
          if (result.items.length === 0) return { text: 'no memory found' }
          const lines = result.items.map(
            (row, index) => `${index + 1}. #${row.id} [${row.kind}/${row.scope}] ${row.text}`,
          )
          return { text: `found ${result.items.length} memory record(s):\n${lines.join('\n')}` }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'memory_save',
        description:
          'Save one durable fact to long-term memory (a preference, a decision, an environment constraint). Use for information that must survive this session; do not save temporary task detail. `scope:"global"` makes it visible from every project, but it is still recalled by relevance; use `pinned` for rules that must apply to every reply.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: 'The fact, written as a standalone statement.' },
            kind: {
              type: 'string',
              enum: ['fact', 'note'],
              description: 'fact = stable conclusion (default), note = unverified observation.',
            },
            scope: {
              type: 'string',
              enum: ['global', 'project'],
              description: 'global = applies everywhere (default), project = this workspace only.',
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
            pinned: {
              type: 'boolean',
              description:
                'Set when the user says this must always apply (forms of address, tone, hard rules). Pinned rows are injected at the start of every session even when the current question does not mention them.',
            },
          },
          required: ['text'],
        },
        output: textOutput(),
        execute: async (args, exec) => {
          const text = String(args?.text ?? '').trim()
          if (text === '') return { text: 'memory_save: text is required' }
          const scope = args?.scope === 'project' ? 'project' : 'global'
          const result = saveMemory(getDb(), {
            text,
            kind: args?.kind === 'note' ? 'note' : 'fact',
            scope,
            project: scope === 'project' ? projectFromExec(exec) : null,
            tags: Array.isArray(args?.tags) ? args.tags : [],
            pinned: args?.pinned === true,
            source: 'tool',
          })
          // Spell out the difference between "visible everywhere" and "injected
          // every turn" — a global row that is neither pinned nor a high-priority
          // persona/instruction fact is only ever recalled by lexical match.
          const hint =
            scope === 'global' && args?.pinned !== true
              ? ' — global = visible in every project; add pinned=true if it must apply to every reply'
              : ''
          return { text: `${result.inserted ? 'saved' : 'updated'} memory #${result.id} (${scope})${hint}` }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'memory_forget',
        description:
          'Delete wrong or outdated memories by id, or by a substring of their text. Prefer deleting a replaced fact over keeping both.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ids: { type: 'array', items: { type: 'integer' }, description: 'Memory ids to delete.' },
            query: { type: 'string', description: 'Delete rows whose text contains this substring.' },
          },
        },
        output: textOutput(),
        execute: async (args) => {
          const deleted = forgetMemories(getDb(), {
            ids: Array.isArray(args?.ids) ? args.ids.map(Number).filter((id) => Number.isInteger(id)) : undefined,
            query: typeof args?.query === 'string' ? args.query : undefined,
          })
          return { text: `deleted ${deleted} memory record(s)` }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'memory_stats',
        description: 'Show how many memories are stored, by kind, and the database size.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: textOutput(),
        execute: async () => {
          const s = stats(getDb())
          const kinds = Object.entries(s.byKind)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(',')
          return {
            text:
              `memories=${s.total} facts=${s.facts} episodes=${s.episodes} superseded=${s.superseded} ` +
              `kinds={${kinds}} l0=${s.l0Pending}/${s.l0Total} scenes=${s.scenes} personas=${s.personas} ` +
              `vec=${s.vectorized}/${s.total} feat=${s.featureIndexed}/${s.total} tokens=${s.tokensSpent} db=${(s.dbBytes / 1024 / 1024).toFixed(2)}MB path=${config.dbPath}`,
          }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'memory_extract',
        description:
          'Force one memory extraction for the current session now (debug/recovery). Pass all:true to drain the backlog of every session with un-extracted L0 turns (bounded to 20 sessions), or sessionId to process one specific session. Normally extraction runs automatically every few turns; call this only when asked to refresh memories explicitly.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            all: {
              type: 'boolean',
              description: 'Process every session that still has un-extracted L0 turns (oldest backlog first, max 20 sessions).',
            },
            sessionId: {
              type: 'string',
              description: 'Process one specific persisted session id instead of the current session.',
            },
          },
        },
        output: textOutput(),
        execute: async (args, exec) => {
          if (pipeline === null) return { text: 'extraction disabled (layers.l1 or extraction.enabled is off)' }
          const before = Number(
            getDb().prepare('SELECT COUNT(*) AS n FROM l0_turns WHERE extracted_at IS NULL').get()?.n ?? 0,
          )
          /** @type {string[]} */
          let targets = []
          if (args?.all === true) {
            targets = pendingSessionIds(getDb(), 20).map((row) => row.sessionId)
            if (targets.length === 0) return { text: 'no session with pending l0 turns' }
          } else if (typeof args?.sessionId === 'string' && args.sessionId.trim() !== '') {
            targets = [args.sessionId.trim()]
          } else {
            const sessionId = exec?.agent?.session?.id
            if (typeof sessionId !== 'string' || sessionId === '') return { text: 'no active session' }
            targets = [sessionId]
          }
          for (const sessionId of targets) pipeline.schedule(sessionId, 'manual')
          await pipeline.flush()
          const reason = getMeta(getDb(), 'l1-last-reason') ?? 'unknown'
          const summary = getMeta(getDb(), 'l1-last-summary') ?? '{}'
          const after = Number(
            getDb().prepare('SELECT COUNT(*) AS n FROM l0_turns WHERE extracted_at IS NULL').get()?.n ?? 0,
          )
          return {
            text: `extract reason=${reason} sessions=${targets.length} pending=${after}/${before} summary=${summary}`,
          }
        },
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'dsh-memory: tools')

  log('debug', `loaded (db=${config.dbPath}, maxItems=${config.maxItems}, scope=${config.scope})`)
}
