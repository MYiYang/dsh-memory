/**
 * Health check for the configured vector model.
 *
 * Answers four questions in one run, without touching the plugin's runtime:
 *
 *   1. which endpoint the stored `baseUrl` actually resolves to (and whether it
 *      is reachable at all);
 *   2. which width the model really returns, vs. `vector.dims`;
 *   3. whether the similarity scale is sane (related pair well above
 *      `vector.minCosine`, unrelated pairs well below);
 *   4. how many active memories still need backfilling under this model's tag.
 *
 * Reads the same files the plugin reads, so it reports what the next boot will
 * use — not what a running process happens to hold in memory.
 *
 *   node scripts/check-embedding.mjs
 *
 * The API key is never printed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEmbeddingClient, normalizeEndpoint, resolveDims } from '../src/embedding.js'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const settingsPath = join(home, 'memory', 'settings.json')
const dbPath = join(home, 'memory', 'memory.db')

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
const vector = settings.settings?.vector ?? {}
const mask = (value) => {
  const text = String(value ?? '')
  return text === '' ? '(none)' : `${text.slice(0, 4)}…${text.slice(-4)} (${text.length} chars)`
}

console.log('config   :', {
  provider: vector.provider ?? 'hash',
  model: vector.model ?? '',
  dims: vector.dims ?? 0,
  baseUrl: vector.baseUrl ?? '',
  apiKeyRef: mask(vector.apiKeyRef),
  minCosine: vector.minCosine ?? 0.5,
})
console.log('endpoint :', normalizeEndpoint(vector.baseUrl))
console.log('dims     :', resolveDims(vector.model, vector.dims), '(null = will probe)')

const client = createEmbeddingClient(
  { ...vector, timeoutMs: 20_000 },
  { metaGet: () => undefined, metaSet: () => {}, log: (level, message) => console.log(`  [${level}] ${message}`) },
)

// The first HTTPS call in a fresh process can lose ~11s to a cold DNS lookup
// (measured: 11066ms, then 1ms once the OS caches it). That is longer than
// several clients' connect timeout, so one network-looking failure proves
// nothing — retry once before blaming the configuration.
const probeWithRetry = async () => {
  const attempts = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now()
    const result = await client.probe()
    const ms = Date.now() - started
    attempts.push({ attempt, ms, ...result })
    if (result.ok || !/fetch failed|timeout|abort|EAI_|ENOTFOUND|ECONN/i.test(String(result.error))) break
    console.log(`  attempt ${attempt} failed after ${ms}ms (${result.error}); retrying — a cold DNS lookup is the usual suspect`)
  }
  return attempts
}

const attempts = await probeWithRetry()
const probed = attempts[attempts.length - 1]
console.log('\nprobe    :', { ok: probed.ok, dims: probed.dims, error: probed.error, ms: probed.ms })
if (!probed.ok) {
  const error = String(probed.error ?? '')
  const advice = /dimension-mismatch/.test(error)
    ? `the model returns a width the config contradicts — set vector.dims to 0 (auto) or to the real width, never a guess`
    : /HTTP 404/.test(error)
      ? 'wrong path: baseUrl must end at /v1 (or /embeddings); the code appends /embeddings itself'
      : /HTTP 40[13]/.test(error)
        ? 'the key was rejected — check vector.apiKeyRef'
        : /fetch failed|timeout|abort|EAI_|ECONN/i.test(error)
          ? 'no answer from the host after a retry — network, DNS or egress proxy'
          : 'check baseUrl, the key and the model id'
  console.log(`\nFAILED — ${advice}`)
  process.exit(1)
}

const probes = [
  ['我偏好用 PowerShell 而不是 cmd', '同义改写：命令行偏好 PowerShell'],
  ['我偏好用 PowerShell 而不是 cmd', '无关：今天下午要下雨，记得带伞'],
  ['我偏好用 PowerShell 而不是 cmd', '无关：这家店的牛肉面分量很足'],
]
const texts = [...new Set(probes.flat())]
const embedded = await client.embed(texts)
if (!embedded.ok) {
  console.log('\nembed    : FAIL', embedded.error)
  process.exit(1)
}
const vectorOf = (text) => embedded.vectors[texts.indexOf(text)]
const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)
const floor = Number(vector.minCosine ?? 0.5)

console.log(`similarity (minCosine ${floor}):`)
for (const [left, right] of probes) {
  const score = cosine(vectorOf(left), vectorOf(right))
  console.log(`  ${score.toFixed(4)}  ${score >= floor ? 'in ' : 'out'}  ${right}`)
}

const tag = client.tag
let pending = 'n/a'
try {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory m
       WHERE m.superseded_by IS NULL
         AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?)`,
    )
    .get(tag)
  pending = row?.n ?? 'n/a'
  db.close()
} catch (error) {
  pending = `cannot read db: ${error instanceof Error ? error.message : String(error)}`
}
console.log(`\ntag      : ${tag}`)
console.log(`backfill : ${pending} active memory row(s) still missing a vector (256 rows/tick, 32 rows/request)`)
