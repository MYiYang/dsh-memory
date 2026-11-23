/**
 * Dynamic settings for dsh-memory.
 *
 * One field catalog owns every configurable knob: where it lives in the config
 * object (`path`), how it is validated (`type` + range/options), and whether it
 * can be applied to a live plugin instance (`live`).
 *
 * The settings page and the loader both end up here:
 *
 *   defaults (this module)  <  loader row config  <  $DSH_HOME/memory/settings.json
 *
 * `resolveConfig` used to live in `index.js`; it moved here so the default of
 * every field is derived from the same normalizer that runs at boot — a field
 * can never drift from the value the plugin actually starts with.
 *
 * @module dsh-memory/settings
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CORE_PRIORITY } from './store.js'
import { parseDecisionEndpoint } from './decision.js'

/** Format version written into settings.json. */
export const SETTINGS_VERSION = 1

/**
 * DSH home directory: `$DSH_HOME` when set (every profile-launched shell has
 * it), else the user's `~/.dsh`.
 * @returns {string}
 */
export function resolveHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * Fixed location of the settings file: beside the default database, so the
 * settings page can show "database + settings" as one storage directory.
 * Deliberately independent of `dbPath`: relocating the database must not lose
 * the setting that relocates it.
 * @returns {string}
 */
export function resolveSettingsPath() {
  return join(resolveHome(), 'memory', 'settings.json')
}

/**
 * Resolve the database path from config / DSH_HOME.
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function resolveDbPath(config) {
  if (typeof config.dbPath === 'string' && config.dbPath.trim() !== '') {
    return String(config.dbPath).replace(/^~(?=$|[\\/])/, homedir())
  }
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'memory', 'memory.db')
}

/**
 * Normalize the merged loader + settings config.
 * @param {unknown} raw
 */
export function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const number = (value, fallback, min, max) =>
    Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback
  const section = (value) => (value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {})
  const layers = section(config.layers)
  const extraction = section(config.extraction)
  const scenes = section(config.scenes)
  const persona = section(config.persona)
  const jev = section(persona.jev)
  const vector = section(config.vector)
  const syncRaw = section(config.sync)
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
      // The idle timer dies with the process, so a session's last turns can sit
      // un-extracted for days. One bounded, non-blocking sweep at startup closes
      // that hole; it is on by default because it only *schedules* work.
      sweepOnStart: extraction.sweepOnStart !== false,
      sweepSessions: number(extraction.sweepSessions, 20, 1, 200),
      sweepDelayMs: number(extraction.sweepDelayMs, 8_000, 1_000, 120_000),
      // Repeating passes: every few minutes, but only for turns older than
      // `sweepMinAgeMs` so fresh ones stay with the threshold/idle path.
      sweepIntervalMs: number(extraction.sweepIntervalMs, 300_000, 0, 3_600_000),
      sweepMinAgeMs: number(extraction.sweepMinAgeMs, 1_800_000, 0, 86_400_000),
    },
    scenes: {
      enabled: scenes.enabled !== false,
      minFacts: number(scenes.minFacts, 3, 1, 20),
      maxScenes: number(scenes.maxScenes, 20, 1, 100),
      halfLifeDays: number(scenes.halfLifeDays, 14, 1, 365),
    },
    persona: {
      enabled: persona.enabled !== false,
      // How the L3 rewrite is scheduled. `current` (default) counts the facts
      // written since the last real persona write and never calls the gate;
      // `jev` lets the gate add a rewrite when that trigger does not fire;
      // `legacy` keeps the old batch counter plus gate-on-facts path.
      triggerMode:
        persona.triggerMode === 'jev' || persona.triggerMode === 'legacy' ? persona.triggerMode : 'current',
      // Facts written since the last real persona write before one is due
      // (upstream `memories_since_last_persona`, default 50).
      defaultThreshold: number(persona.defaultThreshold, 50, 1, 500),
      // Only meaningful in `legacy` mode: L1 batches between gate checks.
      triggerEveryN: number(persona.triggerEveryN, 10, 1, 100),
      maxChars: number(persona.maxChars, 1200, 200, 8000),
      // What the generator aims at (maxChars stays the hard cap). A persona
      // longer than 1.4× the target is rewritten on the spot ("compact").
      targetChars: number(persona.targetChars, 700, 120, 8000),
      globalTargetChars: number(persona.globalTargetChars, 240, 120, 8000),
      // The persona rewrite is the longest JSON answer this plugin asks for;
      // reasoning tokens eat the budget first, so it gets its own (bigger) caps
      // and asks for low effort before falling back to the model default.
      personaMaxTokens: number(persona.personaMaxTokens, 4000, 400, 16000),
      personaTimeoutMs: number(persona.personaTimeoutMs, 120000, 5000, 600000),
      personaReasoningEffort:
        typeof persona.personaReasoningEffort === 'string' && persona.personaReasoningEffort !== ''
          ? persona.personaReasoningEffort
          : 'low',
      // L3 also maintains a cross-project profile built from global facts.
      // It has its own batch counter and gate, so it never starves the project one.
      global: persona.global !== false,
      // Judgment backend used only when `triggerMode = "jev"`. `llm` asks the
      // host model (nothing else to configure); `jev` posts the upstream System
      // One wire format to an external service and needs endpoint + model + key.
      jev: {
        provider: jev.provider === 'jev' ? 'jev' : 'llm',
        endpoint: text(jev.endpoint),
        model: text(jev.model),
        // Credential *reference* (env var name); non-identifiers are literals.
        apiKeyRef: text(jev.apiKeyRef),
        timeoutMs: number(jev.timeoutMs, 3_000, 100, 60_000),
        diagnostics: jev.diagnostics === 'full' ? 'full' : jev.diagnostics === 'off' ? 'off' : 'metadata',
      },
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
      // ── vector model (see ANALYSIS-vector-model.md) ──────────────────────
      // `hash` keeps the in-process lexical vector, which is what runs when the
      // user configures nothing. `openai` sends text to a compatible
      // `/embeddings` endpoint and stores the result in memory_embeddings.
      provider: vector.provider === 'openai' ? 'openai' : 'hash',
      model: text(vector.model),
      // 0 = auto: known-model table → cached probe → one live probe.
      dims: number(vector.dims, 0, 0, 4096),
      baseUrl: text(vector.baseUrl),
      // A credential *reference* (env var name) resolved through the host
      // credentials service; a value that is not an identifier is used literally.
      apiKeyRef: text(vector.apiKeyRef),
      // Absolute cosine floor: unrelated pairs score ~0.7 on some model
      // families and ~0.4 on others, so this cannot have one universal default.
      minCosine: number(vector.minCosine, 0.5, 0, 1),
      timeoutMs: number(vector.timeoutMs, 5_000, 500, 60_000),
    },
    // Bundled skills shipped inside this package (`./skills`).
    skills: {
      enabled: section(config.skills).enabled !== false,
      dir: text(section(config.skills).dir),
    },
    // Cloud sync (opt-in, off by default). Nothing here touches the network
    // until sync.enabled is true and a remote is configured; sync.mode decides
    // whether the engine runs on a timer or only on an explicit "sync now".
    sync: {
      enabled: syncRaw.enabled === true,
      mode: syncRaw.mode === 'auto' ? 'auto' : 'manual',
      everySeconds: number(syncRaw.everySeconds, 300, 10, 3600),
      workspace: text(syncRaw.workspace, 'default'),
      encrypt: syncRaw.encrypt !== false,
      conditionalPut: syncRaw.conditionalPut === true,
      // `off` keeps the bucket at truth-only size. The other values put the
      // embedding vectors in the cloud too, so a restored device never has to
      // pay for them again; the codec is the precision/bytes trade.
      vectors: ['f32', 'f16', 'i8'].includes(String(syncRaw.vectors ?? '')) ? String(syncRaw.vectors) : 'off',
      vectorsPerSegment: number(syncRaw.vectorsPerSegment, 40, 1, 400),
      remote: syncRaw.remote === 's3' ? 's3' : 'local',
      local: { dir: text(section(syncRaw.local).dir) },
      s3: {
        endpoint: text(section(syncRaw.s3).endpoint),
        bucket: text(section(syncRaw.s3).bucket),
        region: text(section(syncRaw.s3).region, 'us-east-1'),
        pathStyle: section(syncRaw.s3).pathStyle !== false,
        prefix: text(section(syncRaw.s3).prefix, 'v1'),
        accessKeyRef: text(section(syncRaw.s3).accessKeyRef),
        secretKeyRef: text(section(syncRaw.s3).secretKeyRef),
        caFile: text(section(syncRaw.s3).caFile),
      },
      // End-to-end encryption key (base64, 32 bytes). Shown in the settings page
      // on purpose: the same key has to be copied to every device.
      encryptKey: text(syncRaw.encryptKey),
    },
  }
}

/** Groups in the order the settings page renders them. */
export const GROUPS = [
  { id: 'recall' },
  { id: 'capture' },
  { id: 'extraction' },
  { id: 'scenes' },
  { id: 'persona' },
  { id: 'vector' },
  { id: 'storage' },
  { id: 'sync' },
  { id: 'advanced' },
]

/**
 * The field catalog. `live: false` means the value can be persisted and shown
 * but only takes effect after the plugin (and therefore dsh) restarts: a live
 * database handle, the host skill registry, and the resolved LLM route cannot
 * be swapped under a running plugin.
 *
 * `path` is the location inside the resolved config object.
 */
export const FIELDS = [
  // ── Recall: what gets injected before a turn ─────────────────────────────
  { key: 'recall.scope', path: ['scope'], group: 'recall', type: 'enum', options: ['project', 'global'], live: true },
  { key: 'recall.maxItems', path: ['maxItems'], group: 'recall', type: 'number', min: 1, max: 20, step: 1, live: true },
  { key: 'recall.maxChars', path: ['maxChars'], group: 'recall', type: 'number', min: 200, max: 8000, step: 50, live: true },
  { key: 'recall.minScore', path: ['minScore'], group: 'recall', type: 'number', min: 0, max: 1, step: 0.05, live: true },
  { key: 'recall.injectGlobalFacts', path: ['injectGlobalFacts'], group: 'recall', type: 'boolean', live: true },
  { key: 'recall.stableMaxChars', path: ['stableMaxChars'], group: 'recall', type: 'number', min: 300, max: 6000, step: 50, live: true },
  { key: 'core.enabled', path: ['core', 'enabled'], group: 'recall', type: 'boolean', live: true },
  { key: 'core.maxItems', path: ['core', 'maxItems'], group: 'recall', type: 'number', min: 1, max: 20, step: 1, live: true },
  { key: 'core.minPriority', path: ['core', 'minPriority'], group: 'recall', type: 'number', min: 0, max: 100, step: 5, live: true },

  // ── Capture: what gets written ───────────────────────────────────────────
  { key: 'capture', path: ['capture'], group: 'capture', type: 'boolean', live: true },
  { key: 'layers.l0', path: ['layers', 'l0'], group: 'capture', type: 'boolean', live: true },
  { key: 'layers.l1', path: ['layers', 'l1'], group: 'capture', type: 'boolean', live: true },
  { key: 'layers.l2', path: ['layers', 'l2'], group: 'capture', type: 'boolean', live: true },
  { key: 'layers.l3', path: ['layers', 'l3'], group: 'capture', type: 'boolean', live: true },

  // ── Extraction (L1) ──────────────────────────────────────────────────────
  { key: 'extraction.enabled', path: ['extraction', 'enabled'], group: 'extraction', type: 'boolean', live: true },
  { key: 'extraction.everyN', path: ['extraction', 'everyN'], group: 'extraction', type: 'number', min: 1, max: 100, step: 1, live: true },
  { key: 'extraction.idleMs', path: ['extraction', 'idleMs'], group: 'extraction', type: 'number', min: 1000, max: 3600000, step: 1000, live: true },
  { key: 'extraction.maxInputChars', path: ['extraction', 'maxInputChars'], group: 'extraction', type: 'number', min: 500, max: 60000, step: 500, live: true },
  { key: 'extraction.maxMemories', path: ['extraction', 'maxMemories'], group: 'extraction', type: 'number', min: 1, max: 50, step: 1, live: true },
  { key: 'extraction.maxAttempts', path: ['extraction', 'maxAttempts'], group: 'extraction', type: 'number', min: 1, max: 10, step: 1, live: true },
  { key: 'extraction.timeoutMs', path: ['extraction', 'timeoutMs'], group: 'extraction', type: 'number', min: 1000, max: 300000, step: 1000, live: true },
  { key: 'extraction.maxTokens', path: ['extraction', 'maxTokens'], group: 'extraction', type: 'number', min: 64, max: 8192, step: 64, live: true },
  { key: 'extraction.sweepOnStart', path: ['extraction', 'sweepOnStart'], group: 'extraction', type: 'boolean', live: true },
  { key: 'extraction.sweepSessions', path: ['extraction', 'sweepSessions'], group: 'extraction', type: 'number', min: 1, max: 200, step: 1, live: true },
  { key: 'extraction.sweepDelayMs', path: ['extraction', 'sweepDelayMs'], group: 'extraction', type: 'number', min: 1000, max: 120000, step: 1000, live: true },
  { key: 'extraction.sweepIntervalMs', path: ['extraction', 'sweepIntervalMs'], group: 'extraction', type: 'number', min: 0, max: 3600000, step: 30000, live: true },
  { key: 'extraction.sweepMinAgeMs', path: ['extraction', 'sweepMinAgeMs'], group: 'extraction', type: 'number', min: 0, max: 86400000, step: 60000, live: true },
  { key: 'extraction.provider', path: ['extraction', 'provider'], group: 'extraction', type: 'text', live: false },
  { key: 'extraction.model', path: ['extraction', 'model'], group: 'extraction', type: 'text', live: false },

  // ── Scenes (L2) ──────────────────────────────────────────────────────────
  { key: 'scenes.enabled', path: ['scenes', 'enabled'], group: 'scenes', type: 'boolean', live: true },
  { key: 'scenes.minFacts', path: ['scenes', 'minFacts'], group: 'scenes', type: 'number', min: 1, max: 20, step: 1, live: true },
  { key: 'scenes.maxScenes', path: ['scenes', 'maxScenes'], group: 'scenes', type: 'number', min: 1, max: 100, step: 1, live: true },
  { key: 'scenes.halfLifeDays', path: ['scenes', 'halfLifeDays'], group: 'scenes', type: 'number', min: 1, max: 365, step: 1, live: true },

  // ── Persona (L3) ─────────────────────────────────────────────────────────
  { key: 'persona.enabled', path: ['persona', 'enabled'], group: 'persona', type: 'boolean', live: true },
  { key: 'persona.triggerMode', path: ['persona', 'triggerMode'], group: 'persona', type: 'enum', options: ['current', 'jev', 'legacy'], live: true },
  { key: 'persona.defaultThreshold', path: ['persona', 'defaultThreshold'], group: 'persona', type: 'number', min: 1, max: 500, step: 1, live: true },
  { key: 'persona.jev.provider', path: ['persona', 'jev', 'provider'], group: 'persona', type: 'enum', options: ['llm', 'jev'], live: true },
  { key: 'persona.jev.endpoint', path: ['persona', 'jev', 'endpoint'], group: 'persona', type: 'text', live: true },
  { key: 'persona.jev.model', path: ['persona', 'jev', 'model'], group: 'persona', type: 'text', live: true },
  { key: 'persona.jev.apiKeyRef', path: ['persona', 'jev', 'apiKeyRef'], group: 'persona', type: 'text', live: true },
  { key: 'persona.jev.timeoutMs', path: ['persona', 'jev', 'timeoutMs'], group: 'persona', type: 'number', min: 100, max: 60000, step: 100, live: true },
  { key: 'persona.jev.diagnostics', path: ['persona', 'jev', 'diagnostics'], group: 'persona', type: 'enum', options: ['off', 'metadata', 'full'], live: true },
  { key: 'persona.global', path: ['persona', 'global'], group: 'persona', type: 'boolean', live: true },
  { key: 'persona.triggerEveryN', path: ['persona', 'triggerEveryN'], group: 'persona', type: 'number', min: 1, max: 100, step: 1, live: true },
  { key: 'persona.maxChars', path: ['persona', 'maxChars'], group: 'persona', type: 'number', min: 200, max: 8000, step: 50, live: true },
  { key: 'persona.targetChars', path: ['persona', 'targetChars'], group: 'persona', type: 'number', min: 120, max: 8000, step: 20, live: true },
  { key: 'persona.globalTargetChars', path: ['persona', 'globalTargetChars'], group: 'persona', type: 'number', min: 120, max: 8000, step: 20, live: true },
  { key: 'persona.personaMaxTokens', path: ['persona', 'personaMaxTokens'], group: 'persona', type: 'number', min: 400, max: 16000, step: 100, live: true },
  { key: 'persona.personaTimeoutMs', path: ['persona', 'personaTimeoutMs'], group: 'persona', type: 'number', min: 5000, max: 600000, step: 5000, live: true },
  { key: 'persona.personaReasoningEffort', path: ['persona', 'personaReasoningEffort'], group: 'persona', type: 'enum', options: ['', 'low', 'medium', 'high', 'max'], live: true },

  // ── Retrieval (vector model + lexical vectors) ───────────────────────────
  { key: 'vector.enabled', path: ['vector', 'enabled'], group: 'vector', type: 'boolean', live: true },
  // Which vector model to use: the built-in lexical hash (default) or a
  // configured OpenAI-compatible endpoint. Everything below `provider` is
  // ignored by the `hash` provider, which is what keeps "configure nothing"
  // byte-for-byte the old behaviour.
  { key: 'vector.provider', path: ['vector', 'provider'], group: 'vector', type: 'enum', options: ['hash', 'openai'], live: true },
  { key: 'vector.model', path: ['vector', 'model'], group: 'vector', type: 'text', live: true },
  { key: 'vector.dims', path: ['vector', 'dims'], group: 'vector', type: 'number', min: 0, max: 4096, step: 1, live: true },
  { key: 'vector.baseUrl', path: ['vector', 'baseUrl'], group: 'vector', type: 'text', live: true },
  { key: 'vector.apiKeyRef', path: ['vector', 'apiKeyRef'], group: 'vector', type: 'text', live: true },
  { key: 'vector.minCosine', path: ['vector', 'minCosine'], group: 'vector', type: 'number', min: 0, max: 1, step: 0.05, live: true },
  { key: 'vector.timeoutMs', path: ['vector', 'timeoutMs'], group: 'vector', type: 'number', min: 500, max: 60000, step: 500, live: true },
  { key: 'vector.weight', path: ['vector', 'weight'], group: 'vector', type: 'number', min: 0, max: 1, step: 0.05, live: true },
  { key: 'vector.scanLimit', path: ['vector', 'scanLimit'], group: 'vector', type: 'number', min: 0, max: 5000, step: 100, live: true },
  { key: 'vector.prefilter', path: ['vector', 'prefilter'], group: 'vector', type: 'boolean', live: true },
  { key: 'vector.featureLimit', path: ['vector', 'featureLimit'], group: 'vector', type: 'number', min: 16, max: 96, step: 16, live: true },

  // ── Storage (restart-only) ───────────────────────────────────────────────
  { key: 'storage.dbPath', path: ['dbPath'], group: 'storage', type: 'text', live: false },

  // ── Cloud sync ───────────────────────────────────────────────────────────
  { key: 'sync.enabled', path: ['sync', 'enabled'], group: 'sync', type: 'boolean', live: true },
  { key: 'sync.mode', path: ['sync', 'mode'], group: 'sync', type: 'enum', options: ['manual', 'auto'], live: true },
  { key: 'sync.everySeconds', path: ['sync', 'everySeconds'], group: 'sync', type: 'number', min: 10, max: 3600, step: 10, live: true },
  { key: 'sync.workspace', path: ['sync', 'workspace'], group: 'sync', type: 'text', live: false },
  { key: 'sync.remote', path: ['sync', 'remote'], group: 'sync', type: 'enum', options: ['local', 's3'], live: false },
  { key: 'sync.local.dir', path: ['sync', 'local', 'dir'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.endpoint', path: ['sync', 's3', 'endpoint'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.bucket', path: ['sync', 's3', 'bucket'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.region', path: ['sync', 's3', 'region'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.pathStyle', path: ['sync', 's3', 'pathStyle'], group: 'sync', type: 'boolean', live: false },
  { key: 'sync.s3.prefix', path: ['sync', 's3', 'prefix'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.accessKeyRef', path: ['sync', 's3', 'accessKeyRef'], group: 'sync', type: 'text', live: false },
  { key: 'sync.s3.secretKeyRef', path: ['sync', 's3', 'secretKeyRef'], group: 'sync', type: 'text', live: false },
  { key: 'sync.encrypt', path: ['sync', 'encrypt'], group: 'sync', type: 'boolean', live: false },
  { key: 'sync.vectors', path: ['sync', 'vectors'], group: 'sync', type: 'enum', options: ['off', 'f32', 'f16', 'i8'], live: false },
  { key: 'sync.vectorsPerSegment', path: ['sync', 'vectorsPerSegment'], group: 'sync', type: 'number', min: 1, max: 400, step: 1, live: false },
  { key: 'sync.encryptKey', path: ['sync', 'encryptKey'], group: 'sync', type: 'text', live: false },

  // ── Advanced ─────────────────────────────────────────────────────────────
  { key: 'debug', path: ['debug'], group: 'advanced', type: 'boolean', live: true },
  { key: 'skills.enabled', path: ['skills', 'enabled'], group: 'advanced', type: 'boolean', live: false },
  { key: 'skills.dir', path: ['skills', 'dir'], group: 'advanced', type: 'text', live: false },
]

/** Field definitions by key. */
const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]))

/** Defaults, derived from the same normalizer the plugin boots with. */
const DEFAULTS = resolveConfig({})

/**
 * @param {string} key
 * @returns {(typeof FIELDS)[number] | undefined}
 */
export function fieldByKey(key) {
  return FIELD_BY_KEY.get(key)
}

/**
 * Read one nested value.
 * @param {Record<string, any>} root
 * @param {string[]} path
 * @returns {any}
 */
export function readPath(root, path) {
  let value = root
  for (const part of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = value[part]
  }
  return value
}

/**
 * Does the path exist (even with an explicit `undefined` value)?
 * @param {Record<string, any>} root
 * @param {string[]} path
 */
export function hasPath(root, path) {
  let value = root
  for (const part of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return false
    value = value[part]
  }
  return true
}

/**
 * Write one nested value, keeping the identity of every intermediate object:
 * live features hold references to `config.extraction` etc., so replacing a
 * section object would silently detach them from later updates.
 * @param {Record<string, any>} root
 * @param {string[]} path
 * @param {any} value
 */
export function writePath(root, path, value) {
  let target = root
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index]
    const next = target[part]
    if (next === null || typeof next !== 'object') target[part] = {}
    target = target[part]
  }
  target[path[path.length - 1]] = value
}

/**
 * Delete one nested value and prune objects left empty by the deletion.
 * @param {Record<string, any>} root
 * @param {string[]} path
 * @returns {boolean} whether something was removed
 */
export function deletePath(root, path) {
  /** @type {Array<{ parent: Record<string, any>, part: string }>} */
  const trail = []
  let target = root
  for (let index = 0; index < path.length - 1; index++) {
    const part = path[index]
    const next = target?.[part]
    if (next === null || typeof next !== 'object') return false
    trail.push({ parent: target, part })
    target = next
  }
  const last = path[path.length - 1]
  if (target === null || typeof target !== 'object' || !Object.hasOwn(target, last)) return false
  delete target[last]
  for (let index = trail.length - 1; index >= 0; index--) {
    const { parent, part } = trail[index]
    const child = parent[part]
    if (child && typeof child === 'object' && Object.keys(child).length === 0) delete parent[part]
  }
  return true
}

/** Deep-copy plain objects/arrays; every other value is returned as-is. */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map((item) => clonePlain(item))
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = clonePlain(item)
  return out
}

/**
 * Deep-merge plain objects. `patch` wins; arrays and scalars replace wholesale.
 * Inputs are never mutated.
 * @param {Record<string, any>|undefined} base
 * @param {Record<string, any>|undefined} patch
 * @returns {Record<string, any>}
 */
export function deepMerge(base, patch) {
  if (base === undefined || base === null) return clonePlain(patch ?? {})
  if (patch === undefined || patch === null) return clonePlain(base)
  if (typeof base !== 'object' || Array.isArray(base) || typeof patch !== 'object' || Array.isArray(patch)) {
    return clonePlain(patch)
  }
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(base)) out[key] = clonePlain(value)
  for (const [key, value] of Object.entries(patch)) {
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
    const baseValue = out[key]
    const baseIsObject = baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)
    out[key] = isObject && baseIsObject ? deepMerge(baseValue, value) : clonePlain(value)
  }
  return out
}

/**
 * Merge the loader row config with the settings page layer (settings win).
 * @param {unknown} loaderRaw
 * @param {unknown} storedSettings
 * @returns {Record<string, any>}
 */
export function mergeRaw(loaderRaw, storedSettings) {
  const loader = loaderRaw && typeof loaderRaw === 'object' && !Array.isArray(loaderRaw) ? loaderRaw : {}
  const stored = storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings) ? storedSettings : {}
  return deepMerge(loader, stored)
}

/** Where each field's effective value comes from. */
export const SOURCE = { default: 'default', config: 'config', settings: 'settings' }

/**
 * @param {Record<string, any>} loaderRaw
 * @param {Record<string, any>} storedSettings
 * @returns {Record<string, 'default'|'config'|'settings'>}
 */
export function collectSources(loaderRaw, storedSettings) {
  /** @type {Record<string, string>} */
  const sources = {}
  for (const field of FIELDS) {
    if (hasPath(storedSettings ?? {}, field.path) && readPath(storedSettings, field.path) !== undefined) {
      sources[field.key] = SOURCE.settings
    } else if (hasPath(loaderRaw ?? {}, field.path) && readPath(loaderRaw, field.path) !== undefined) {
      sources[field.key] = SOURCE.config
    } else {
      sources[field.key] = SOURCE.default
    }
  }
  return sources
}

/** Format a number for an error message. */
function describeRange(field) {
  if (field.type === 'number') {
    const step = field.step !== undefined && field.step !== 1 ? ` step ${field.step}` : ''
    return `expected number ${field.min}..${field.max}${step}`
  }
  if (field.type === 'enum') return `expected one of ${field.options.map((option) => JSON.stringify(option)).join(', ')}`
  if (field.type === 'boolean') return 'expected boolean'
  return 'expected string'
}

/**
 * Validate one patch value for its field, normalizing numbers (clamped) and
 * trimming text.
 * @param {(typeof FIELDS)[number]} field
 * @param {unknown} value
 * @returns {{ ok: true, value: any } | { ok: false, message: string }}
 */
export function validateField(field, value) {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, message: describeRange(field) }
    case 'number': {
      if (value === null || value === '' || typeof value === 'boolean') return { ok: false, message: describeRange(field) }
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) return { ok: false, message: describeRange(field) }
      const clamped = Math.min(field.max, Math.max(field.min, numeric))
      // Integer fields (step 1) round: a fractional hit count would reach
      // SQLite LIMIT and the scheduler's threshold arithmetic as a float.
      return { ok: true, value: field.step === 1 ? Math.round(clamped) : clamped }
    }
    case 'enum': {
      if (typeof value !== 'string' || !field.options.includes(value)) return { ok: false, message: describeRange(field) }
      return { ok: true, value }
    }
    default: {
      if (typeof value !== 'string') return { ok: false, message: describeRange(field) }
      const text = value.trim()
      if (text.length > 500) return { ok: false, message: 'expected at most 500 characters' }
      return { ok: true, value: text }
    }
  }
}

/**
 * Validate a flat patch `{ key: value }`.
 * @param {unknown} patch
 * @returns {{ ok: boolean, errors: Array<{ key: string, message: string }>, flat: Record<string, any> }}
 */
export function validatePatch(patch) {
  if (patch === undefined || patch === null) return { ok: true, errors: [], flat: {} }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ key: '', message: 'patch must be an object' }], flat: {} }
  }
  /** @type {Record<string, any>} */
  const flat = {}
  /** @type {Array<{ key: string, message: string }>} */
  const errors = []
  for (const [key, value] of Object.entries(patch)) {
    const field = fieldByKey(key)
    if (field === undefined) {
      errors.push({ key, message: 'unknown setting' })
      continue
    }
    const result = validateField(field, value)
    if (result.ok !== true) errors.push({ key, message: result.message })
    else flat[key] = result.value
  }
  return { ok: errors.length === 0, errors, flat }
}

/**
 * Cross-field check for the optional `jev` judgment backend.
 *
 * A remote provider missing an endpoint, model or key would never fire, and the
 * user would only see "the gate never decides". Upstream refuses to start in
 * that shape; here the settings save does, which is the earliest moment the
 * plugin can still say no.
 *
 * @param {{ triggerMode?: string, jev?: Record<string, any> }} persona
 * @returns {string|null} an error message, or null when usable
 */
export function validateJevConfig(persona) {
  if (persona?.triggerMode !== 'jev') return null
  const jev = persona.jev ?? {}
  if (jev.provider !== 'jev') return null
  const missing = []
  const endpoint = String(jev.endpoint ?? '').trim()
  if (endpoint === '') missing.push('persona.jev.endpoint')
  if (String(jev.model ?? '').trim() === '') missing.push('persona.jev.model')
  if (String(jev.apiKeyRef ?? '').trim() === '') missing.push('persona.jev.apiKeyRef')
  if (missing.length > 0) {
    return `${missing.join('、')} 必须填写：triggerMode=jev 且 provider=jev 时要接外部判定服务`
  }
  if (parseDecisionEndpoint(endpoint) === null) {
    return 'persona.jev.endpoint 必须是 https 地址（仅回环地址允许 http，便于本地 mock）'
  }
  return null
}

/**
 * Validate an `unset` list (keys to remove from the settings layer, reverting
 * that field to the loader config / default).
 * @param {unknown} unset
 * @returns {{ ok: boolean, errors: Array<{ key: string, message: string }>, keys: string[] }}
 */
export function validateUnset(unset) {
  if (unset === undefined || unset === null) return { ok: true, errors: [], keys: [] }
  if (!Array.isArray(unset)) return { ok: false, errors: [{ key: '', message: 'unset must be an array of keys' }], keys: [] }
  /** @type {Array<{ key: string, message: string }>} */
  const errors = []
  /** @type {string[]} */
  const keys = []
  for (const key of unset) {
    if (typeof key !== 'string' || fieldByKey(key) === undefined) {
      errors.push({ key: String(key), message: 'unknown setting' })
      continue
    }
    keys.push(key)
  }
  return { ok: errors.length === 0, errors, keys }
}

/**
 * Turn a flat `{ key: value }` map into the nested object shape stored in
 * settings.json.
 * @param {Record<string, any>} flat
 * @returns {Record<string, any>}
 */
export function toNested(flat) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(flat)) {
    const field = fieldByKey(key)
    if (field !== undefined) writePath(out, field.path, value)
  }
  return out
}

/**
 * Build the settings page's field list for one group.
 *
 * `value` is the merged/persisted value (what the plugin will run with);
 * `active` is the value the running instance actually uses and appears only
 * for fields that cannot be applied live.
 *
 * @param {string} groupId
 * @param {Record<string, any>} effective - resolveConfig(mergeRaw(...))
 * @param {Record<string, any>} active - the live config object
 * @param {Record<string, 'default'|'config'|'settings'>} sources
 * @returns {Array<Record<string, any>>}
 */
export function buildGroupFields(groupId, effective, active, sources) {
  return FIELDS.filter((field) => field.group === groupId).map((field) => {
    /** @type {Record<string, any>} */
    const state = {
      key: field.key,
      type: field.type,
      live: field.live,
      default: readPath(DEFAULTS, field.path),
      value: readPath(effective, field.path),
      source: sources[field.key] ?? SOURCE.default,
    }
    if (field.type === 'number') {
      state.min = field.min
      state.max = field.max
      state.step = field.step
    }
    if (field.type === 'enum') state.options = [...field.options]
    if (!field.live) state.active = readPath(active, field.path)
    return state
  })
}

/**
 * All groups with their fields, in page order.
 * @param {Record<string, any>} effective
 * @param {Record<string, any>} active
 * @param {Record<string, any>} loaderRaw
 * @param {Record<string, any>} storedSettings
 */
export function buildGroups(effective, active, loaderRaw, storedSettings) {
  const sources = collectSources(loaderRaw, storedSettings)
  return GROUPS.map((group) => ({ id: group.id, fields: buildGroupFields(group.id, effective, active, sources) })).filter(
    (group) => group.fields.length > 0,
  )
}

/**
 * Apply the live-able part of a new config to the running one, in place.
 *
 * Every feature closure reads the same `config` object, so assigning here is
 * what makes "save" take effect without a restart. Values that cannot be
 * swapped under a running plugin are reported instead of applied; the caller
 * persists them for the next boot.
 *
 * @param {Record<string, any>} current - live config, mutated
 * @param {Record<string, any>} next - resolveConfig of the merged config
 * @returns {{ applied: string[], restartRequired: string[] }}
 */
export function applyLiveConfig(current, next) {
  const applied = []
  const restartRequired = []
  for (const field of FIELDS) {
    const nextValue = readPath(next, field.path)
    const currentValue = readPath(current, field.path)
    const changed = JSON.stringify(nextValue) !== JSON.stringify(currentValue)
    if (!field.live) {
      if (changed) restartRequired.push(field.key)
      continue
    }
    if (changed) {
      writePath(current, field.path, nextValue)
      applied.push(field.key)
    }
  }
  return { applied, restartRequired }
}

/** The default value of every field, for tests and diagnostics. */
export function defaults() {
  /** @type {Record<string, any>} */
  const out = {}
  for (const field of FIELDS) out[field.key] = readPath(DEFAULTS, field.path)
  return out
}
