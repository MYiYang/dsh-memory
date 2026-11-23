/**
 * Circuit breaker for the sync transport.
 *
 * Only transport-level failures trip it: network errors, timeouts, and 5xx/429
 * from the remote. Configuration problems (401/403, missing bucket) do **not**
 * trip it — retrying a wrong password for an hour just hides the real problem.
 *
 * State is persisted through the injected `load`/`save` callbacks so a process
 * restart cannot reset the backoff and hammer a struggling endpoint.
 *
 * @module dsh-memory/sync/breaker
 */

/** @typedef {'closed' | 'open' | 'half-open'} BreakerState */

/** Failure kinds that count toward tripping. */
const TRIPPING = new Set(['network', 'timeout', 'server', 'rate'])

/**
 * Map an error to a kind.
 * @param {any} error
 * @returns {'network' | 'timeout' | 'server' | 'rate' | 'auth' | 'config' | 'data' | 'unknown'}
 */
export function classifyFailure(error) {
  const code = String(error?.code ?? '')
  const status = Number(error?.status ?? 0)
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT') return 'timeout'
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ENETWORK' || code === 'EPIPE') return 'network'
  if (status === 401 || status === 403 || code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId' || code === 'AccessDenied') return 'auth'
  if (status === 429 || code === 'SlowDown') return 'rate'
  if (status >= 500) return 'server'
  if (code === 'bad-config' || code === 'bad-key') return 'config'
  if (code === 'corrupt' || code === 'unsupported-fmt' || code === 'decrypt-failed') return 'data'
  return 'unknown'
}

/**
 * @param {{
 *   threshold?: number, windowMs?: number, baseMs?: number, maxMs?: number,
 *   now?: () => number,
 *   load?: () => { state?: string, failures?: number, openedAt?: number, backoffMs?: number, lastError?: string } | null,
 *   save?: (state: { state: string, failures: number, openedAt: number, backoffMs: number, lastError: string }) => void,
 * }} [options]
 */
export function createBreaker(options = {}) {
  const threshold = Math.max(1, Number(options.threshold ?? 5))
  const windowMs = Math.max(1_000, Number(options.windowMs ?? 300_000))
  const baseMs = Math.max(1_000, Number(options.baseMs ?? 60_000))
  const maxMs = Math.max(baseMs, Number(options.maxMs ?? 3_600_000))
  const now = options.now ?? (() => Date.now())

  const loaded = typeof options.load === 'function' ? options.load() : null
  /** @type {BreakerState} */
  let state = loaded?.state === 'open' ? 'open' : loaded?.state === 'half-open' ? 'half-open' : 'closed'
  let failures = Number(loaded?.failures ?? 0)
  let openedAt = Number(loaded?.openedAt ?? 0)
  let backoffMs = Number(loaded?.backoffMs ?? baseMs)
  let lastError = String(loaded?.lastError ?? '')
  let firstFailureAt = 0
  let probes = 0

  const persist = () => {
    try {
      options.save?.({ state, failures, openedAt, backoffMs, lastError })
    } catch {
      /* bookkeeping only */
    }
  }

  return {
    /**
     * May we try a request now?
     * @returns {{ allowed: boolean, waitMs: number, state: BreakerState }}
     */
    before() {
      const at = now()
      if (state === 'open') {
        const wait = openedAt + backoffMs - at
        if (wait > 0) return { allowed: false, waitMs: wait, state }
        state = 'half-open'
        probes = 0
        persist()
        return { allowed: true, waitMs: 0, state }
      }
      if (state === 'half-open') {
        if (probes >= 1) return { allowed: false, waitMs: Math.max(0, openedAt + backoffMs - at), state }
        probes += 1
        return { allowed: true, waitMs: 0, state }
      }
      return { allowed: true, waitMs: 0, state }
    },

    success() {
      if (state !== 'closed' || failures > 0) {
        state = 'closed'
        failures = 0
        openedAt = 0
        backoffMs = baseMs
        lastError = ''
        persist()
      }
    },

    /**
     * @param {any} error
     * @returns {{ tripped: boolean, kind: string }}
     */
    failure(error) {
      const kind = classifyFailure(error)
      lastError = String(error?.code ?? error?.message ?? 'error').slice(0, 120)
      if (!TRIPPING.has(kind)) {
        // Configuration / data problems are states, not a reason to back off.
        persist()
        return { tripped: false, kind }
      }
      const at = now()
      if (failures === 0) firstFailureAt = at
      failures += 1
      const withinWindow = at - firstFailureAt <= windowMs
      if (state === 'half-open') {
        // A failed probe doubles the wait.
        state = 'open'
        openedAt = at
        backoffMs = Math.min(maxMs, Math.max(baseMs, backoffMs * 2))
      } else if (failures >= threshold) {
        // First trip starts from the base wait.
        if (state !== 'open') backoffMs = baseMs
        state = 'open'
        openedAt = at
      } else if (!withinWindow) {
        failures = 1
        firstFailureAt = at
      }
      persist()
      return { tripped: state === 'open', kind }
    },

    snapshot() {
      return { state, failures, openedAt, backoffMs, lastError, waitMs: state === 'open' ? Math.max(0, openedAt + backoffMs - now()) : 0 }
    },

    reset() {
      state = 'closed'
      failures = 0
      openedAt = 0
      backoffMs = baseMs
      lastError = ''
      persist()
    },
  }
}
