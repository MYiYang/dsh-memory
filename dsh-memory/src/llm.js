/**
 * Thin, failure-isolated wrapper around the host `llm` service.
 *
 * The plugin never owns model routing: it asks `agentDefaultModel` for the
 * current selection (or uses explicit config) and streams one completion.
 * Every failure becomes `{ ok: false }` — extraction degrades to "no memory",
 * never to a broken conversation.
 *
 * @module dsh-memory/llm
 */

/**
 * Safely read an optional Cordis service (`ctx.get` may throw in odd scopes).
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function safeService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the provider/model to use for extraction.
 * @param {any} ctx
 * @param {{ provider?: string, model?: string }} [config]
 * @returns {{ provider: string|null, model: string|null, selection: any }}
 */
export function resolveModel(ctx, config = {}) {
  let selection
  try {
    selection = safeService(ctx, 'agentDefaultModel')?.currentSelection?.()
  } catch {
    selection = undefined
  }
  const provider = String(config.provider || selection?.provider || '').trim() || null
  const model = String(config.model || selection?.model || '').trim() || null
  return { provider, model, selection }
}

/**
 * Build the client. `available` is false when the host has no llm service or
 * no provider/model can be resolved; callers then keep the plugin in
 * extraction-off mode instead of retrying every turn.
 *
 * @param {any} ctx
 * @param {{ provider?: string, model?: string, timeoutMs?: number, maxTokens?: number }} [config]
 * @param {(level: string, message: string) => void} [log]
 */
export function createLlmClient(ctx, config = {}, log = () => {}) {
  const service = safeService(ctx, 'llm')
  const { provider, model } = resolveModel(ctx, config)
  const available = Boolean(service && typeof service.stream === 'function' && provider && model)
  if (!available) {
    const reason = !service
      ? 'no llm service'
      : !provider || !model
        ? 'no provider/model selected'
        : 'llm service has no stream()'
    log('warn', `extraction disabled: ${reason}`)
  }

  /**
   * One completion, collecting text and usage from the chunk stream.
   *
   * @param {{
   *   system: string,
   *   user: string,
   *   maxTokens?: number,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   *   sessionId?: string,
   * }} request
   * @returns {Promise<{
   *   ok: boolean, text: string, reason: string|null,
   *   usage: { inputTokens: number, outputTokens: number }|null,
   *   error?: string,
   * }>}
   */
  async function complete(request) {
    if (!available) return { ok: false, text: '', reason: null, usage: null, error: 'llm-unavailable' }
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? config.timeoutMs ?? 60_000)
    const maxTokens = Math.max(64, request.maxTokens ?? config.maxTokens ?? 1_200)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const external = request.signal
    const onAbort = () => controller.abort()
    if (external?.aborted === true) controller.abort()
    external?.addEventListener?.('abort', onAbort, { once: true })

    let text = ''
    let finish = null
    let error = null
    let usage = null
    try {
      const options = {
        provider,
        model,
        system: String(request.system ?? ''),
        messages: [{ role: 'user', content: [{ type: 'text', text: String(request.user ?? '') }] }],
        maxTokens,
        signal: controller.signal,
      }
      if (request.sessionId !== undefined) options.sessionId = request.sessionId
      const stream = service.stream(options)
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = chunk.reason?.kind ?? null
          if (chunk.reason?.kind === 'error') error = chunk.reason.failure?.message ?? 'model error'
        }
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    } finally {
      clearTimeout(timer)
      external?.removeEventListener?.('abort', onAbort)
    }

    if (error !== null) return { ok: false, text, reason: finish, usage, error }
    if (finish === 'aborted') return { ok: false, text, reason: finish, usage, error: 'aborted' }
    return { ok: text.trim() !== '', text, reason: finish, usage }
  }

  return {
    available,
    provider,
    model,
    complete,
    describe() {
      return { available, provider, model }
    },
  }
}
