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
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openDatabase, saveMemory, forgetMemories, stats, getMeta, coreMemories, touchMemories } from './src/store.js'
import { recall, renderMemoryBlock, renderStableBlock } from './src/recall.js'
import { captureTurn, extractText } from './src/capture.js'
import { appendTurn, pendingSessionIds } from './src/l0.js'
import { listPersonas, sceneNavigation } from './src/profile.js'
import { createScheduler } from './src/scheduler.js'
import { createPipeline } from './src/pipeline.js'
import { createLlmClient } from './src/llm.js'
import { runPersona } from './src/consolidate.js'
import { registerBundledSkills } from './src/skills.js'
import {
  applyLiveConfig,
  buildGroups,
  deepMerge,
  deletePath,
  fieldByKey,
  mergeRaw,
  resolveConfig,
  resolveHome,
  resolveSettingsPath,
  toNested,
  validatePatch,
  validateUnset,
} from './src/settings.js'
import { clearSettingsFile, describeStorage, messageOf, readSettingsFile, revealDirectory, writeSettingsFile } from './src/settings-store.js'
import { createApiRoute, MemoryApiError } from './src/api.js'
import { createMemory, deleteMemories, getMemory, listMemories, updateMemory } from './src/data.js'

export const name = 'memory'
export const inject = ['tools', 'agents', 'sessions']

/** Plugin tag used in log lines. */
const TAG = '[dsh-memory]'

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
 * Settings file path: `$DSH_HOME/memory/settings.json` by default.
 *
 * The loader row config may redirect it with `settingsPath` — that is a test /
 * packaging escape hatch, deliberately not part of the Settings page catalog.
 * @param {Record<string, unknown>} loaderRaw
 * @returns {string}
 */
function resolveSettingsPathFor(loaderRaw) {
  const candidate = loaderRaw?.settingsPath
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    const expanded = candidate.trim().replace(/^~(?=$|[\\/])/, homedir())
    return isAbsolute(expanded) ? expanded : resolvePath(expanded)
  }
  return resolveSettingsPath()
}

/**
 * Version reported by the settings page. Read from the package manifest at
 * runtime (never imported as JSON: a linked package must work from any cwd).
 * @returns {string}
 */
function readPluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Register the plugin.
 * @param {any} ctx - cordis context
 * @param {unknown} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  // The loader-provided row config (YAML) is the base layer; the Settings page
  // writes a second layer next to the database. `settingsPath` is accepted in
  // the row config only so tests and packagers can redirect the file — it is
  // not exposed as a settings field.
  const loaderRaw = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}
  const settingsPath = resolveSettingsPathFor(loaderRaw)
  const initialSettings = readSettingsFile(settingsPath)
  /** @type {Record<string, any>} Settings-page layer: only explicitly changed keys. */
  let storedSettings = initialSettings.settings
  /** Read/write problem of the settings file, surfaced in the settings page. */
  let settingsError = initialSettings.error

  const config = resolveConfig(mergeRaw(loaderRaw, storedSettings))
  const log = (level, message) => {
    try {
      const logger = ctx.logger ?? console
      const fn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info?.bind(logger)
      fn?.(`${TAG} ${message}`)
    } catch {
      /* logging must never throw */
    }
  }
  if (settingsError !== null) log('warn', `settings file ignored (${settingsPath}): ${settingsError}`)

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

  // ── L0/L1 pipeline: built whenever a model is resolvable ──────────────────
  // The layer/extraction switches are read at use time (turn/end, runJob), not
  // here, so the Settings page can turn extraction off and on without a
  // restart. Only an unresolvable model keeps the pipeline absent.
  /** @type {ReturnType<typeof createPipeline>|null} */
  let pipeline = null
  /** @type {ReturnType<typeof createScheduler>|null} */
  let scheduler = null
  /** @type {ReturnType<typeof createLlmClient>|null} */
  let llmClient = null
  if (dbReady) {
    try {
      const llm = createLlmClient(ctx, config.extraction, log)
      if (llm.available) {
        llmClient = llm
        pipeline = createPipeline({ db: getDb(), llm, config, log })
        scheduler = createScheduler({
          db: getDb(),
          everyN: config.extraction.everyN,
          idleMs: config.extraction.idleMs,
          onDue: (sessionId, reason) => pipeline?.schedule(sessionId, reason),
        })
        log(
          'debug',
          `extraction ready (enabled=${config.layers.l1 && config.extraction.enabled}, everyN=${config.extraction.everyN}, idleMs=${config.extraction.idleMs})`,
        )
      }
    } catch (error) {
      log('warn', `extraction disabled: ${error instanceof Error ? error.message : String(error)}`)
      pipeline = null
      scheduler = null
      llmClient = null
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
          // Read the switches here (not at boot) so turning extraction off in
          // the Settings page stops scheduling immediately.
          if (scheduler !== null && config.layers.l1 && config.extraction.enabled) {
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
        // `debug` (settings → advanced) promotes the per-turn recall summary to
        // info level; it logs sizes and strategy, never the query or the text.
        if (config.debug) {
          log('info', `recall turn ${turn}: query=${query.length}chars hits=${fresh.length} strategy=${hits.strategy}`)
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
              `vec=${s.vectorized}/${s.total} feat=${s.featureIndexed}/${s.total} tokens=${s.tokensSpent} db=${(s.dbBytes / 1024 / 1024).toFixed(2)}MB path=${config.dbPath} settings=${settingsPath}`,
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

    disposers.push(
      ctx.tools.register({
        name: 'memory_compact',
        description:
          'Rewrite the project and/or global persona right now, bypassing the batch threshold and the JEV gate. Use it to shrink a bloated persona (it competes for the stable block budget with the scene navigation) or to refresh it on demand. Costs one model call per scope.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: {
              type: 'string',
              enum: ['project', 'global', 'both'],
              description: 'Which persona to rewrite. Default both.',
            },
          },
        },
        output: textOutput(),
        execute: async (args, exec) => {
          if (llmClient === null || llmClient.available !== true) {
            return { text: 'persona rewrite disabled (llm unavailable or extraction off)' }
          }
          const session = exec?.agent?.session
          const project = projectOf(session)
          const wanted = args?.scope === 'project' || args?.scope === 'global' ? args.scope : 'both'
          const before = listPersonas(getDb(), { project })
          /** @type {string[]} */
          const parts = []
          if (wanted !== 'global') {
            if (project === null) {
              parts.push('project=no-active-project')
            } else {
              const result = await runPersona(
                getDb(),
                llmClient,
                { ...config.persona, force: true },
                { project, scope: 'project', log, sessionId: session?.id },
              )
              parts.push(`project=${JSON.stringify(result)}`)
            }
          }
          if (wanted !== 'project') {
            const result = await runPersona(
              getDb(),
              llmClient,
              { ...config.persona, force: true },
              { scope: 'global', log, sessionId: session?.id },
            )
            parts.push(`global=${JSON.stringify(result)}`)
          }
          const after = listPersonas(getDb(), { project })
          const sizes = after
            .map((row) => `${row.scope}/${row.project ?? '-'} v${row.version} ${String(row.body ?? '').length}`)
            .join(', ')
          return {
            text: `compact ${parts.join(' ')} | before=${before.map((row) => String(row.body ?? '').length).join('/')} after=${sizes}`,
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

  // ── Settings → Memory ────────────────────────────────────────────────────
  // One state read plus three writes. The page shows the effective value of
  // every field, where it came from, and whether saving it needs a restart;
  // `save`/`reset` re-resolve the merged config, persist the settings layer,
  // and push the live-able part into the running plugin.
  const pluginVersion = readPluginVersion()
  const startedAt = Date.now()
  const EMPTY_STATS = {
    total: 0,
    facts: 0,
    episodes: 0,
    superseded: 0,
    projects: 0,
    byKind: {},
    l0Total: 0,
    l0Pending: 0,
    scenes: 0,
    personas: 0,
    vectorized: 0,
    featureIndexed: 0,
    tokensSpent: 0,
    dbBytes: 0,
  }

  const readStats = () => {
    if (!dbReady) return { ...EMPTY_STATS, byKind: {} }
    try {
      return stats(getDb())
    } catch (error) {
      log('warn', `stats failed: ${messageOf(error)}`)
      return { ...EMPTY_STATS, byKind: {} }
    }
  }

  /** Config as it will run: defaults < loader row config < settings layer. */
  const effectiveConfig = () => resolveConfig(mergeRaw(loaderRaw, storedSettings))

  /** Everything the settings page renders, in one object. */
  const createState = () => {
    const effective = effectiveConfig()
    const storage = describeStorage({
      dir: dirname(config.dbPath),
      dbPath: config.dbPath,
      settingsPath,
      home: resolveHome(),
    })
    if (settingsError !== null) storage.error = storage.error ?? settingsError
    return {
      plugin: { name: 'dsh-memory-layered', version: pluginVersion, dbReady, startedAt },
      storage,
      stats: readStats(),
      runtime: {
        extraction: {
          available: llmClient?.available === true,
          provider: llmClient?.provider ?? null,
          model: llmClient?.model ?? null,
          scheduled: pipeline !== null,
        },
        skills: { enabled: config.skills.enabled, dir: config.skills.dir },
        vector: { enabled: config.vector.enabled },
      },
      groups: buildGroups(effective, config, loaderRaw, storedSettings),
    }
  }

  /**
   * Persist a settings patch, then apply what can be applied live.
   * @param {{ patch?: Record<string, unknown>, unset?: unknown }} payload
   */
  const saveSettings = (payload) => {
    const patched = validatePatch(payload?.patch)
    if (!patched.ok) {
      throw new MemoryApiError(
        'bad-request',
        patched.errors.map((error) => `${error.key || 'patch'}: ${error.message}`).join('; '),
      )
    }
    const unset = validateUnset(payload?.unset)
    if (!unset.ok) {
      throw new MemoryApiError(
        'bad-request',
        unset.errors.map((error) => `${error.key || 'unset'}: ${error.message}`).join('; '),
      )
    }
    const nextStored = deepMerge(storedSettings, toNested(patched.flat))
    for (const key of unset.keys) {
      const field = fieldByKey(key)
      if (field !== undefined) deletePath(nextStored, field.path)
    }
    const next = resolveConfig(mergeRaw(loaderRaw, nextStored))
    try {
      writeSettingsFile(settingsPath, nextStored)
    } catch (error) {
      // Persistence first: a failed write must leave the running plugin exactly
      // as it was, otherwise the page and the next boot would disagree.
      throw new MemoryApiError('io-error', `cannot write settings: ${messageOf(error)}`)
    }
    storedSettings = nextStored
    settingsError = null
    const { applied, restartRequired } = applyLiveConfig(config, next)
    // These two copy their values at construction (see src/pipeline.js,
    // src/scheduler.js); everything else reads the shared config object.
    pipeline?.refresh()
    scheduler?.configure({ everyN: config.extraction.everyN, idleMs: config.extraction.idleMs })
    return { state: createState(), applied, unset: unset.keys, restartRequired }
  }

  /**
   * Drop settings overrides: all of them, or the listed keys only.
   * @param {{ keys?: unknown }} payload
   */
  const resetSettings = (payload) => {
    const keys = Array.isArray(payload?.keys) && payload.keys.length > 0 ? payload.keys : null
    try {
      if (keys === null) {
        clearSettingsFile(settingsPath)
        storedSettings = {}
      } else {
        const unset = validateUnset(keys)
        if (!unset.ok) {
          throw new MemoryApiError(
            'bad-request',
            unset.errors.map((error) => `${error.key || 'unset'}: ${error.message}`).join('; '),
          )
        }
        const nextStored = deepMerge({}, storedSettings)
        for (const key of unset.keys) {
          const field = fieldByKey(key)
          if (field !== undefined) deletePath(nextStored, field.path)
        }
        if (Object.keys(nextStored).length === 0) clearSettingsFile(settingsPath)
        else writeSettingsFile(settingsPath, nextStored)
        storedSettings = nextStored
      }
    } catch (error) {
      if (error instanceof MemoryApiError) throw error
      throw new MemoryApiError('io-error', `cannot reset settings: ${messageOf(error)}`)
    }
    settingsError = null
    const next = resolveConfig(mergeRaw(loaderRaw, storedSettings))
    const { applied, restartRequired } = applyLiveConfig(config, next)
    pipeline?.refresh()
    scheduler?.configure({ everyN: config.extraction.everyN, idleMs: config.extraction.idleMs })
    return { state: createState(), applied, restartRequired, reset: true }
  }

  /** Open the storage directory in the platform file manager (best effort). */
  const revealStorage = () => revealDirectory(dirname(config.dbPath), { log })

  /**
   * The data endpoints need an open database. A plugin that failed to open its
   * store (read-only home, locked file) still serves the parameter page, so this
   * reports a stable `not-ready` instead of leaking the openDatabase error.
   */
  const requireDb = () => {
    if (!dbReady) throw new MemoryApiError('not-ready', 'the memory database is not ready')
    try {
      return getDb()
    } catch (error) {
      throw new MemoryApiError('io-error', `cannot open the memory database: ${messageOf(error)}`)
    }
  }

  const apiRoute = createApiRoute({
    methods: {
      state: () => createState(),
      save: (payload) => saveSettings(payload),
      reset: (payload) => resetSettings(payload),
      reveal: () => revealStorage(),
      // Settings → Memory → 记忆数据: the row-level CRUD surface.
      memories: (payload) => listMemories(requireDb(), payload),
      memory: (payload) => getMemory(requireDb(), payload?.id),
      memoryCreate: (payload) => createMemory(requireDb(), payload),
      memoryUpdate: (payload) => updateMemory(requireDb(), payload),
      memoryDelete: (payload) => deleteMemories(requireDb(), payload),
    },
    admits: (req) => {
      try {
        if (typeof ctx.get !== 'function') return true
        const connection = ctx.get('connection')
        if (connection === undefined || typeof connection.requestRejection !== 'function') return true
        return connection.requestRejection(req) === undefined
      } catch {
        return false
      }
    },
    log,
  })

  // The settings page needs the GUI webserver; the agent side does not. Mount
  // lazily so headless profiles (no webServer service) keep every other feature
  // instead of failing to load the entry.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.effect(() => {
        const fiber = ctx.inject(['webServer'], (webCtx) => {
          webCtx.effect(() => webCtx.webServer.register(apiRoute), 'dsh-memory: /memory/api')
        })
        return () => {
          try {
            fiber?.dispose?.()
          } catch {
            /* ignore */
          }
        }
      }, 'dsh-memory: settings api')
    }
  } catch (error) {
    log('warn', `settings api not mounted: ${messageOf(error)}`)
  }

  log('debug', `loaded (db=${config.dbPath}, maxItems=${config.maxItems}, scope=${config.scope})`)
}
