/**
 * Extraction scheduling: warm-up thresholds + idle fallback.
 *
 * The scheduler owns *when* an L1 extraction is due; it never runs one itself.
 * `onDue(sessionId, reason)` hands the session to a serial queue elsewhere
 * (`pipeline.js`), so a slow model call can never block a turn.
 *
 * Thresholds follow TencentDB Agent Memory's warm-up: after a successful
 * trigger the next threshold doubles (1 → 2 → 4 → 8 …) capped at `everyN`.
 * An idle timer (default 60s) catches the tail when the threshold is not hit.
 *
 * All timing is injectable so tests drive it without sleeping.
 *
 * @module dsh-memory/scheduler
 */
import { getCursor, pendingCount, updateCursor } from './l0.js'

/**
 * Next threshold after a trigger: double, capped at everyN, never below 1.
 * @param {number} current
 * @param {number} everyN
 * @returns {number}
 */
export function nextThreshold(current, everyN) {
  const cap = Math.max(1, Math.floor(everyN))
  return Math.max(1, Math.min(cap, Math.max(1, Math.floor(current)) * 2))
}

/**
 * Build the scheduler.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   everyN?: number,
 *   idleMs?: number,
 *   onDue: (sessionId: string, reason: 'threshold'|'idle'|'manual') => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   hasPending?: (sessionId: string) => boolean,
 * }} options
 */
export function createScheduler(options) {
  const db = options.db
  let everyN = Math.max(1, Math.min(100, options.everyN ?? 5))
  let idleMs = Math.max(50, options.idleMs ?? 60_000)
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const hasPending = options.hasPending ?? ((sessionId) => pendingCount(db, sessionId) > 0)
  const onDue = options.onDue

  /** @type {Map<string, any>} */
  const timers = new Map()

  const clearIdle = (sessionId) => {
    const handle = timers.get(sessionId)
    if (handle !== undefined) {
      try {
        clearTimer(handle)
      } catch {
        /* ignore */
      }
      timers.delete(sessionId)
    }
  }

  const due = (sessionId, reason) => {
    try {
      onDue(sessionId, reason)
    } catch {
      /* scheduling must never throw into the session */
    }
  }

  const armIdle = (sessionId) => {
    clearIdle(sessionId)
    const handle = setTimer(() => {
      timers.delete(sessionId)
      const cursor = getCursor(db, sessionId, now())
      if (!hasPending(sessionId)) {
        updateCursor(db, sessionId, { pendingSince: null }, now())
        return
      }
      // An idle trigger still counts as a trigger: advance the warm-up ladder.
      updateCursor(db, sessionId, {
        sinceExtract: 0,
        threshold: nextThreshold(cursor.threshold, everyN),
        pendingSince: null,
      }, now())
      due(sessionId, 'idle')
    }, idleMs)
    try {
      // never keep the host process alive just for a memory timer
      handle?.unref?.()
    } catch {
      /* ignore */
    }
    timers.set(sessionId, handle)
  }

  /**
   * Record one completed turn.
   * @param {string} sessionId
   * @param {number} turn
   * @returns {{ fired: boolean, threshold: number }}
   */
  const noteTurn = (sessionId, turn) => {
    const at = now()
    const cursor = getCursor(db, sessionId, at)
    const threshold = Math.max(1, Math.min(everyN, cursor.threshold))
    const sinceExtract = cursor.sinceExtract + 1
    if (sinceExtract >= threshold) {
      clearIdle(sessionId)
      updateCursor(db, sessionId, {
        sinceExtract: 0,
        threshold: nextThreshold(threshold, everyN),
        pendingSince: null,
        lastTurn: turn,
      }, at)
      due(sessionId, 'threshold')
      return { fired: true, threshold }
    }
    updateCursor(db, sessionId, {
      sinceExtract,
      pendingSince: cursor.pendingSince ?? at,
      lastTurn: turn,
    }, at)
    armIdle(sessionId)
    return { fired: false, threshold }
  }

  /**
   * Manual trigger (`memory_extract` tool, debugging, recovery).
   * @param {string} sessionId
   * @param {number} [turn]
   */
  const trigger = (sessionId, turn) => {
    clearIdle(sessionId)
    const cursor = getCursor(db, sessionId, now())
    updateCursor(db, sessionId, {
      sinceExtract: 0,
      threshold: nextThreshold(cursor.threshold, everyN),
      pendingSince: null,
      ...(turn === undefined ? {} : { lastTurn: turn }),
    }, now())
    due(sessionId, 'manual')
  }

  const dispose = () => {
    for (const sessionId of [...timers.keys()]) clearIdle(sessionId)
  }

  /**
   * Update the extraction cadence in place (Settings → Memory save).
   *
   * Already-armed idle timers keep the delay they were armed with; the next
   * completed turn re-arms with the new one. That is deliberate: clearing a
   * pending idle timer on save would silently drop the tail trigger.
   * @param {{ everyN?: number, idleMs?: number }} [next]
   * @returns {{ everyN: number, idleMs: number }}
   */
  const configure = (next = {}) => {
    if (Number.isFinite(Number(next.everyN))) everyN = Math.max(1, Math.min(100, Math.floor(Number(next.everyN))))
    if (Number.isFinite(Number(next.idleMs))) idleMs = Math.max(50, Number(next.idleMs))
    return { everyN, idleMs }
  }

  return {
    noteTurn,
    trigger,
    dispose,
    configure,
    get everyN() {
      return everyN
    },
    get idleMs() {
      return idleMs
    },
  }
}
