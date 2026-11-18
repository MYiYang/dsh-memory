/**
 * Decision providers: one state string plus choice questions in, the chosen
 * option per question out.
 *
 * The seam mirrors the upstream memory-core decision layer
 * (`MemoryCore/src/core/decision/types.ts`): a business layer builds the state
 * and the criteria, a provider does the judging, and the business layer alone
 * maps the label back to an action. That split is what makes "use JEV or not"
 * a configuration question instead of a code fork.
 *
 * Two providers ship in the box:
 *   - `llm`  — ask the host model, one completion per question. No endpoint to
 *              configure; this is the default when the gate is switched on.
 *   - `jev`  — POST the upstream System One wire format to a judgment service
 *              (`{model, state, questions:{<qid>:{type,instructions,criteria}}}`
 *              → `{answers:{<qid>:{choice,...}}}`). Requires endpoint + model +
 *              key, and refuses plain http except for loopback tests.
 *
 * Contract rules (deliberately the same as upstream):
 *   - a failure always throws, never a fabricated answer;
 *   - no retries here — the online budget belongs to the caller;
 *   - the caller must re-validate the label against its own criteria;
 *   - state and credentials never reach the logs from this module.
 *
 * @module dsh-memory/decision
 */
import { parseJsonLoose } from './extract.js'

/** Provider type names share the upstream shape: lower-case, short. */
export const DECISION_PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** Why a decision call failed. Kept as data so callers can log a stable code. */
export const DECISION_FAILURE_REASONS = Object.freeze([
  'invalid_config',
  'fetch_failed',
  'http_error',
  'non_json',
  'invalid_response',
  'missing_answer',
  'invalid_choice',
  'timeout',
])

export class DecisionProviderError extends Error {
  /**
   * @param {string} reason one of {@link DECISION_FAILURE_REASONS}
   * @param {string} message
   * @param {number} [status] HTTP status when the failure came from one
   */
  constructor(reason, message, status) {
    super(message)
    this.name = 'DecisionProviderError'
    this.reason = reason
    this.status = status
  }
}

/** name → factory(params, deps) → provider */
const factories = new Map()

/**
 * Register or replace a provider. Unknown names fail loudly: a typo in the
 * settings must not silently disable the gate.
 *
 * @param {string} name
 * @param {(params: Record<string, any>, deps: Record<string, any>) => Record<string, any>} factory
 * @param {{ override?: boolean }} [options]
 */
export function registerDecisionProvider(name, factory, options = {}) {
  if (!DECISION_PROVIDER_NAME_RE.test(String(name ?? ''))) {
    throw new Error(`[decision] invalid provider name: ${JSON.stringify(name)}`)
  }
  if (typeof factory !== 'function') throw new Error('[decision] factory must be a function')
  if (factories.has(name) && options.override !== true) {
    throw new Error(`[decision] provider already registered: ${name}`)
  }
  factories.set(name, factory)
}

/** @returns {string[]} registered provider names, sorted */
export function listDecisionProviders() {
  return [...factories.keys()].sort()
}

/** @param {string} name */
export function hasDecisionProvider(name) {
  return factories.has(String(name ?? ''))
}

/** Test helper: drop runtime registrations and restore the built-ins. */
export function resetDecisionProviders() {
  factories.clear()
  factories.set('llm', (params, deps) => createLlmDecisionProvider(params, deps))
  factories.set('jev', (params, deps) => createHttpDecisionProvider(params, deps))
}

/**
 * Build a provider; an unregistered name throws immediately (a config error
 * should surface at the earliest possible moment, as upstream does).
 *
 * @param {string} name
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [deps]
 */
export function createDecisionProvider(name, params = {}, deps = {}) {
  const factory = factories.get(String(name ?? ''))
  if (factory === undefined) {
    throw new DecisionProviderError(
      'invalid_config',
      `unknown decision provider "${name}"; available: ${listDecisionProviders().join(', ') || '(none)'}`,
    )
  }
  return factory(params, deps)
}

/**
 * Render one choice question as a model prompt. Kept next to the parser so the
 * two can never drift apart.
 *
 * @param {string} state
 * @param {{ id: string, instructions: string, criteria: Record<string, string|null> }} question
 * @returns {{ system: string, user: string }}
 */
export function buildChoicePrompt(state, question) {
  const criteria = Object.entries(question.criteria ?? {})
    .map(([label, description]) => (description ? `- ${label}：${description}` : `- ${label}`))
    .join('\n')
  return {
    system: [
      question.instructions,
      '',
      '可选标签（必须原样返回其中一个）：',
      criteria,
      '只输出 JSON，不要解释：{"choice":"<标签>"}',
    ].join('\n'),
    user: String(state ?? ''),
  }
}

/**
 * Parse a model answer into a validated choice.
 *
 * @param {string} text
 * @param {{ id: string, criteria: Record<string, string|null> }} question
 * @returns {{ id: string, choice: string, confidence?: number }}
 */
export function parseChoiceResponse(text, question) {
  const raw = String(text ?? '')
  const value = parseJsonLoose(raw)
  const criteria = question?.criteria ?? {}
  const allowed = (candidate) => Object.prototype.hasOwnProperty.call(criteria, candidate)
  let choice = value !== null && typeof value === 'object' && typeof value.choice === 'string' ? value.choice.trim() : ''
  if (!allowed(choice)) {
    // `parseJsonLoose` keeps the *first* JSON object, and a model that echoes the
    // answer format before answering would then look like a wrong label. Fall
    // back to the last choice literal in the text, which is the actual answer.
    const found = [...raw.matchAll(/"choice"\s*:\s*"([^"]*)"/g)]
      .map((match) => String(match[1] ?? '').trim())
      .filter((candidate) => allowed(candidate))
    choice = found.length > 0 ? found[found.length - 1] : choice
  }
  if (choice === '') throw new DecisionProviderError('missing_answer', 'response missing "choice"')
  if (!allowed(choice)) {
    throw new DecisionProviderError('invalid_choice', `choice outside the allowed labels: ${choice}`)
  }
  const confidence = value !== null && typeof value === 'object' && typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? value.confidence
    : undefined
  return confidence === undefined ? { id: question.id, choice } : { id: question.id, choice, confidence }
}

/**
 * Local provider: ask the host model. `deps.llm` is the plugin's LLM client
 * (`src/llm.js`), so no endpoint, model or key has to be configured.
 *
 * @param {{ timeoutMs?: number }} params
 * @param {{ llm?: any }} deps
 */
export function createLlmDecisionProvider(params = {}, deps = {}) {
  const llm = deps.llm ?? params.llm
  const usable = Boolean(llm !== undefined && llm !== null && llm.available !== false && typeof llm.complete === 'function')
  const timeoutMs = positive(params.timeoutMs, 30_000)
  return {
    name: 'llm',
    model: String(llm?.model ?? ''),
    maxChoiceOptions: 32,
    isUsable: () => usable,
    async askChoices(state, questions, options = {}) {
      if (!usable) {
        throw new DecisionProviderError('invalid_config', 'no llm client available for the decision provider')
      }
      const answers = new Map()
      for (const question of questions) {
        const prompt = buildChoicePrompt(state, question)
        const response = await llm.complete({
          system: prompt.system,
          user: prompt.user,
          maxTokens: Math.max(64, options.maxTokens ?? 400),
          timeoutMs: options.timeoutMs ?? timeoutMs,
          signal: options.signal,
          sessionId: options.sessionId,
          purpose: 'compaction',
        })
        if (response?.ok !== true) {
          const reason = response?.reason === 'aborted' ? 'timeout' : 'fetch_failed'
          throw new DecisionProviderError(reason, String(response?.error ?? 'llm call failed'))
        }
        const answer = parseChoiceResponse(response.text, question)
        answers.set(question.id, response?.usage ? { ...answer, usage: response.usage } : answer)
      }
      return answers
    },
  }
}

/**
 * Is this host allowed over plain http? Loopback only, so a local mock can be
 * exercised without a TLS terminator (same exception upstream makes).
 * @param {string} hostname
 */
export function isLoopbackHost(hostname) {
  return /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(String(hostname ?? '').toLowerCase())
}

/**
 * Validate an endpoint URL for the remote provider.
 * @param {unknown} raw
 * @returns {URL|null}
 */
export function parseDecisionEndpoint(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url
  return null
}

/**
 * Remote provider in the upstream System One wire format.
 *
 * `deps.fetcher` exists so tests can observe the request without a network.
 *
 * @param {{ endpoint?: string, apiKey?: string, model?: string, timeoutMs?: number }} params
 * @param {{ fetcher?: typeof fetch }} deps
 */
export function createHttpDecisionProvider(params = {}, deps = {}) {
  const endpoint = parseDecisionEndpoint(params.endpoint)
  const apiKey = String(params.apiKey ?? '').trim()
  const model = String(params.model ?? '').trim()
  const timeoutMs = positive(params.timeoutMs, 3_000)
  const fetcher = deps.fetcher ?? globalThis.fetch
  const usable = endpoint !== null && apiKey !== '' && model !== '' && typeof fetcher === 'function'
  const unusableReason = endpoint === null
    ? 'persona.jev.endpoint must be an https URL (plain http is allowed for loopback only)'
    : apiKey === ''
      ? 'persona.jev.apiKeyRef must resolve to a key'
      : model === ''
        ? 'persona.jev.model is required'
        : 'no fetch implementation'
  return {
    name: 'jev',
    model,
    maxChoiceOptions: 255,
    isUsable: () => usable,
    async askChoices(state, questions, options = {}) {
      if (!usable) throw new DecisionProviderError('invalid_config', unusableReason)
      /** @type {Record<string, unknown>} */
      const questionsPayload = {}
      for (const question of questions) {
        questionsPayload[question.id] = {
          type: 'choice',
          instructions: question.instructions,
          criteria: question.criteria,
        }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), positive(options.timeoutMs, timeoutMs))
      const external = options.signal
      if (external?.aborted === true) controller.abort()
      const onAbort = () => controller.abort()
      external?.addEventListener?.('abort', onAbort, { once: true })
      let response
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, state, questions: questionsPayload }),
          signal: controller.signal,
        })
      } catch (error) {
        const aborted = controller.signal.aborted === true
        throw new DecisionProviderError(aborted ? 'timeout' : 'fetch_failed', error instanceof Error ? error.message : String(error))
      } finally {
        clearTimeout(timer)
        external?.removeEventListener?.('abort', onAbort)
      }
      const raw = await response.text().catch(() => '')
      if (response.ok !== true) {
        throw new DecisionProviderError('http_error', `http ${response.status}`, response.status)
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new DecisionProviderError('non_json', 'decision response is not JSON')
      }
      const answersPayload = parsed !== null && typeof parsed === 'object' ? parsed.answers : undefined
      if (answersPayload === null || typeof answersPayload !== 'object') {
        throw new DecisionProviderError('invalid_response', 'decision response has no answers object')
      }
      const answers = new Map()
      for (const question of questions) {
        const entry = answersPayload[question.id]
        const choice = entry !== null && typeof entry === 'object' && typeof entry.choice === 'string' ? entry.choice.trim() : ''
        if (choice === '') throw new DecisionProviderError('missing_answer', `decision response missing answers.${question.id}.choice`)
        if (!Object.prototype.hasOwnProperty.call(question.criteria ?? {}, choice)) {
          throw new DecisionProviderError('invalid_choice', `choice outside the allowed labels: ${choice}`)
        }
        answers.set(question.id, {
          id: question.id,
          choice,
          ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
          ...(entry.probabilities !== null && typeof entry.probabilities === 'object' ? { probabilities: entry.probabilities } : {}),
        })
      }
      return answers
    },
  }
}

/** Coerce a positive number of milliseconds. */
function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

resetDecisionProviders()
