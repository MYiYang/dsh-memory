/**
 * The sync engine: one object the host wires once, and the settings panel talks
 * to through four API methods.
 *
 * Rules it never breaks:
 *   - never throws into the caller: every entry point catches and reports;
 *   - never runs twice at once (`running` latch);
 *   - never touches the network when disabled or while the breaker is open;
 *   - never blocks the conversation path — it only runs on its own timer or on
 *     an explicit "sync now".
 *
 * @module dsh-memory/sync/engine
 */
import { createHash } from 'node:crypto'
import { advanceWatermark, backlog, needsSnapshot, pruneOplog, unflushedOps } from './oplog.js'
import {
  decodeManifest,
  decodeSegment,
  embObjectKey,
  embPartKey,
  encodeManifest,
  encodeSegment,
  parseEmbObjectKey,
  segmentObjectKey,
  snapshotManifestKey,
  snapshotPartKey,
} from './segment.js'
import { createRemote } from './remote.js'
import { createCrypto } from './crypto.js'
import { applyOps, drainPending } from './apply.js'
import { createBreaker, classifyFailure } from './breaker.js'
import { historyKey, l0Key, personaKey, sceneKey } from './keys.js'
import { collectDirtyEmbOps, embStats, localEmbKeys, markEmbUploaded, normalizeCodec, readEmbPage } from './vectors.js'
import { getSyncMeta, listTombstones, pruneTombstones, setSyncEnabled, setSyncMeta, SYNC_SCHEMA_VERSION } from './schema.js'

/**
 * @typedef {{
 *   enabled: boolean, mode: 'manual'|'auto', everySeconds: number, workspace?: string,
 *   encrypt?: boolean, conditionalPut?: boolean, tombstoneDays?: number, snapshotOpsPerPart?: number,
 *   oplogKeepDays?: number, snapshotEveryHours?: number, snapshotKeep?: number,
 *   vectors?: 'off'|'f32'|'f16'|'i8', vectorsPerSegment?: number,
 *   remote: 'local'|'s3',
 *   local: { dir: string },
 *   s3: { endpoint: string, bucket: string, region: string, pathStyle: boolean, prefix: string,
 *         accessKeyRef: string, secretKeyRef: string, caFile?: string },
 * }} SyncConfig
 */

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config: { sync: SyncConfig, dbPath?: string },
 *   log?: (level: string, message: string) => void,
 *   now?: () => number,
 *   timers?: { setInterval: Function, clearInterval: Function },
 *   remoteFactory?: (config: any) => any,
 * }} options
 */
export function createSyncEngine(options) {
  const db = options.db
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const timers = options.timers ?? { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  let config = normalize(options.config?.sync)
  // Seam for fault injection: production uses createRemote, tests hand in a
  // wrapper that can fail the Nth put/get on purpose.
  const makeRemote = typeof options.remoteFactory === 'function' ? options.remoteFactory : createRemote
  // End-to-end encryption: on by default, keyed by sync.encryptKey (base64). With
  // no usable key we deliberately stay in plaintext *and* say so — refusing to
  // sync outright would be a worse failure for a memory product.
  const syncCrypto = createCrypto(config.encryptKey)
  const encryptOn = config.encrypt !== false && syncCrypto !== null
  if (config.encrypt !== false && syncCrypto === null) {
    log('warn', 'sync.encrypt is on but sync.encryptKey is missing or not 32 bytes — syncing plaintext')
  }
  // The workspace is shared by every device of one bucket on purpose: deriving it
  // from the local db path would give each machine its own namespace and nothing
  // would ever be pulled. Users with several independent memory sets set it explicitly.
  const workspace = String(config.workspace && config.workspace.trim() !== '' ? config.workspace : 'default')

  /** @type {ReturnType<typeof createRemote> | null} */
  let remote = null
  /** @type {ReturnType<typeof createBreaker> | null} */
  let breaker = null
  let running = false
  let interval = null
  let started = false

  const breakerState = () => {
    try {
      const row = db.prepare("SELECT value FROM sync_state WHERE key = 'breaker'").get()
      return row === undefined ? null : JSON.parse(String(row.value))
    } catch {
      return null
    }
  }

  function ensureRemote() {
    if (remote !== null) return remote
    remote =
      config.remote === 's3'
        ? makeRemote({
            kind: 's3',
            endpoint: config.s3.endpoint,
            bucket: config.s3.bucket,
            region: config.s3.region,
            pathStyle: config.s3.pathStyle,
            accessKey: config.s3.accessKeyRef,
            secretKey: config.s3.secretKeyRef,
            caFile: config.s3.caFile,
          })
        : makeRemote({ kind: 'local', dir: config.local.dir })
    return remote
  }

  function ensureBreaker() {
    if (breaker !== null) return breaker
    breaker = createBreaker({
      now,
      load: breakerState,
      save: (state) => {
        try {
          db.prepare("INSERT OR REPLACE INTO sync_state(key, value) VALUES ('breaker', ?)").run(JSON.stringify(state))
        } catch {
          /* bookkeeping only */
        }
      },
    })
    return breaker
  }

  /** Keep the trigger guard in step with the configured switch. */
  function syncGuard() {
    try {
      setSyncEnabled(db, config.enabled === true)
    } catch {
      /* the schema may be missing on a failed migration */
    }
  }

  /**
   * @param {any} error
   * @param {string} phase
   */
  function recordFailure(error, phase) {
    const kind = classifyFailure(error)
    const message = String(error?.message ?? error ?? 'error').slice(0, 300)
    log('warn', `sync ${phase} failed (${kind}): ${message}`)
    try {
      db.prepare("INSERT OR REPLACE INTO sync_state(key, value) VALUES ('last_error', ?)").run(JSON.stringify({ at: now(), phase, kind, message }))
    } catch {
      /* ignore */
    }
    ensureBreaker().failure(error)
  }

  /**
   * @param {string} phase
   */
  function recordSuccess(phase) {
    ensureBreaker().success()
    if (phase === 'push' || phase === 'pull') {
      try {
        db.prepare(`INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)`).run(
          phase === 'push' ? 'last_push_at' : 'last_pull_at',
          String(now()),
        )
      } catch {
        /* ignore */
      }
    }
  }

  /** @param {string} key */
  function readState(key) {
    try {
      const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)
      return row === undefined ? '' : String(row.value)
    } catch {
      return ''
    }
  }

  /** @param {string} key @param {unknown} value */
  function writeState(key, value) {
    try {
      db.prepare('INSERT OR REPLACE INTO sync_state(key, value) VALUES (?, ?)').run(key, String(value ?? ''))
    } catch {
      /* bookkeeping only */
    }
  }

  /**
   * Standard Lamport receive rule: once we have seen a stamp, our counter must
   * be strictly greater, otherwise our next edit loses every LWW comparison
   * against the peer we just merged from.
   *
   * @param {number} incoming
   */
  function bumpLamport(incoming) {
    const seen = Number(incoming) || 0
    if (seen <= 0) return
    const local = Number(getSyncMeta(db, 'lamport', '0')) || 0
    if (seen >= local) setSyncMeta(db, 'lamport', seen + 1)
  }

  /** @returns {number} */
  function currentEpoch() {
    return Number(getSyncMeta(db, 'epoch', '1')) || 1
  }

  /**
   * A peer working on a newer epoch is authoritative: adopt its epoch before
   * judging its objects, or we would discard the very truth we need.
   *
   * @param {unknown} incoming
   */
  function adoptEpoch(incoming) {
    const seen = Number(incoming) || 0
    if (seen > currentEpoch()) setSyncMeta(db, 'epoch', seen)
  }

  /**
   * Compare what a snapshot promised with what is local now. An empty string
   * means "matches"; anything else is surfaced in the log and the panel instead
   * of being swallowed.
   *
   * @param {Record<string, number>|undefined} counts
   * @returns {string}
   */
  function reconcile(counts) {
    if (counts === undefined || counts === null) return ''
    const local = localCounts(db)
    const diffs = []
    for (const [key, expected] of Object.entries(counts)) {
      const got = Number(local[key] ?? 0)
      if (Number(expected ?? 0) !== got) diffs.push(`${key} 期望 ${expected} 实得 ${got}`)
    }
    return diffs.join('; ')
  }

  /**
   * Publish this device's shape so the panel can list peers and so a bootstrap
   * has something to reconcile against. Never allowed to fail a snapshot.
   *
   * @param {{ device: string, epoch: number, lamport: number, counts: Record<string, number>, key: string }} input
   * @returns {Promise<string>} the object key, or '' when it could not be written
   */
  async function publishDeviceMeta(input) {
    try {
      const prefix = String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')
      const key = `${prefix}/${workspace}/meta/device-${String(input.device).slice(0, 8)}.json`
      const body = Buffer.from(
        JSON.stringify(
          {
            device: input.device,
            epoch: input.epoch,
            lamport: input.lamport,
            counts: input.counts,
            snapshot: input.key,
            schema: SYNC_SCHEMA_VERSION,
            publishedAt: now(),
          },
          null,
          2,
        ),
        'utf8',
      )
      await ensureRemote().put(key, body, { ifAbsent: false })
      return key
    } catch (error) {
      log('warn', `sync device meta not published: ${String(error?.message ?? error)}`)
      return ''
    }
  }

  function nextSegSeq() {
    return (Number(getSyncMeta(db, 'segseq', '0')) || 0) + 1
  }

  async function pushOnce() {
    const pending = backlog(db)
    if (pending.ops === 0) return { pushed: 0, ops: 0 }
    const ops = unflushedOps(db, { limit: 2000 })
    if (ops.length === 0) return { pushed: 0, ops: 0 }
    const device = getSyncMeta(db, 'device')
    const epoch = Number(getSyncMeta(db, 'epoch', '1')) || 1
    // A segment key must never be overwritten: peers treat a seq as immutable and
    // would skip the new content forever. Pick the first free seq (a cloned DB or
    // two instances sharing one device id would otherwise collide), and keep the
    // HEAD check even when the bucket honours conditional writes — this MinIO
    // silently ignores If-None-Match.
    let seq = nextSegSeq()
    let key = segmentObjectKey({ prefix: config.s3.prefix, workspace, device, seq })
    let body = encodeSegment({ epoch, device, seq, ops, now: now(), ...(encryptOn ? { crypto: syncCrypto } : {}) })
    let written = false
    let overwritten = false
    for (let attempt = 0; attempt < 16 && !written; attempt += 1) {
      const existing = await ensureRemote().head(key)
      if (existing !== null) {
        overwritten = true
        seq += 1
        key = segmentObjectKey({ prefix: config.s3.prefix, workspace, device, seq })
        body = encodeSegment({ epoch, device, seq, ops, now: now(), ...(encryptOn ? { crypto: syncCrypto } : {}) })
        continue
      }
      const result = await ensureRemote().put(key, body, { ifAbsent: config.conditionalPut === true })
      if (result !== null && (result.existed === true || Number(result.status) === 412)) {
        overwritten = true
        seq += 1
        key = segmentObjectKey({ prefix: config.s3.prefix, workspace, device, seq })
        body = encodeSegment({ epoch, device, seq, ops, now: now(), ...(encryptOn ? { crypto: syncCrypto } : {}) })
        continue
      }
      written = true
    }
    if (!written) {
      const error = new Error('could not find a free segment sequence')
      Object.assign(error, { code: 'seq-exhausted' })
      throw error
    }
    advanceWatermark(db, Number(ops[ops.length - 1].seq))
    setSyncMeta(db, 'segseq', seq)
    return { pushed: 1, ops: ops.length, ...(overwritten ? { seqBumped: true } : {}) }
  }

  /**
   * Push vectors the triggers marked dirty.
   *
   * Separate from `pushOnce` on purpose: the oplog is a small ordered stream,
   * while a vector batch is megabytes of base64. Keeping them apart means a
   * failed vector upload cannot hold the truth stream hostage, and a device with
   * `sync.vectors=off` never even looks at this code.
   *
   * @returns {Promise<{ pushed: number, ops: number }>}
   */
  async function pushEmbOnce() {
    const codec = normalizeCodec(config.vectors)
    if (codec === 'off') return { embPushed: 0, embOps: 0 }
    const device = getSyncMeta(db, 'device')
    const epoch = Number(getSyncMeta(db, 'epoch', '1')) || 1
    const perSegment = Math.max(1, Math.floor(Number(config.vectorsPerSegment ?? 40)))
    const stamp = () => ({ epoch, device, seq: 0, now: now(), ...(encryptOn ? { crypto: syncCrypto } : {}) })
    let pushed = 0
    let ops = 0
    // Bounded rounds: a first sync of a full library is spread over several
    // cycles, so one cycle never pins the breaker open for minutes.
    for (let round = 0; round < 12; round += 1) {
      const batch = collectDirtyEmbOps(db, { codec, limit: perSegment })
      if (batch.keys.length === 0) break
      if (batch.ops.length === 0) {
        // Every queued row turned out empty (its fact is already gone): the mark
        // has nothing to carry, so retire it instead of retrying forever.
        markEmbUploaded(db, batch.keys)
        continue
      }
      let seq = (Number(getSyncMeta(db, 'embseq', '0')) || 0) + 1
      let key = embObjectKey({ prefix: config.s3.prefix, workspace, device, seq })
      let body = encodeSegment({ ...stamp(), seq, ops: batch.ops })
      // Same rule as truth segments: a sequence number is immutable once written.
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const existing = await ensureRemote().head(key)
        if (existing === null) break
        seq += 1
        key = embObjectKey({ prefix: config.s3.prefix, workspace, device, seq })
        body = encodeSegment({ ...stamp(), seq, ops: batch.ops })
      }
      await ensureRemote().put(key, body, { ifAbsent: false })
      markEmbUploaded(db, batch.keys)
      setSyncMeta(db, 'embseq', seq)
      pushed += 1
      ops += batch.ops.length
    }
    if (pushed > 0) log('info', `sync vectors pushed: ${ops} op(s) in ${pushed} segment(s)`)
    return { embPushed: pushed, embOps: ops }
  }

  /**
   * Pull vector segments other devices pushed.
   *
   * Cursors live in `sync_peer` under `emb:<device>`, so vector history has its
   * own watermark and cannot confuse the truth stream's cursors.
   *
   * @returns {Promise<{ pulled: number, applied?: number }>}
   */
  async function pullEmbOnce() {
    if (normalizeCodec(config.vectors) === 'off') return { embPulled: 0 }
    const self = getSyncMeta(db, 'device')
    const prefix = `${String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/emb/`
    const objects = (await ensureRemote().list(prefix)).filter((object) => parseEmbObjectKey(object.key) !== null)
    if (objects.length === 0) return { embPulled: 0 }
    const cursors = new Map(
      db
        .prepare("SELECT peer, cursor FROM sync_peer WHERE peer LIKE 'emb:%'")
        .all()
        .map((row) => [String(row.peer), Number(row.cursor) || 0]),
    )
    let pulled = 0
    let applied = 0
    for (const object of [...objects].sort((a, b) => a.key.localeCompare(b.key))) {
      const parsed = parseEmbObjectKey(object.key)
      if (parsed === null || parsed.device === self) continue
      if (parsed.seq <= (cursors.get(`emb:${parsed.device}`) ?? 0)) continue
      const body = await ensureRemote().get(object.key)
      if (body === null) continue
      let decoded
      try {
        decoded = decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto })
      } catch (error) {
        log('warn', `sync vector segment unusable (${object.key}): ${String(error?.message ?? error)}`)
        continue
      }
      if (Number(decoded.header?.epoch ?? 1) < currentEpoch()) continue
      const counts = applyOps(db, decoded.ops)
      applied += counts.applied
      db.prepare('INSERT OR REPLACE INTO sync_peer(peer, cursor, last_seen) VALUES (?, ?, ?)').run(
        `emb:${parsed.device}`,
        parsed.seq,
        now(),
      )
      cursors.set(`emb:${parsed.device}`, parsed.seq)
      pulled += 1
    }
    if (pulled > 0) drainPending(db)
    return { embPulled: pulled, embApplied: applied }
  }

  /**
   * List every object under this workspace.
   * @returns {Promise<Array<{ key: string, size: number, lastModified: number }>>}
   */
  async function listWorkspace() {
    const prefix = `${String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/`
    return ensureRemote().list(prefix)
  }

  /**
   * Parse `.../{device}/{seq}.jsonl.br`.
   * @param {string} key
   * @returns {{ device: string, seq: number } | null}
   */
  function parseSegmentKey(key) {
    const match = /([^/]+)\/(\d{8})\.jsonl\.[a-z]+$/.exec(String(key))
    return match === null ? null : { device: match[1], seq: Number(match[2]) }
  }

  async function pullOnce() {
    const objects = await listWorkspace()
    const self = getSyncMeta(db, 'device')
    /** @type {Map<string, number>} */
    const cursors = new Map(
      db.prepare('SELECT peer, cursor FROM sync_peer').all().map((row) => [String(row.peer), Number(row.cursor)]),
    )
    let applied = 0
    let pulled = 0
    let staleSegments = 0
    const devices = new Set()
    for (const object of objects) {
      const parsed = parseSegmentKey(object.key)
      if (parsed === null) continue
      devices.add(parsed.device)
      if (parsed.device === self) continue
      const cursor = cursors.get(parsed.device) ?? 0
      if (parsed.seq <= cursor) continue
      const body = await ensureRemote().get(object.key)
      if (body === null) continue
      const { header, ops } = decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto })
      adoptEpoch(header?.epoch)
      if (Number(header?.epoch ?? 1) < currentEpoch()) {
        // Retired epoch: skip the payload but advance the cursor so we do not
        // re-fetch it on every cycle. Counted and logged — a silently ignored
        // peer would look like "nothing to sync" forever.
        staleSegments += 1
        log('warn', `sync ignored ${object.key}: written in epoch ${Number(header?.epoch ?? 1)} < ${currentEpoch()}`)
        pulled += 1
        db.prepare('INSERT OR REPLACE INTO sync_peer(peer, cursor, last_seen) VALUES (?, ?, ?)').run(parsed.device, parsed.seq, now())
        cursors.set(parsed.device, parsed.seq)
        continue
      }
      const counts = applyOps(db, ops)
      bumpLamport(ops.reduce((max, op) => Math.max(max, Number(op.lamport) || 0), 0))
      applied += counts.applied
      if (counts.failed > 0) {
        // Never lose an op silently: retry the segment, and after three tries park
        // the payloads in sync_pending so they can be inspected instead of
        // vanishing behind an advanced cursor.
        const stallKey = `stall:${parsed.device}:${parsed.seq}`
        const attempts = (Number(readState(stallKey)) || 0) + 1
        writeState(stallKey, attempts)
        log('warn', `sync segment ${object.key} had ${counts.failed} failed op(s), attempt ${attempts}`)
        if (attempts < 3) continue
        for (const op of ops) {
          try {
            db.prepare('INSERT OR REPLACE INTO sync_pending (op_id, payload, reason, created_at) VALUES (?, ?, ?, ?)').run(
              `${String(op.opId ?? op.op_id ?? 'op')}:failed:${parsed.seq}`,
              JSON.stringify({ kind: 'failed-op', op }),
              'apply-failed',
              now(),
            )
          } catch {
            /* parking is best effort */
          }
        }
        writeState(
          'last_error',
          JSON.stringify({ at: now(), phase: 'pull', kind: 'apply-failed', message: `${counts.failed} op(s) failed in ${object.key}` }),
        )
      }
      pulled += 1
      db.prepare('INSERT OR REPLACE INTO sync_peer(peer, cursor, last_seen) VALUES (?, ?, ?)').run(parsed.device, parsed.seq, now())
      cursors.set(parsed.device, parsed.seq)
    }
    if (pulled > 0) drainPending(db)
    return { pulled, applied, devices: devices.size, ...(staleSegments > 0 ? { staleSegments } : {}) }
  }

  /** Prefix every snapshot object lives under. */
  function snapshotPrefix() {
    return `${String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/snapshot/`
  }

  /**
   * Every manifest object, newest first. Keys carry `<stamp>-<device8>`, so the
   * order is stable without reading anything.
   *
   * @returns {Promise<Array<{ key: string, size: number, lastModified: number, stamp: number, device8: string }>>}
   */
  async function listManifests() {
    const objects = await ensureRemote().list(snapshotPrefix())
    return objects
      .filter((object) => object.key.endsWith('.manifest.json'))
      .map((object) => {
        const match = /(\d+)-([0-9a-f]{8})\.manifest\.json$/.exec(object.key)
        return { ...object, stamp: match === null ? 0 : Number(match[1]), device8: match === null ? '' : String(match[2]) }
      })
      .sort((a, b) => b.stamp - a.stamp)
  }

  /**
   * Merge one snapshot: verify every part against the manifest, then apply.
   *
   * Nothing is applied before the whole snapshot has been read and checked, so
   * a truncated or tampered snapshot cannot leave half a memory behind.
   *
   * @param {string} manifestKey
   * @param {Record<string, any>} manifest
   * @returns {Promise<{ applied: number, parts: number, mismatch: string, key: string }>}
   */
  async function applyManifest(manifestKey, manifest) {
    const parts = [...manifest.parts].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    /** @type {Array<Array<Record<string, any>>>} */
    const batches = []
    for (const part of parts) {
      const body = await ensureRemote().get(part.key)
      if (body === null) throw codedError('snapshot-incomplete', `snapshot part is missing: ${part.key}`)
      if (sha256Hex(body) !== String(part.sha256)) throw codedError('snapshot-corrupt', `snapshot part failed its checksum: ${part.key}`)
      batches.push(decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops)
    }
    let applied = 0
    let parked = 0
    for (const ops of batches) {
      const counts = applyOps(db, ops)
      applied += counts.applied
      parked += counts.pending
    }
    // A snapshot is ordered memory-first, but a supersede op can still point at
    // a row that arrives later in the same batch. Those ops are parked; without
    // draining them here the retired fact would stay active after a bootstrap.
    if (parked > 0) drainPending(db)
    // Vectors last, and one part at a time: every hash they name was written
    // above, so nothing needs parking here.
    let embApplied = 0
    let embSkipped = 0
    const embParts = [...(manifest.embParts ?? [])].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    for (const part of embParts) {
      const body = await ensureRemote().get(part.key)
      if (body === null) throw codedError('snapshot-incomplete', `snapshot vector part is missing: ${part.key}`)
      if (sha256Hex(body) !== String(part.sha256)) {
        throw codedError('snapshot-corrupt', `snapshot vector part failed its checksum: ${part.key}`)
      }
      const ops = decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops
      const counts = applyOps(db, ops)
      embApplied += counts.applied
      // `skipped` is the normal outcome on a device that already holds the same
      // vector (same text_hash): counting only `applied` would report a healthy
      // replay as "0/5905 applied".
      embSkipped += counts.skipped
    }
    if (embParts.length > 0 && Number(manifest.embCount ?? 0) > 0) {
      const expected = Number(manifest.embCount) || 0
      if (embApplied + embSkipped < expected) {
        log('warn', `sync snapshot vectors: applied ${embApplied}, skipped ${embSkipped}, expected ${expected}`)
      }
    }
    if (embParts.length > 0) drainPending(db)
    // Lamport merge: after seeing a peer's clock we must be ahead of it, or our
    // own next edit would be rejected by that peer as "older".
    bumpLamport(Number(manifest.lamport ?? 0) || 0)
    const mismatch = reconcile(manifest.counts)
    log(
      'info',
      `sync snapshot ${manifestKey}: ${applied} applied, ${batches.length} part(s)` +
        `${embParts.length === 0 ? '' : `, ${embApplied} vector(s)`}${mismatch === '' ? '' : `, 对账不符 ${mismatch}`}`,
    )
    return {
      applied,
      parts: batches.length,
      embApplied,
      embSkipped,
      embParts: embParts.length,
      mismatch,
      key: manifestKey,
    }
  }

  /**
   * @param {string} device
   * @param {number} stamp
   */
  function rememberSnapshotPeer(device, stamp) {
    try {
      db.prepare('INSERT OR REPLACE INTO sync_peer(peer, cursor, last_seen) VALUES (?, ?, ?)').run(
        `snap:${String(device).slice(0, 8)}`,
        Math.floor(Number(stamp) || 0),
        now(),
      )
    } catch {
      /* cursor is an optimisation, never a correctness requirement */
    }
  }

  /**
   * The newest complete snapshot published by *another* device, or a reason why
   * there is none.
   *
   * Our own snapshot is never applied to ourselves: it is our own truth, and
   * replaying it would roll back anything edited after the publish.
   *
   * @returns {Promise<{ bootstrapped: boolean, reason?: string, applied?: number, key?: string, parts?: number, mismatch?: string }>}
   */
  async function bootstrap() {
    const self = getSyncMeta(db, 'device')
    const manifests = await listManifests()
    if (manifests.length === 0) return { bootstrapped: false, reason: 'no-snapshot' }
    let sawOwn = false
    let sawStale = false
    /** @type {string | null} */
    let lastError = null
    for (const object of manifests) {
      const raw = await ensureRemote().get(object.key)
      if (raw === null) continue
      let manifest
      try {
        manifest = decodeManifest(raw)
      } catch (error) {
        return { bootstrapped: false, reason: `manifest-invalid:${String(error?.message ?? error)}` }
      }
      if (Number(manifest.schema ?? 0) > SYNC_SCHEMA_VERSION) {
        return { bootstrapped: false, reason: 'incompatible', key: object.key }
      }
      adoptEpoch(manifest.epoch)
      if (Number(manifest.epoch ?? 1) < currentEpoch()) {
        // A snapshot from a retired epoch: after a rotate the old truth must not
        // come back. Newer epochs are adopted above and applied normally.
        sawStale = true
        continue
      }
      if (String(manifest.device ?? '') === self) {
        sawOwn = true
        continue
      }
      try {
        const result = await applyManifest(object.key, manifest)
        rememberSnapshotPeer(manifest.device, Number(manifest.createdAt) || 0)
        return { bootstrapped: true, ...result }
      } catch (error) {
        const kind = String(error?.code ?? '')
        const message = String(error?.message ?? error)
        if (kind === 'decrypt-failed' || message.includes('encrypted')) {
          // Hard stop, never a fallback: an older plaintext snapshot is stale
          // truth, and silently adopting it would look like a successful sync.
          return { bootstrapped: false, reason: 'encrypted', key: object.key, error: message }
        }
        // One damaged snapshot must not wedge this device forever: fall back to
        // the next-newest manifest instead of retrying the same broken one every
        // cycle. Nothing was applied (applyManifest verifies the whole snapshot
        // before touching the database).
        lastError = `${object.key}: ${message}`
        log('warn', `sync snapshot unusable, trying an older one: ${lastError}`)
        continue
      }
    }
    if (lastError !== null) return { bootstrapped: false, reason: 'snapshot-unusable', error: lastError }
    // Only stale-epoch snapshots present (e.g. right after a failed rotate): that
    // is not an error, it is a bucket that needs a new truth — let the caller seed.
    if (sawOwn && !sawStale) return { bootstrapped: false, reason: 'own-snapshot' }
    return { bootstrapped: false, reason: 'no-snapshot' }
  }

  /**
   * Compare this database with the newest snapshot in the bucket, key by key.
   *
   * `ok: true` means "the cloud holds nothing we are missing" — local-only keys
   * are merely rows edited after that snapshot was published, which a republish
   * or the normal segment push will carry. Downloading the whole snapshot on
   * demand is the point: this is the checksum-of-last-resort for a quiet bucket.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async function verify() {
    let manifests
    try {
      manifests = await listManifests()
    } catch (error) {
      return { ok: false, reason: `unreachable:${String(error?.message ?? error)}` }
    }
    if (manifests.length === 0) return { ok: false, reason: 'no-snapshot' }
    const latest = manifests[0]
    const raw = await ensureRemote().get(latest.key)
    if (raw === null) return { ok: false, reason: 'manifest-missing', snapshot: latest.key }
    let manifest
    try {
      manifest = decodeManifest(raw)
    } catch (error) {
      return { ok: false, reason: `manifest-invalid:${String(error?.message ?? error)}`, snapshot: latest.key }
    }
    if (Number(manifest.epoch ?? 1) < currentEpoch()) return { ok: false, reason: 'stale-epoch', snapshot: latest.key }
    const remoteKeys = new Set()
    const parts = [...manifest.parts].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    for (const part of parts) {
      const body = await ensureRemote().get(part.key)
      if (body === null) return { ok: false, reason: 'part-missing', snapshot: latest.key, part: part.key }
      if (sha256Hex(body) !== String(part.sha256)) return { ok: false, reason: 'part-corrupt', snapshot: latest.key, part: part.key }
      for (const op of decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops) remoteKeys.add(verifyKey(op))
    }
    // The segments carry everything written since that snapshot. Without them
    // `localOnly` would simply count "writes newer than the snapshot", which is
    // noise: the question is whether the cloud holds a copy of each key at all.
    const snapshotLamport = Number(manifest.lamport ?? 0) || 0
    let scannedSegments = 0
    let segmentsTruncated = false
    try {
      const objects = (await ensureRemote().list(`${String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/`)).filter(
        (object) => parseSegmentKey(object.key) !== null,
      )
      for (const object of objects) {
        if (scannedSegments >= 200) {
          segmentsTruncated = true
          break
        }
        const body = await ensureRemote().get(object.key)
        if (body === null) continue
        try {
          for (const op of decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops) {
            // Ops older than the snapshot are already folded into it (or were
            // deliberately retired); only newer ones add coverage.
            if (Number(op.lamport) > snapshotLamport) remoteKeys.add(verifyKey(op))
          }
        } catch {
          /* a corrupt segment shows up as missing keys, which is the point */
        }
        scannedSegments += 1
      }
    } catch {
      segmentsTruncated = true
    }

    // ── vector coverage ────────────────────────────────────────────────────
    // Same question as above, asked of the other object class: does the cloud
    // hold a vector for every row this device holds? Only meaningful when this
    // device participates in vector sync at all.
    let emb = null
    if (normalizeCodec(config.vectors) !== 'off') {
      const remoteEmb = new Set()
      for (const part of manifest.embParts ?? []) {
        const body = await ensureRemote().get(part.key)
        if (body === null) continue
        if (sha256Hex(body) !== String(part.sha256)) continue
        for (const op of decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops) {
          if (String(op?.op ?? '') !== 'delete') remoteEmb.add(String(op?.key ?? ''))
        }
      }
      try {
        const embPrefix = `${String(config.s3.prefix || 'v1').replace(/^\/+|\/+$/g, '')}/${workspace}/emb/`
        const objects = (await ensureRemote().list(embPrefix)).filter((object) => parseEmbObjectKey(object.key) !== null)
        for (const object of objects.slice(0, 400)) {
          const body = await ensureRemote().get(object.key)
          if (body === null) continue
          try {
            for (const op of decodeSegment(body, syncCrypto === null ? {} : { crypto: syncCrypto }).ops) {
              if (String(op?.op ?? '') !== 'delete') remoteEmb.add(String(op?.key ?? ''))
            }
          } catch {
            /* an unreadable vector segment shows up as missing keys */
          }
        }
      } catch {
        /* listing is best-effort, same as the truth scan */
      }
      const localEmb = new Set(localEmbKeys(db))
      const missing = [...remoteEmb].filter((key) => !localEmb.has(key))
      const onlyHere = [...localEmb].filter((key) => !remoteEmb.has(key))
      emb = {
        codec: normalizeCodec(config.vectors),
        local: localEmb.size,
        remote: remoteEmb.size,
        missing: missing.length,
        localOnly: onlyHere.length,
        pendingUpload: embStats(db).pending,
        sampleMissing: missing.slice(0, 3),
      }
    }

    const localKeys = new Set(collectSnapshotOps(db, { lamport: 0, device: '', now: 0 }).map(verifyKey))
    const localOnly = [...localKeys].filter((key) => !remoteKeys.has(key))
    const remoteOnly = [...remoteKeys].filter((key) => !localKeys.has(key))
    // "The cloud has a key I do not" needs splitting: if we tombstoned it, the
    // cloud copy is merely stale (a republish fixes it); if we never saw it, we
    // are genuinely behind somebody else.
    const tombstoned = new Set(
      listTombstones(db).map((tomb) => `${String(tomb.tbl)}|${String(tomb.rowKey)}|del`),
    )
    const remoteStale = remoteOnly.filter((key) => tombstoned.has(key))
    const remoteMissing = remoteOnly.filter((key) => !tombstoned.has(key))
    return {
      ok: remoteMissing.length === 0 && (emb === null || emb.missing === 0),
      checkedAt: now(),
      snapshot: latest.key,
      epoch: Number(manifest.epoch ?? 1),
      counts: { local: localKeys.size, remote: remoteKeys.size },
      emb,
      segments: { scanned: scannedSegments, truncated: segmentsTruncated },
      localOnly: localOnly.length,
      remoteOnly: remoteOnly.length,
      remoteMissing: remoteMissing.length,
      remoteStale: remoteStale.length,
      samples: {
        localOnly: localOnly.slice(0, 5),
        remoteMissing: remoteMissing.slice(0, 5),
        remoteStale: remoteStale.slice(0, 5),
      },
    }
  }

  /**
   * Remove one snapshot and every part it claims. Only ever used on snapshots
   * this device published itself — deleting a peer's snapshot would be deciding
   * for their data.
   *
   * @param {Record<string, any>} manifest
   * @param {string} manifestKey
   * @returns {Promise<number>} objects removed
   */
  async function deleteSnapshot(manifest, manifestKey) {
    let removed = 0
    for (const part of [...(manifest.parts ?? []), ...(manifest.embParts ?? [])]) {
      try {
        await ensureRemote().delete(String(part.key))
        removed += 1
      } catch {
        /* a missing part is already gone */
      }
    }
    try {
      await ensureRemote().delete(manifestKey)
      removed += 1
    } catch {
      /* same */
    }
    return removed
  }

  /**
   * Keep only the newest `snapshotKeep` snapshots this device published. Older
   * ones are superseded truth and their parts are pure weight in the bucket.
   *
   * @returns {Promise<number>} snapshots removed
   */
  async function pruneSnapshots() {
    const keep = Math.max(1, Math.floor(Number(config.snapshotKeep ?? 3)))
    const self = String(getSyncMeta(db, 'device')).slice(0, 8)
    const mine = (await listManifests()).filter((entry) => entry.device8 === self)
    const minAgeMs = 3_600_000
    let removed = 0
    for (const old of mine.slice(keep)) {
      if (now() - Number(old.stamp || 0) < minAgeMs) continue
      const raw = await ensureRemote().get(old.key)
      if (raw === null) continue
      let manifest
      try {
        manifest = decodeManifest(raw)
      } catch {
        continue
      }
      await deleteSnapshot(manifest, old.key)
      removed += 1
    }
    if (removed > 0) log('info', `sync pruned ${removed} old snapshot(s)`)
    return removed
  }

  /**
   * Merge snapshots other devices published since we last read theirs.
   *
   * Wide-open seeding would otherwise leave two devices that both started on an
   * empty bucket holding only their own facts forever: snapshots are just large
   * idempotent op bundles, so treating them as one more mergeable stream (once
   * per publish) closes that hole.
   *
   * @returns {Promise<{ snapshots: number, applied: number }>}
   */
  async function pullSnapshots() {
    const self = getSyncMeta(db, 'device')
    const manifests = await listManifests()
    if (manifests.length === 0) return { snapshots: 0, applied: 0 }
    /** @type {Map<string, number>} */
    const cursors = new Map(
      db
        .prepare("SELECT peer, cursor FROM sync_peer WHERE peer LIKE 'snap:%'")
        .all()
        .map((row) => [String(row.peer), Number(row.cursor)]),
    )
    /** @type {Set<string>} */
    const seen = new Set()
    let snapshots = 0
    let applied = 0
    for (const object of manifests) {
      if (object.device8 === '' || object.device8 === String(self).slice(0, 8)) continue
      if (seen.has(object.device8)) continue
      seen.add(object.device8)
      if (object.stamp <= (cursors.get(`snap:${object.device8}`) ?? 0)) continue
      const raw = await ensureRemote().get(object.key)
      if (raw === null) continue
      let manifest
      try {
        manifest = decodeManifest(raw)
      } catch {
        continue
      }
      if (Number(manifest.schema ?? 0) > SYNC_SCHEMA_VERSION) continue
      adoptEpoch(manifest.epoch)
      if (Number(manifest.epoch ?? 1) < currentEpoch()) continue
      try {
        applied += (await applyManifest(object.key, manifest)).applied
        snapshots += 1
        // Only a snapshot we actually applied may be marked as seen: remembering a
        // failed one would skip it forever after a transient glitch.
        rememberSnapshotPeer(manifest.device, Number(manifest.createdAt) || object.stamp)
      } catch (error) {
        log('warn', `sync snapshot merge failed (${String(error?.code ?? 'error')}): ${String(error?.message ?? error)}`)
      }
    }
    return { snapshots, applied }
  }

  /**
   * Drop expired tombstones, unless a peer has been silent since before the
   * cutoff: that peer may still need them to learn about the deletion.
   *
   * @returns {number} rows removed
   */
  function pruneTombstonesSafely() {
    const days = Number(config.tombstoneDays ?? 90)
    if (!Number.isFinite(days) || days <= 0) return 0
    const cutoff = now() - days * 86_400_000
    try {
      const silent = db
        .prepare("SELECT COALESCE(last_seen, 0) AS seen FROM sync_peer WHERE peer NOT LIKE 'snap:%'")
        .all()
        .some((row) => Number(row.seen) < cutoff)
      if (silent) return 0
    } catch {
      /* if we cannot tell, err on the side of keeping them */
      return 0
    }
    return pruneTombstones(db, days)
  }

  /**
   * Snapshot stamps must be strictly increasing on one device: two publishes in
   * the same millisecond would otherwise share a key, and a peer's "already
   * seen up to this stamp" cursor would skip the newer content.
   *
   * @returns {number}
   */
  function monotonicStamp() {
    let previous = 0
    try {
      const raw = readState('last_snapshot')
      previous = raw === '' ? 0 : Number(JSON.parse(raw).at) || 0
    } catch {
      previous = 0
    }
    return Math.max(now(), previous + 1)
  }

  /**
   * Rotate the epoch: bump it, forget peers, then publish the new truth at once.
   * Callers must hold the `running` latch — a publish racing another publish can
   * collide on the snapshot stamp.
   *
   * @returns {Promise<{ epoch: number, snapshot: object|null, error?: string }>}
   */
  async function rotateNow() {
    const next = currentEpoch() + 1
    setSyncMeta(db, 'epoch', next)
    db.prepare('DELETE FROM sync_peer').run()
    setSyncMeta(db, 'bootstrapped', '')
    const published = await publishSnapshot()
    return {
      epoch: next,
      snapshot: published.published === true ? { ops: published.ops, parts: published.parts, key: published.key } : null,
      error: published.published === true ? undefined : (published.error ?? published.skipped ?? published.reason),
    }
  }

  /**
   * Publish a complete snapshot: every layer, tombstones included.
   *
   * Two ordering rules make it safe:
   *   - parts are written first, the manifest last, so a half-written snapshot
   *     is invisible to every reader;
   *   - every op carries the *current* lamport and the local counter is then
   *     bumped past it, so this device's next edit can never look older than
   *     the snapshot it just published (DESIGN-sync-integrity.md E1).
   *
   * @returns {Promise<{ published?: boolean, skipped?: string, ops?: number, parts?: number, key?: string, lamport?: number, reason?: string, error?: string }>}
   */
  async function publishSnapshot() {
    if (!config.enabled) return { skipped: 'disabled' }
    const stamp = monotonicStamp()
    try {
      pruneTombstonesSafely()
      const device = getSyncMeta(db, 'device')
      const epoch = Number(getSyncMeta(db, 'epoch', '1')) || 1
      const lamport = Number(getSyncMeta(db, 'lamport', '0')) || 0
      const ops = collectSnapshotOps(db, { lamport, device, now: stamp })
      if (ops.length === 0) return { published: false, ops: 0, reason: 'nothing-to-publish' }
      const perPart = Math.max(200, Math.floor(Number(config.snapshotOpsPerPart ?? 2000)))
      const parts = []
      for (let index = 0; index * perPart < ops.length; index += 1) {
        const slice = ops.slice(index * perPart, (index + 1) * perPart)
        const body = encodeSegment({ epoch, device, seq: 99999999, ops: slice, now: stamp, ...(encryptOn ? { crypto: syncCrypto } : {}) })
        const key = snapshotPartKey({ prefix: config.s3.prefix, workspace, stamp, device, index })
        await ensureRemote().put(key, body, { ifAbsent: false })
        parts.push({ index, key, ops: slice.length, bytes: body.length, sha256: sha256Hex(body) })
      }
      // Vectors are written after the truth they describe: a restoring device
      // applies parts first, so every hash a vector names already exists.
      const embCodec = normalizeCodec(config.vectors)
      const embParts = []
      let embCount = 0
      if (embCodec !== 'off') {
        const perPart = Math.max(1, Math.floor(Number(config.vectorsPerSegment ?? 40)))
        // Uploads run four at a time: one part is ~460 KB and a home MinIO takes
        // tens of milliseconds per PUT, so a serial walk is dominated by
        // round-trips. The window keeps memory flat (4 × part) and the pipe full.
        const maxInFlight = 4
        /** @type {Set<Promise<void>>} */
        const inFlight = new Set()
        /** @type {Error[]} */
        const uploadErrors = []
        let afterHash
        let afterModel
        for (let index = 0; index < 4000; index += 1) {
          while (inFlight.size >= maxInFlight) await Promise.race(inFlight)
          const slice = readEmbPage(db, {
            codec: embCodec,
            afterHash,
            afterModel,
            limit: perPart,
            lamport,
            device,
            now: stamp,
          })
          if (slice.length === 0) break
          const boundary = slice[slice.length - 1].payload
          afterHash = String(boundary?.hash ?? '')
          afterModel = String(boundary?.model ?? '')
          const body = encodeSegment({
            epoch,
            device,
            seq: 99999998,
            ops: slice,
            now: stamp,
            ...(encryptOn ? { crypto: syncCrypto } : {}),
          })
          const key = embPartKey({ prefix: config.s3.prefix, workspace, stamp, device, index })
          embParts.push({ index, key, ops: slice.length, bytes: body.length, sha256: sha256Hex(body) })
          embCount += slice.length
          const task = ensureRemote()
            .put(key, body, { ifAbsent: false })
            .then(() => undefined)
            .catch((error) => {
              uploadErrors.push(error)
            })
            .finally(() => inFlight.delete(task))
          inFlight.add(task)
        }
        await Promise.all(inFlight)
        if (uploadErrors.length > 0) throw uploadErrors[0]
      }
      const manifest = {
        workspace,
        device,
        epoch,
        lamport,
        schema: SYNC_SCHEMA_VERSION,
        createdAt: stamp,
        totalOps: ops.length,
        counts: snapshotCounts(ops),
        parts,
        ...(embCodec === 'off' ? {} : { embCodec, embCount, embParts }),
      }
      const key = snapshotManifestKey({ prefix: config.s3.prefix, workspace, stamp, device })
      await ensureRemote().put(key, encodeManifest(manifest), { ifAbsent: false })
      // Never write the counter backwards: a local edit may land while the parts
      // are being uploaded, and rolling the counter back would make the next
      // capture reuse an op_id and trip the UNIQUE constraint.
      const latestLamport = Math.max(Number(getSyncMeta(db, 'lamport', '0')) || 0, lamport)
      setSyncMeta(db, 'lamport', latestLamport + 1)
      // This device published its whole truth: it is now a valid source and no
      // longer needs to bootstrap from anyone.
      setSyncMeta(db, 'bootstrapped', '1')
      await publishDeviceMeta({ device, epoch, lamport, counts: manifest.counts, key })
      writeState(
        'last_snapshot',
        JSON.stringify({ at: stamp, key, ops: ops.length, parts: parts.length, embOps: embCount, embParts: embParts.length, lamport }),
      )
      log(
        'info',
        `sync snapshot published: ${ops.length} ops in ${parts.length} part(s)` +
          `${embParts.length === 0 ? '' : ` + ${embCount} vectors in ${embParts.length} part(s)`} → ${key}`,
      )
      try {
        await pruneSnapshots()
      } catch (error) {
        log('warn', `sync snapshot retention failed: ${String(error?.message ?? error)}`)
      }
      return { published: true, ops: ops.length, parts: parts.length, key, lamport, embOps: embCount, embParts: embParts.length }
    } catch (error) {
      recordFailure(error, 'snapshot')
      return { published: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Did the vector switch come on *after* the last snapshot was published?
   *
   * The triggers only mark writes that happen while they exist: turning
   * `sync.vectors` on (or upgrading into v4) leaves every existing vector
   * unmarked, so without a deliberate republish the library would never reach
   * the bucket — `maybeRepublishSnapshot` only fires on a fresh tombstone.
   *
   * @returns {boolean}
   */
  function needsVectorSnapshot() {
    if (normalizeCodec(config.vectors) === 'off') return false
    if (embStats(db).rows === 0) return false
    let last = null
    try {
      const raw = readState('last_snapshot')
      last = raw === '' ? null : JSON.parse(raw)
    } catch {
      last = null
    }
    if (last !== null && Number(last.embParts ?? 0) > 0 && Number(last.embOps ?? 0) > 0) return false
    return true
  }

  /**
   * Publish a snapshot when something was retired and the last snapshot is
   * getting old — the only way a tombstone reaches a device that stayed offline
   * longer than the oplog retention.
   *
   * @returns {Promise<{ published?: boolean, ops?: number, parts?: number } | null>}
   */
  async function maybeRepublishSnapshot() {
    const hours = Number(config.snapshotEveryHours ?? 24)
    if (!Number.isFinite(hours) || hours <= 0) return null
    let lastAt = 0
    try {
      const raw = readState('last_snapshot')
      lastAt = raw === '' ? 0 : Number(JSON.parse(raw).at) || 0
    } catch {
      lastAt = 0
    }
    if (now() - lastAt < hours * 3_600_000) return null
    let newestTombstone = 0
    try {
      newestTombstone = Number(db.prepare('SELECT COALESCE(MAX(deleted_at), 0) AS t FROM sync_tombstone').get()?.t ?? 0)
    } catch {
      newestTombstone = 0
    }
    if (newestTombstone <= lastAt) return null
    return publishSnapshot()
  }

  /**
   * Run one guarded cycle.
   * @param {'push'|'pull'|'both'} direction
   */
  async function cycle(direction) {
    if (!config.enabled) return { skipped: 'disabled' }
    if (running) return { skipped: 'busy' }
    const gate = ensureBreaker().before()
    if (!gate.allowed) return { skipped: 'open', waitMs: gate.waitMs }
    running = true
    try {
      const result = { direction }
      if (direction === 'pull' || direction === 'both') {
        if (getSyncMeta(db, 'bootstrapped', '') === '') {
          const hadLocalData = hasLocalData(db)
          const boot = await bootstrap()
          if (boot.bootstrapped) {
            setSyncMeta(db, 'bootstrapped', '1')
            result.bootstrap = { applied: boot.applied, parts: boot.parts, key: boot.key, mismatch: boot.mismatch }
            // Merge-back only when we brought something of our own: a device that
            // was empty has nothing to add, and republishing there is pure noise.
            if (hadLocalData) {
              const mergedBack = await publishSnapshot()
              if (mergedBack.published === true) result.mergedBack = { ops: mergedBack.ops, parts: mergedBack.parts }
            } else {
              // We brought nothing of our own, so the remote already holds an
              // equivalent snapshot: start the republish clock here instead of
              // eagerly shipping 2 MB just because this device inherited some
              // tombstones.
              writeState('last_snapshot', JSON.stringify({ at: now(), key: boot.key, ops: boot.applied, inherited: true }))
            }
          } else if (boot.reason === 'encrypted') {
            // We cannot read the newest truth and must not pretend an older
            // plaintext snapshot is current.
            writeState(
              'last_error',
              JSON.stringify({ at: now(), phase: 'bootstrap', kind: 'encrypted', message: `快照已加密，本机缺少密钥：${boot.key ?? ''}` }),
            )
            result.encryptionRequired = true
            recordFailure(Object.assign(new Error('snapshot is encrypted and this device has no key'), { code: 'decrypt-failed' }), 'bootstrap')
            return result
          } else if (boot.reason === 'snapshot-unusable') {
            // Remote has snapshots but none could be applied. Do not seed over
            // them — that would publish our partial truth as the newest snapshot.
            writeState(
              'last_error',
              JSON.stringify({ at: now(), phase: 'bootstrap', kind: 'snapshot-unusable', message: String(boot.error ?? '') }),
            )
            result.bootstrapError = String(boot.error ?? 'snapshot-unusable')
          } else if (boot.reason === 'incompatible') {
            // A newer remote shape is a hard stop: never apply it, never wipe anything.
            writeState(
              'last_error',
              JSON.stringify({ at: now(), phase: 'bootstrap', kind: 'incompatible', message: `远端快照版本高于本机：${boot.key ?? ''}` }),
            )
            result.incompatible = true
          } else if (boot.reason === 'own-snapshot') {
            // Only our own snapshot exists: we are the source of truth, so there
            // is nothing to bootstrap and nothing to re-publish.
            setSyncMeta(db, 'bootstrapped', '1')
          } else {
            // Nothing on the remote: this machine becomes the seed and pushes
            // the whole truth, which is what "first sync" has to mean.
            const seeded = await publishSnapshot()
            if (seeded.published === true) {
              setSyncMeta(db, 'bootstrapped', '1')
              result.seeded = { ops: seeded.ops, parts: seeded.parts, key: seeded.key }
            } else if (seeded.reason !== 'nothing-to-publish' && seeded.skipped === undefined) {
              result.seedError = seeded.error ?? seeded.reason ?? 'unknown'
            }
          }
        }
        Object.assign(result, await pullOnce())
        Object.assign(result, await pullEmbOnce())
        const merged = await pullSnapshots()
        if (merged.snapshots > 0) result.snapshots = merged
        recordSuccess('pull')
      }
      if (direction === 'push' || direction === 'both') {
        // Turning vectors on must not wait for a deletion: the existing library
        // predates the triggers, so only a snapshot can carry it.
        if (needsVectorSnapshot()) {
          const vectorSnap = await publishSnapshot()
          if (vectorSnap.published === true) {
            result.vectorSnapshot = { ops: vectorSnap.ops, parts: vectorSnap.parts, embOps: vectorSnap.embOps, embParts: vectorSnap.embParts }
          } else if (vectorSnap.error !== undefined) {
            result.vectorSnapshotError = vectorSnap.error
          }
        }
        // A backlog this big means the incremental chain can no longer be
        // trusted; publish a fresh snapshot before pushing the rest.
        if (needsSnapshot(db)) {
          const fresh = await publishSnapshot()
          if (fresh.published === true) result.republished = { ops: fresh.ops, parts: fresh.parts, reason: 'gap' }
        }
        Object.assign(result, await pushOnce())
        Object.assign(result, await pushEmbOnce())
        // Trim only what is already durably remote; unflushed ops are the only
        // copy of those changes.
        try {
          pruneOplog(db, { keepDays: Number(config.oplogKeepDays ?? 30) })
          // Parked ops are a safety net, not an archive — except supersede ops:
          // dropping one would let a retired fact stay active on a peer forever.
          db.prepare("DELETE FROM sync_pending WHERE created_at < ? AND reason <> 'supersede-target-missing'").run(
            now() - 30 * 86_400_000,
          )
        } catch {
          /* housekeeping only */
        }
        recordSuccess('push')
      }
      const refreshed = await maybeRepublishSnapshot()
      if (refreshed !== null && refreshed.published === true) result.republished = { ops: refreshed.ops, parts: refreshed.parts }
      return result
    } catch (error) {
      recordFailure(error, direction)
      return { error: String(error?.message ?? error) }
    } finally {
      running = false
    }
  }

  function startTimer() {
    if (interval !== null) return
    const every = Math.max(10, Number(config.everySeconds) || 300) * 1000
    interval = timers.setInterval(() => {
      void cycle('both')
    }, every)
    if (typeof interval?.unref === 'function') interval.unref()
  }

  function stopTimer() {
    if (interval === null) return
    timers.clearInterval(interval)
    interval = null
  }

  return {
    start() {
      if (started) return
      started = true
      syncGuard()
      if (!config.enabled) return
      ensureBreaker()
      if (config.mode === 'auto') {
        void cycle('both')
        startTimer()
      }
    },

    stop() {
      stopTimer()
      started = false
    },

    reconfigure(next) {
      this.stop()
      config = normalize({ ...next, ...(next?.s3 ? { s3: next.s3 } : {}) })
      remote = null
      breaker = null
      syncGuard()
      this.start()
    },

    status() {
      const gate = breaker === null ? null : breaker.snapshot()
      const pending = safeBacklog(db)
      let error = null
      try {
        const raw = readState('last_error')
        error = raw === '' ? null : JSON.parse(raw)
      } catch {
        error = null
      }
      return {
        available: true,
        enabled: config.enabled,
        mode: config.mode,
        everySeconds: config.everySeconds,
        endpoint: config.remote === 's3' ? config.s3.endpoint : config.local.dir,
        bucket: config.remote === 's3' ? config.s3.bucket : '',
        workspace,
        device: getSyncMeta(db, 'device'),
        epoch: Number(getSyncMeta(db, 'epoch', '1')) || 1,
        state: gate?.state ?? 'closed',
        waitMs: gate?.waitMs ?? 0,
        running,
        backlog: pending,
        // A device that has not bootstrapped yet is the state in which "first
        // sync" seeds the bucket; the panel needs to tell that apart from a
        // genuine no-op cycle.
        seeded: getSyncMeta(db, 'bootstrapped', '') === '1',
        encryption: { requested: config.encrypt !== false, active: encryptOn, keyPresent: syncCrypto !== null },
        // Vector sync is opt-in: `{ codec: 'off' }` is the whole story then.
        vectors: (() => {
          const codec = normalizeCodec(config.vectors)
          if (codec === 'off') return { codec: 'off', rows: 0, pending: 0, bytes: 0, dims: 0, models: [] }
          const stats = embStats(db)
          return { codec, perSegment: config.vectorsPerSegment ?? 40, ...stats }
        })(),
        lastSnapshot: (() => {
          try {
            const raw = readState('last_snapshot')
            return raw === '' ? null : JSON.parse(raw)
          } catch {
            return null
          }
        })(),
        lastPushAt: Number(readState('last_push_at')) || null,
        lastPullAt: Number(readState('last_pull_at')) || null,
        peers: db.prepare('SELECT peer, cursor, last_seen AS lastSeen FROM sync_peer').all().map((row) => ({
          peer: String(row.peer),
          cursor: Number(row.cursor),
          lastSeen: row.lastSeen === null ? null : Number(row.lastSeen),
        })),
        error,
      }
    },

    pushNow: () => cycle('push'),
    pullNow: () => cycle('pull'),
    syncNow: () => cycle('both'),

    async testConnection() {
      const startedAt = now()
      try {
        const objects = await listWorkspace()
        return { ok: true, ms: now() - startedAt, objects: objects.length, endpoint: config.remote === 's3' ? config.s3.endpoint : config.local.dir }
      } catch (error) {
        return { ok: false, ms: now() - startedAt, error: String(error?.message ?? error), kind: classifyFailure(error) }
      }
    },

    /**
     * Start a new epoch.
     *
     * The new epoch has to carry a full truth immediately, otherwise a device
     * that rotates later finds no snapshot it is allowed to bootstrap from.
     * Old-epoch objects are left in place on purpose (this device cannot speak
     * for other devices' data); readers ignore them by epoch.
     */
    async rotate() {
      if (running) return { skipped: 'busy' }
      running = true
      try {
        return await rotateNow()
      } finally {
        running = false
      }
    },

    publishSnapshot,
    verify,
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * One comparable identity for an op, so a local row and a snapshot row can be
 * matched without comparing payloads.
 *
 * @param {Record<string, any>} op
 * @returns {string}
 */
function verifyKey(op) {
  return `${String(op?.tbl ?? '')}|${String(op?.key ?? '')}${String(op?.op ?? '') === 'delete' ? '|del' : ''}`
}

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Row counts for every synced layer, used to reconcile a bootstrap.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ memory: number, history: number, l0: number, scenes: number, persona: number }}
 */
function localCounts(db) {
  const one = (sql) => {
    try {
      return Number(db.prepare(sql).get()?.n ?? 0)
    } catch {
      return 0
    }
  }
  return {
    memory: one('SELECT COUNT(*) AS n FROM memory'),
    history: one('SELECT COUNT(*) AS n FROM memory_history'),
    l0: one('SELECT COUNT(*) AS n FROM l0_turns'),
    scenes: one('SELECT COUNT(*) AS n FROM l2_scenes'),
    persona: one('SELECT COUNT(*) AS n FROM l3_persona'),
    tombstones: one('SELECT COUNT(*) AS n FROM sync_tombstone'),
  }
}

/**
 * Does this database hold anything worth publishing?
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
function hasLocalData(db) {
  const counts = localCounts(db)
  return Object.values(counts).some((value) => Number(value) > 0)
}

/**
 * @param {Array<Record<string, any>>} ops
 * @returns {Record<string, number>}
 */
function snapshotCounts(ops) {
  const counts = { memory: 0, history: 0, l0: 0, scenes: 0, persona: 0, tombstones: 0 }
  for (const op of ops) {
    if (op.op === 'delete') {
      counts.tombstones += 1
      continue
    }
    if (op.tbl === 'memory') counts.memory += 1
    else if (op.tbl === 'memory_history') counts.history += 1
    else if (op.tbl === 'l0_turns') counts.l0 += 1
    else if (op.tbl === 'l2_scenes') counts.scenes += 1
    else if (op.tbl === 'l3_persona') counts.persona += 1
  }
  return counts
}

/**
 * Every row a snapshot must carry, in the only order that replays correctly:
 * memory (live *and* retired, so the supersede chain survives), their history,
 * then L0, scenes, personas, then the tombstones of keys that are gone here.
 *
 * Field names mirror the capture triggers in `schema.js` exactly — a payload
 * that drifts from a trigger shape would apply as a half-written row.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ lamport?: number, device?: string, now?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function collectSnapshotOps(db, options = {}) {
  const lamport = Number(options.lamport ?? 0) || 0
  const device = String(options.device ?? '')
  const stamp = Number(options.now ?? Date.now())
  /** @type {Array<Record<string, any>>} */
  const ops = []
  const push = (tbl, key, op, payload, createdAt, lamportOverride) => {
    ops.push({
      opId: `snapshot:${stamp}:${tbl}:${key}`,
      tbl,
      key: String(key),
      op,
      lamport: Number(lamportOverride ?? lamport) || 0,
      device,
      payload,
      createdAt: Number(createdAt) || stamp,
    })
  }

  const memoryRows = db
    .prepare(
      `SELECT m.hash, m.kind, m.scope, m.project, m.session_id, m.title, m.text, m.tags, m.source,
              m.priority, m.pinned, m.scene, m.source_seqs, m.created_at, m.updated_at, m.version,
              m.superseded_by AS superseded_by_id,
              (SELECT s.hash FROM memory s WHERE s.id = m.superseded_by) AS superseded_by_hash
         FROM memory m`,
    )
    .all()
  /** Rows retired by a successor that has since been deleted: dangling pointers. */
  const danglingRetired = new Set()
  for (const row of memoryRows) {
    if (row.superseded_by_id !== null && row.superseded_by_id !== undefined && row.superseded_by_hash === null) {
      // The row counts as retired locally (every read filters superseded_by IS
      // NULL) but its successor is gone, so the snapshot has no way to say
      // "retired" other than a deletion. Carrying it as an upsert would resurrect
      // a dead fact on every fresh device.
      danglingRetired.add(String(row.hash))
      push('memory', row.hash, 'delete', { hash: row.hash, deleted_at: row.updated_at }, row.updated_at)
      continue
    }
    push(
      'memory',
      row.hash,
      'upsert',
      {
        kind: row.kind,
        scope: row.scope,
        project: row.project,
        session_id: row.session_id,
        title: row.title,
        text: row.text,
        tags: row.tags,
        source: row.source,
        priority: row.priority,
        pinned: row.pinned,
        scene: row.scene,
        source_seqs: row.source_seqs,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version: row.version,
        superseded_by_hash: row.superseded_by_hash ?? null,
      },
      row.updated_at,
    )
  }

  const historyRows = db
    .prepare(
      `SELECT m.hash AS hash, h.version, h.op, h.text, h.created_at
         FROM memory_history h JOIN memory m ON m.id = h.memory_id
        ORDER BY m.hash, h.version`,
    )
    .all()
  for (const row of historyRows) {
    if (danglingRetired.has(String(row.hash))) continue
    push(
      'memory_history',
      historyKey(row.hash, row.version),
      'upsert',
      { version: row.version, op: row.op, text: row.text, created_at: row.created_at, hash: row.hash },
      row.created_at,
    )
  }

  const turnRows = db
    .prepare('SELECT session_id, turn, project, user_text, assistant_text, tool_names, created_at FROM l0_turns')
    .all()
  for (const row of turnRows) {
    push(
      'l0_turns',
      l0Key(row),
      'upsert',
      {
        session_id: row.session_id,
        turn: row.turn,
        project: row.project,
        user_text: row.user_text,
        assistant_text: row.assistant_text,
        tool_names: row.tool_names,
        created_at: row.created_at,
      },
      row.created_at,
    )
  }

  const sceneRows = db
    .prepare('SELECT scope, project, name, summary, body, heat, fact_count, created_at, updated_at FROM l2_scenes')
    .all()
  for (const row of sceneRows) {
    push(
      'l2_scenes',
      sceneKey(row),
      'upsert',
      {
        scope: row.scope,
        project: row.project,
        name: row.name,
        summary: row.summary,
        body: row.body,
        heat: row.heat,
        fact_count: row.fact_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      row.updated_at,
    )
  }

  const personaRows = db.prepare('SELECT scope, project, body, version, updated_at FROM l3_persona').all()
  for (const row of personaRows) {
    push(
      'l3_persona',
      personaKey(row),
      'upsert',
      { scope: row.scope, project: row.project, body: row.body, version: row.version, updated_at: row.updated_at },
      row.updated_at,
    )
  }

  // Tombstones last, and only for keys this database no longer holds: a key
  // that was deleted and then recreated must travel as the live row only.
  const liveKeys = new Map([
    ['memory', new Set(memoryRows.map((row) => String(row.hash)))],
    ['l2_scenes', new Set(sceneRows.map((row) => sceneKey(row)))],
    ['l3_persona', new Set(personaRows.map((row) => personaKey(row)))],
  ])
  for (const tomb of listTombstones(db)) {
    const known = liveKeys.get(tomb.tbl)
    if (known !== undefined && known.has(tomb.rowKey)) continue
    if (tomb.tbl !== 'memory' && tomb.tbl !== 'l2_scenes' && tomb.tbl !== 'l3_persona') continue
    const pieces = tomb.rowKey.split('|')
    const payload =
      tomb.tbl === 'memory'
        ? { hash: tomb.rowKey, deleted_at: tomb.deletedAt }
        : tomb.tbl === 'l2_scenes'
          ? { scope: pieces[0] ?? 'project', project: pieces[1] ? pieces[1] : null, name: pieces.slice(2).join('|') }
          : { scope: pieces[0] ?? 'global', project: pieces[1] ? pieces[1] : null }
    // The delete must not look older than whatever the peer last knew about the key.
    push(tomb.tbl, tomb.rowKey, 'delete', payload, tomb.deletedAt, Math.max(lamport, tomb.lamport))
  }

  return ops
}

/**
 * @param {{ ops: number, bytes: number }} _unused
 * @returns {{ ops: number, bytes: number }}
 */
function safeBacklog(db) {
  try {
    const value = backlog(db)
    return { ops: value.ops, bytes: value.bytes }
  } catch {
    return { ops: 0, bytes: 0 }
  }
}

/**
 * Fill in defaults so the engine never reads `undefined`.
 * @param {any} raw
 * @returns {SyncConfig}
 */
function normalize(raw) {
  const sync = raw ?? {}
  const s3 = sync.s3 ?? {}
  return {
    enabled: sync.enabled === true,
    mode: sync.mode === 'auto' ? 'auto' : 'manual',
    everySeconds: Number(sync.everySeconds ?? 300),
    workspace: typeof sync.workspace === 'string' ? sync.workspace : '',
    encrypt: sync.encrypt !== false,
    conditionalPut: sync.conditionalPut === true,
    tombstoneDays: Number(sync.tombstoneDays ?? 90),
    oplogKeepDays: Number(sync.oplogKeepDays ?? 30),
    snapshotOpsPerPart: Number(sync.snapshotOpsPerPart ?? 2000),
    snapshotKeep: Number(sync.snapshotKeep ?? 3),
    // Vectors are opt-in: `off` keeps the bucket at truth-only size. The codec
    // decides precision and bytes; the segment size caps one upload object.
    vectors: normalizeCodec(sync.vectors),
    vectorsPerSegment: Math.max(1, Math.floor(Number(sync.vectorsPerSegment ?? 40))),
    encryptKey: String(sync.encryptKey ?? ''),
    remote: sync.remote === 's3' ? 's3' : 'local',
    local: { dir: String(sync.local?.dir ?? '') },
    s3: {
      endpoint: String(s3.endpoint ?? ''),
      bucket: String(s3.bucket ?? ''),
      region: String(s3.region ?? 'us-east-1'),
      pathStyle: s3.pathStyle !== false,
      prefix: String(s3.prefix ?? 'v1'),
      accessKeyRef: String(s3.accessKeyRef ?? ''),
      secretKeyRef: String(s3.secretKeyRef ?? ''),
      caFile: s3.caFile === undefined ? undefined : String(s3.caFile),
    },
  }
}
