/**
 * The extraction pipeline: one serial queue, one job at a time.
 *
 * A job reads pending L0 turns, asks the model for atomic facts, resolves
 * conflicts against existing rows, and writes L1. Failures are recorded and
 * retried on a later trigger; a poison batch is discarded after
 * `maxAttempts` so it cannot loop forever.
 *
 * The queue is process-local and serial: token spend stays predictable and a
 * slow model call cannot overlap with another extraction.
 *
 * @module dsh-memory/pipeline
 */
import {
  buildTranscript,
  bumpAttempts,
  markTurnsExtracted,
  pendingTurns,
  updateCursor,
} from './l0.js'
import { buildDedupePrompt, buildExtractionPrompt, parseDedupe, parseExtraction, withCandidates, applyDecisions } from './extract.js'
import { addMeta, setMeta } from './store.js'
import { runPersona, runScenes } from './consolidate.js'

/** Defaults for one extraction batch. */
export const PIPELINE_DEFAULTS = {
  maxTurns: 20,
  maxInputChars: 8_000,
  maxMemories: 10,
  maxAttempts: 3,
  // Reasoning models spend part of the budget before the answer; 1_200 tokens
  // was enough to truncate a 10-fact answer mid-JSON (see DESIGN §23.7).
  maxTokens: 2_400,
  timeoutMs: 60_000,
}

/**
 * Create the pipeline.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   llm: ReturnType<import('./llm.js').createLlmClient>,
 *   config?: { extraction?: Record<string, any> },
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 * }} options
 */
export function createPipeline(options) {
  const db = options.db
  const llm = options.llm
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const cfg = { ...PIPELINE_DEFAULTS, ...(options.config?.extraction ?? {}) }

  /** @type {Array<{ sessionId: string, reason: string }>} */
  const queue = []
  /** @type {Set<string>} */
  const queued = new Set()
  let running = false
  let disposed = false
  /** @type {Promise<void>|null} */
  let drainPromise = null
  /** @type {AbortController|null} */
  let activeController = null

  /**
   * Enqueue one session. Duplicate requests (same session already queued or
   * running) collapse into the existing job.
   * @param {string} sessionId
   * @param {'threshold'|'idle'|'manual'|string} reason
   */
  function schedule(sessionId, reason = 'threshold') {
    if (disposed) return
    if (queued.has(sessionId)) return
    queued.add(sessionId)
    queue.push({ sessionId, reason })
    void drain()
  }

  async function drain() {
    if (running) return drainPromise ?? undefined
    running = true
    drainPromise = (async () => {
      try {
        while (!disposed && queue.length > 0) {
          const job = queue.shift()
          activeController = new AbortController()
          const started = now()
          try {
            const result = await runJob(job.sessionId, job.reason, activeController.signal)
            if (result?.skipped !== true) {
              log('debug', `l1 job ${job.sessionId.slice(0, 8)} (${job.reason}) ${(now() - started)}ms ${JSON.stringify(result?.summary ?? {})}`)
            }
          } catch (error) {
            log('warn', `l1 job failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            activeController = null
            queued.delete(job.sessionId)
          }
        }
      } finally {
        running = false
        drainPromise = null
      }
    })()
    return drainPromise
  }

  /** Wait until the current queue drains (tests / shutdown). */
  const flush = async () => {
    while (drainPromise) await drainPromise
  }

  /**
   * One extraction batch for one session.
   * @param {string} sessionId
   * @param {string} reason
   * @param {AbortSignal} signal
   */
  async function runJob(sessionId, reason, signal) {
    const turns = pendingTurns(db, sessionId, cfg.maxTurns)
    if (turns.length === 0) {
      setMeta(db, 'l1-last-reason', 'empty')
      return { skipped: true, reason: 'empty' }
    }
    if (!llm.available) {
      setMeta(db, 'l1-last-reason', 'llm_error')
      return { skipped: true, reason: 'llm-unavailable' }
    }

    const transcript = buildTranscript(turns, { maxChars: cfg.maxInputChars })
    if (transcript.text.trim() === '') {
      markTurnsExtracted(db, turns.map((row) => row.id), now())
      setMeta(db, 'l1-last-reason', 'empty')
      return { skipped: true, reason: 'empty' }
    }

    const usedIds = transcript.used.map((row) => row.id)
    const usedTurns = transcript.used
    const maxTurn = usedTurns.reduce((max, row) => Math.max(max, Number(row.turn ?? 0)), 0)
    const project = usedTurns[usedTurns.length - 1]?.project ?? null
    const prompt = buildExtractionPrompt(transcript.text, { maxMemories: cfg.maxMemories })
    const response = await llm.complete({
      system: prompt.system,
      user: prompt.user,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      signal,
      sessionId,
    })
    if (response.usage) {
      addMeta(db, 'l1_tokens_total', Number(response.usage.inputTokens ?? 0) + Number(response.usage.outputTokens ?? 0))
    }
    addMeta(db, 'l1_calls_total', 1)
    setMeta(db, 'l1-last-at', now())

    if (!response.ok) {
      const discarded = penalize(usedIds, response.error ?? 'llm_error')
      const timedOut = response.error === 'aborted' || response.error === 'timeout'
      setMeta(db, 'l1-last-reason', timedOut ? 'timeout' : 'llm_error')
      return { skipped: true, reason: response.error ?? 'llm_error', discarded }
    }

    const parsed = parseExtraction(response.text, { maxMemories: cfg.maxMemories })
    if (parsed.reason !== 'ok') {
      const discarded = penalize(usedIds, parsed.reason)
      setMeta(db, 'l1-last-reason', parsed.reason)
      // Keep the head of the unparseable answer: without it a `parse` failure is
      // undiagnosable after the fact (truncation vs. prose vs. wrong shape).
      setMeta(
        db,
        'l1-last-raw',
        JSON.stringify({
          at: now(),
          chars: response.text.length,
          finish: response.reason ?? null,
          head: response.text.slice(0, 1_200),
        }),
      )
      return { skipped: true, reason: parsed.reason, discarded }
    }

    const plan = withCandidates(db, parsed.memories, { project })
    let decisions = []
    if (plan.some((entry) => entry.candidates.length > 0)) {
      const dedupePrompt = buildDedupePrompt(plan)
      const dedupeResponse = await llm.complete({
        system: dedupePrompt.system,
        user: dedupePrompt.user,
        maxTokens: 800,
        timeoutMs: cfg.timeoutMs,
        signal,
        sessionId,
      })
      if (dedupeResponse.usage) {
        addMeta(db, 'l1_tokens_total', Number(dedupeResponse.usage.inputTokens ?? 0) + Number(dedupeResponse.usage.outputTokens ?? 0))
      }
      if (dedupeResponse.ok) decisions = parseDedupe(dedupeResponse.text, plan.length)
      else log('warn', 'l1 dedupe call failed; using deterministic fallback')
    }

    const summary = applyDecisions(db, plan, decisions, {
      project,
      sessionId,
      sourceSeqs: usedIds,
      now: now(),
    })
    markTurnsExtracted(db, usedIds, now())
    updateCursor(db, sessionId, { lastTurn: maxTurn, sinceExtract: 0, pendingSince: null }, now())
    setMeta(db, 'l1-last-reason', 'ok')
    setMeta(db, 'l1-last-summary', JSON.stringify(summary))
    log('info', `l1 extracted ${parsed.memories.length} fact(s): store=${summary.store} update=${summary.update} merge=${summary.merge} skip=${summary.skip}`)

    // L2/L3 consolidation runs after the facts are durable; failures never
    // roll back L1 and never surface to the conversation.
    const sceneConfig = options.config?.scenes
    if (sceneConfig?.enabled === true) {
      try {
        await runScenes(db, llm, sceneConfig, { project, now: now(), log, sessionId, signal })
      } catch (error) {
        log('warn', `l2 scene consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const personaConfig = options.config?.persona
    if (personaConfig?.enabled === true) {
      try {
        await runPersona(db, llm, personaConfig, { project, now: now(), log, sessionId, signal })
      } catch (error) {
        log('warn', `l3 persona consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Global persona: cross-project preferences ("how to treat the user"),
      // built from global facts only. Its own try/catch and its own batch
      // counter, so a failed or deferred global rewrite never costs the project
      // persona, L1, or the other scope's schedule. Order: project, then global.
      if (personaConfig.global !== false) {
        try {
          await runPersona(db, llm, personaConfig, { scope: 'global', now: now(), log, sessionId, signal })
        } catch (error) {
          log('warn', `l3 global persona consolidation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return { summary, used: usedIds.length, clipped: transcript.clipped, reason }
  }

  /**
   * Bump attempts; discard the batch once every turn hit `maxAttempts`.
   * @param {number[]} ids
   * @param {string} reason
   * @returns {boolean} whether the batch was discarded
   */
  function penalize(ids, reason) {
    bumpAttempts(db, ids)
    const rows = db
      .prepare(`SELECT extract_attempts FROM l0_turns WHERE id IN (${ids.map(() => '?').join(',') || '0'})`)
      .all(...ids)
    const exhausted = rows.length > 0 && rows.every((row) => Number(row.extract_attempts ?? 0) >= cfg.maxAttempts)
    if (exhausted) {
      markTurnsExtracted(db, ids, now())
      setMeta(db, 'l1-last-discarded', `${reason}@${now()}`)
      log('warn', `l1 discarded ${ids.length} turn(s) after ${cfg.maxAttempts} attempts: ${reason}`)
    }
    return exhausted
  }

  const dispose = () => {
    disposed = true
    try {
      activeController?.abort()
    } catch {
      /* ignore */
    }
    queue.length = 0
    queued.clear()
  }

  return {
    schedule,
    flush,
    dispose,
    /** Exposed for tests/diagnostics. */
    get pending() {
      return queue.length + (running ? 1 : 0)
    },
    /** Run one session synchronously through the same code path (tests/manual). */
    runNow: (sessionId) => runJob(sessionId, 'manual', new AbortController().signal),
  }
}
