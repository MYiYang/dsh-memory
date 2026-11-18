/**
 * Backlog sweep: hand sessions with un-extracted L0 turns to the extraction
 * queue — once shortly after startup, then on a fixed interval.
 *
 * The scheduler's idle timer is an in-process timer (`src/scheduler.js`), so a
 * session that ends when DSH closes leaves its last few turns behind forever.
 * Measured before this sweep existed: 83 pending turns, p90 extraction lag
 * 24.8 hours, p99 21 days, 53 sessions with a tail.
 *
 * The sweep never blocks: it only schedules work into the serial extraction
 * queue. A periodic pass additionally waits for `minAgeMs`, so freshly captured
 * turns are left to the normal threshold/idle path instead of being extracted
 * twice.
 *
 * @module dsh-memory/sweep
 */
import { pendingSessionIds } from './l0.js'
import { setMeta } from './store.js'

/** How many sessions one sweep may hand to the queue. */
export const SWEEP_MAX_SESSIONS = 200

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   pipeline: { schedule: (sessionId: string, reason: string) => void, flush: () => Promise<void> },
 *   sessions?: number,
 *   minAgeMs?: number,
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void,
 *   setInterval?: (fn: () => void, ms: number) => any,
 *   clearInterval?: (handle: any) => void,
 * }} options
 * @returns {{
 *   run: () => Promise<{ sessions: number, pendingBefore: number, pendingAfter: number, oldestAgeMs: number, skipped?: string, error?: string }>,
 *   schedule: (delayMs?: number, intervalMs?: number) => () => void,
 * }}
 */
export function createStartupSweeper(options) {
  const db = options.db
  const pipeline = options.pipeline
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const limit = Math.max(1, Math.min(SWEEP_MAX_SESSIONS, Number(options.sessions ?? 20)))
  const minAge = Math.max(0, Number(options.minAgeMs ?? 0))

  let running = false

  const countPending = () => {
    try {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM l0_turns WHERE extracted_at IS NULL').get()?.n ?? 0)
    } catch {
      return 0
    }
  }

  /** Age of the oldest un-extracted turn, in ms (0 when nothing is pending). */
  const oldestPendingAge = () => {
    try {
      const row = db.prepare('SELECT MIN(created_at) AS oldest FROM l0_turns WHERE extracted_at IS NULL').get()
      const oldest = Number(row?.oldest ?? 0)
      return oldest > 0 ? Math.max(0, now() - oldest) : 0
    } catch {
      return 0
    }
  }

  /**
   * One pass: oldest backlog first, bounded by `sessions`. The queue is serial,
   * so this never overlaps a normal turn/end extraction.
   *
   * When `minAgeMs` is set, a pass with only fresh turns returns immediately:
   * those belong to the normal threshold/idle path, not to the backlog sweep.
   *
   * @returns {Promise<{ sessions: number, pendingBefore: number, pendingAfter: number, oldestAgeMs: number, skipped?: string, error?: string }>}
   */
  const run = async () => {
    const pendingBefore = countPending()
    const age = oldestPendingAge()
    const idle = { sessions: 0, pendingBefore, pendingAfter: pendingBefore, oldestAgeMs: age }
    if (running) return { ...idle, skipped: 'busy' }
    if (pendingBefore === 0) return { ...idle, pendingAfter: 0 }
    if (minAge > 0 && age < minAge) return { ...idle, skipped: 'fresh' }
    running = true
    try {
      const rows = pendingSessionIds(db, limit)
      if (rows.length === 0) return idle
      for (const row of rows) pipeline.schedule(row.sessionId, 'sweep')
      await pipeline.flush()
      const pendingAfter = countPending()
      setMeta(db, 'l0-sweep-last', JSON.stringify({ at: now(), sessions: rows.length, pendingBefore, pendingAfter }))
      log('info', `sweep: sessions=${rows.length} pending=${pendingAfter}/${pendingBefore} oldestAgeMs=${age}`)
      return { sessions: rows.length, pendingBefore, pendingAfter, oldestAgeMs: age }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `sweep failed: ${message}`)
      return { ...idle, pendingAfter: countPending(), error: message }
    } finally {
      running = false
    }
  }

  /**
   * Arm the sweep. `delayMs` is the first pass (startup); `intervalMs > 0`
   * repeats it. Every timer is unref'd: repetition must never keep the host
   * process alive, and a cancelled sweep must not fire.
   *
   * @param {number} [delayMs]
   * @param {number} [intervalMs]
   * @returns {() => void} cancel
   */
  const schedule = (delayMs = 8_000, intervalMs = 0) => {
    let fired = false
    /** @type {any} */
    let intervalHandle = null
    const tick = () => {
      // `run` already swallows its errors; the catch is only for a broken promise.
      Promise.resolve()
        .then(run)
        .catch(() => {})
    }
    const delay = Math.max(0, Number(delayMs) || 0)
    const every = Math.max(0, Number(intervalMs) || 0)
    const handle = setTimer(() => {
      fired = true
      tick()
      if (every > 0 && intervalHandle === null) {
        intervalHandle = setIntervalFn(tick, every)
        try {
          intervalHandle?.unref?.()
        } catch {
          /* ignore */
        }
      }
    }, delay)
    try {
      handle?.unref?.()
    } catch {
      /* ignore */
    }
    return () => {
      if (!fired) {
        try {
          clearTimer(handle)
        } catch {
          /* ignore */
        }
      }
      if (intervalHandle !== null) {
        try {
          clearIntervalFn(intervalHandle)
        } catch {
          /* ignore */
        }
        intervalHandle = null
      }
    }
  }

  return { run, schedule }
}
