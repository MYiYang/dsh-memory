/**
 * Background backfill for a configured embedding model
 * (ANALYSIS-vector-model.md §4.6).
 *
 * The memory write path is synchronous and must stay that way, so a row is
 * saved with its lexical vector only; this worker notices rows that lack a
 * vector for the *active* tag and asks the model for them in small batches.
 *
 * Properties that matter:
 *   - Nothing here throws to the caller. A dead endpoint is a recall-quality
 *     problem, never a turn failure.
 *   - Bounded: `EMBED_ROWS_PER_TICK` rows per pass, `EMBED_BATCH_SIZE` texts per
 *     request, and a real `await` between batches so the event loop keeps
 *     serving turns while a 10k-memory corpus backfills.
 *   - Backoff: a failing endpoint is retried at 5s, 10s, … up to 5 minutes
 *     instead of hammering it once per turn.
 *   - Self-healing: the pending query compares `memory.hash` with the stored
 *     `text_hash`, so an edited memory is re-embedded without any write-path
 *     hook, and a model/width change (new tag) simply makes every row pending.
 *
 * @module dsh-memory/embed-worker
 */
import { EMBEDDING_TABLE, deleteOtherModels, embeddingCounts, hasEmbeddingTable, pendingEmbeddingRows, putEmbedding } from './embedding-store.js'

/** Texts per `/embeddings` request. */
export const EMBED_BATCH_SIZE = 32

/** Rows one pass may embed before yielding (next pass is scheduled right after). */
export const EMBED_ROWS_PER_TICK = 256

/** Idle poll; covers "rows were added by a path that forgot to nudge". */
export const EMBED_IDLE_MS = 30_000

/** Delay between "something happened" and the pass (coalesces saves). */
export const EMBED_DEBOUNCE_MS = 400

/** Delay before the next pass when the previous one filled its row budget. */
export const EMBED_DRAIN_MS = 50

/** First retry delay after a failure; doubles per consecutive failure. */
export const EMBED_RETRY_BASE_MS = 5_000

/** Retry ceiling. */
export const EMBED_RETRY_MAX_MS = 300_000

/** How long a set of counters stays valid for `hasVectors()`/`state()`. */
export const COUNTS_TTL_MS = 3_000

/** Error → one line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Split an array into fixed-size chunks (last one may be shorter). */
function chunkOf(items, size) {
  /** @type {any[][]} */
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   getClient: () => (null|{
 *     provider: string, available: boolean, tag: string|null, dims: number|null,
 *     error: string|null,
 *     ensureDims: () => Promise<{ ok: boolean, dims: number|null, error: string|null }>,
 *     embed: (texts: string[]) => Promise<{ ok: boolean, vectors: Float32Array[], dims: number|null, error: string|null }>,
 *   }),
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (timer: any) => void,
 * }} options
 */
export function createEmbeddingWorker(options) {
  const db = options.db
  const getClient = options.getClient ?? (() => null)
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout

  let timer = null
  /** Delay of the pass already scheduled (0 = none). */
  let timerDelay = 0
  let disposed = false
  let running = false
  let failures = 0
  let lastError = /** @type {string|null} */ (null)
  let lastRunAt = 0
  let lastTag = /** @type {string|null} */ (null)
  let prunedTag = /** @type {string|null} */ (null)
  /** Three COUNTs are not free; the pre-step asks "is anything embedded?" every turn. */
  let countsMemo = { at: 0, tag: /** @type {string|null} */ (null), value: { total: 0, embedded: 0, pending: 0, stale: 0 } }

  /** Counters for `tag`, memoized for {@link COUNTS_TTL_MS}. */
  function counts(tag) {
    if (tag === null || !hasEmbeddingTable(db)) return { total: 0, embedded: 0, pending: 0, stale: 0 }
    const stamp = now()
    if (countsMemo.tag === tag && stamp - countsMemo.at < COUNTS_TTL_MS) return countsMemo.value
    let value = { total: 0, embedded: 0, pending: 0, stale: 0 }
    try {
      value = embeddingCounts(db, tag)
    } catch (error) {
      log('debug', `embedding counts failed: ${messageOf(error)}`)
    }
    countsMemo = { at: stamp, tag, value }
    return value
  }

  /** Backoff delay for the current failure streak. */
  function retryDelay() {
    if (failures <= 0) return EMBED_IDLE_MS
    const exponential = EMBED_RETRY_BASE_MS * Math.pow(2, Math.min(6, failures - 1))
    return Math.min(EMBED_RETRY_MAX_MS, exponential)
  }

  /**
   * Schedule one pass. A pending pass is kept unless the new request is
   * *sooner*: an idle poll must not swallow a "a memory was just saved" nudge
   * (that would delay semantic recall for up to EMBED_IDLE_MS), while a later
   * request must not postpone an already-planned one.
   */
  function schedule(delay = EMBED_DEBOUNCE_MS) {
    if (disposed) return
    const wait = Math.max(0, Math.floor(delay))
    if (timer !== null && wait >= timerDelay) return
    if (timer !== null) {
      try {
        clearTimer(timer)
      } catch {
        /* ignore */
      }
      timer = null
    }
    timerDelay = wait
    timer = setTimer(() => {
      timer = null
      timerDelay = 0
      void run()
    }, wait)
    // An idle plugin must not keep the host process alive.
    timer?.unref?.()
  }

  /** One pass, then schedule whatever comes next. */
  async function run() {
    if (disposed || running) return
    running = true
    try {
      await drainOnce()
    } catch (error) {
      recordFailure(messageOf(error))
    } finally {
      running = false
      if (!disposed && failures === 0) schedule(EMBED_IDLE_MS)
    }
  }

  /** Record a failure, log it once per streak level, and retry later. */
  function recordFailure(error) {
    failures += 1
    lastError = error
    const delay = retryDelay()
    if (failures === 1 || failures % 5 === 0) {
      log('warn', `embedding backfill failed (${failures}x, retry in ${Math.round(delay / 1000)}s): ${error}`)
    } else {
      log('debug', `embedding backfill failed (${failures}x): ${error}`)
    }
    if (!disposed) schedule(delay)
  }

  /** Reset the streak after a successful pass. */
  function recordSuccess(embedded) {
    failures = 0
    lastError = null
    lastRunAt = now()
    lastTag = getClient()?.tag ?? lastTag
    if (embedded > 0) {
      countsMemo = { at: 0, tag: null, value: countsMemo.value }
      log('debug', `embedding backfill: +${embedded} row(s) (${lastTag})`)
    }
  }

  /**
   * Exactly one bounded pass. Exported through the returned object so tests can
   * drive the worker without timers.
   *
   * @returns {Promise<{ ok: boolean, skipped?: string, embedded?: number, error?: string|null, tag?: string|null }>}
   */
  async function drainOnce() {
    if (disposed) return { ok: false, skipped: 'disposed' }
    const client = getClient()
    // The built-in lexical provider lives in `memory.vec`; there is nothing to
    // backfill, and writing a second copy into memory_embeddings would double
    // the storage for no signal.
    if (client === null || client === undefined || client.provider !== 'openai') return { ok: true, skipped: 'builtin' }
    if (client.available !== true) {
      return { ok: false, skipped: 'unavailable', error: client.error ?? 'unavailable' }
    }
    if (!hasEmbeddingTable(db)) return { ok: false, skipped: 'no-table', error: `${EMBEDDING_TABLE} is missing` }

    // A tag needs a width; resolving it may cost one probe request.
    const resolved = await client.ensureDims()
    if (resolved.ok !== true) {
      recordFailure(resolved.error ?? 'cannot resolve embedding dimensions')
      return { ok: false, error: resolved.error ?? 'cannot resolve embedding dimensions' }
    }
    const tag = client.tag
    if (typeof tag !== 'string' || tag === '') {
      recordFailure('embedding tag is empty (model or dims missing)')
      return { ok: false, error: 'embedding tag is empty' }
    }
    const dims = Number(client.dims)
    if (!Number.isFinite(dims) || dims <= 0) {
      recordFailure(`invalid embedding dimensions: ${client.dims}`)
      return { ok: false, error: 'invalid embedding dimensions' }
    }

    // One model at a time: a previous model's 6 KB rows are dead weight. Pruned
    // *after* this model has proven itself (a successful write, or nothing left
    // to write) — a model whose key or URL is wrong must not delete the vectors
    // of the model that used to work.
    const pruneOtherModels = () => {
      if (prunedTag === tag) return
      try {
        const removed = deleteOtherModels(db, tag)
        prunedTag = tag
        countsMemo = { at: 0, tag: null, value: countsMemo.value }
        if (removed > 0) log('info', `embedding backfill: dropped ${removed} stale row(s) of another model`)
      } catch (error) {
        log('debug', `cannot prune stale embeddings: ${messageOf(error)}`)
      }
    }

    const rows = pendingEmbeddingRows(db, tag, EMBED_ROWS_PER_TICK)
    if (rows.length === 0) {
      // Everything is already embedded under the active tag: nothing can be lost.
      pruneOtherModels()
      recordSuccess(0)
      return { ok: true, embedded: 0, tag }
    }

    let embedded = 0
    for (const chunk of chunkOf(rows, EMBED_BATCH_SIZE)) {
      const result = await client.embed(chunk.map((row) => row.text))
      if (result.ok !== true) {
        recordFailure(result.error ?? 'embedding request failed')
        return { ok: false, embedded, error: result.error ?? 'embedding request failed', tag }
      }
      const vectors = Array.isArray(result.vectors) ? result.vectors : []
      if (vectors.length !== chunk.length) {
        recordFailure(`expected ${chunk.length} vectors, got ${vectors.length}`)
        return { ok: false, embedded, error: 'vector count mismatch', tag }
      }
      const writeAt = now()
      for (let index = 0; index < chunk.length; index++) {
        try {
          putEmbedding(db, {
            memoryId: chunk[index].id,
            model: tag,
            dims,
            textHash: chunk[index].hash,
            vector: vectors[index],
            now: writeAt,
          })
          embedded += 1
        } catch (error) {
          // A single unwritable row must not abort the batch.
          log('debug', `cannot store embedding for #${chunk[index].id}: ${messageOf(error)}`)
        }
      }
      // Yield between batches: a long backfill runs during a live conversation.
      await new Promise((resolve) => {
        const handle = setTimer(resolve, 0)
        handle?.unref?.()
      })
    }

    // This model answered and its vectors are stored: the previous model's rows
    // can go now.
    if (embedded > 0) pruneOtherModels()
    recordSuccess(embedded)
    // A full budget means there is probably more; keep draining without waiting
    // for the idle poll.
    if (rows.length >= EMBED_ROWS_PER_TICK && !disposed) schedule(EMBED_DRAIN_MS)
    return { ok: true, embedded, tag }
  }

  return {
    /** Ask for a pass soon (coalesced while one is already scheduled). */
    note(delay) {
      schedule(delay ?? EMBED_DEBOUNCE_MS)
    },
    /** Ask for a pass now (used right after a settings change). */
    kick() {
      schedule(0)
    },
    /** Forget the failure streak and re-examine the model (config changed). */
    refresh() {
      failures = 0
      lastError = null
      prunedTag = null
      countsMemo = { at: 0, tag: null, value: countsMemo.value }
      schedule(0)
    },
    drainOnce,
    /**
     * Is there anything at all to compare a query against? The pre-step uses
     * this to skip a pointless round trip right after the model was enabled.
     */
    hasVectors() {
      return counts(getClient()?.tag ?? lastTag).embedded > 0
    },
    /** Snapshot for the settings page and the debug log. */
    state() {
      const client = getClient()
      const tag = client?.tag ?? lastTag
      return {
        provider: client?.provider ?? 'hash',
        available: client?.available === true,
        tag,
        dims: client?.dims ?? null,
        failures,
        lastError,
        lastRunAt: lastRunAt === 0 ? null : lastRunAt,
        counts: counts(tag),
      }
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        try {
          clearTimer(timer)
        } catch {
          /* ignore */
        }
        timer = null
        timerDelay = 0
      }
    },
  }
}
