/**
 * Local lexical vectors: feature hashing over character n-grams and word
 * tokens, no model, no network, no native dependency.
 *
 * What this is (and is not):
 *   - It encodes *lexical* overlap (shared character n-grams / words), with
 *     sublinear term frequency and signed hashing to reduce collision bias.
 *   - It does not understand synonyms the way a trained embedding model does
 *     ("构建" vs "编译" stay different). It exists to complement FTS, not to
 *     replace a semantic embedding service.
 *
 * The vector is L2-normalized, so cosine similarity is a dot product.
 * Dimensions are fixed at 384 (a multiple of 8, ~1.5 KB per row as Float32).
 *
 * @module dsh-memory/vector
 */

/** Vector width; changing it requires a backfill (the model tag changes). */
export const VECTOR_DIMS = 384

/** Stored alongside every vector so stale vectors are detected. */
export const VECTOR_MODEL = `hash-ngram-v1-${VECTOR_DIMS}`

const LATIN_RE = /[a-z0-9_][a-z0-9_.\-/]*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g

/**
 * FNV-1a 32-bit hash. Deterministic across runs and platforms.
 * @param {string} text
 * @returns {number}
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Extract weighted features from text.
 *
 * - Latin words (>= 2 chars) → `w:<word>`
 * - CJK runs → all 2/3/4-char n-grams → `c:<gram>`
 * - Term frequency is sublinear: weight = 1 + ln(count)
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function extractFeatures(text) {
  const value = String(text ?? '').toLowerCase()
  /** @type {Map<string, number>} */
  const counts = new Map()
  const bump = (feature) => counts.set(feature, (counts.get(feature) ?? 0) + 1)

  for (const match of value.matchAll(LATIN_RE)) {
    const word = match[0]
    if (word.length >= 2) bump(`w:${word}`)
    if (word.length >= 4) {
      for (let i = 0; i + 3 <= word.length; i++) bump(`l3:${word.slice(i, i + 3)}`)
    }
  }
  for (const match of value.matchAll(CJK_RE)) {
    const run = match[0]
    for (const size of [2, 3, 4]) {
      for (let i = 0; i + size <= run.length; i++) bump(`c:${run.slice(i, i + size)}`)
    }
    if (run.length === 1) bump(`c1:${run}`)
  }
  return counts
}

/**
 * Embed text into a normalized Float32Array.
 * @param {string} text
 * @param {number} [dims]
 * @returns {Float32Array}
 */
export function embed(text, dims = VECTOR_DIMS) {
  const vector = new Float32Array(dims)
  const counts = extractFeatures(text)
  for (const [feature, count] of counts) {
    const hash = fnv1a(feature)
    const index = hash % dims
    const sign = (hash >>> 31) & 1 ? -1 : 1
    vector[index] += sign * (1 + Math.log(count))
  }
  let norm = 0
  for (let i = 0; i < dims; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dims; i++) vector[i] /= norm
  return vector
}

/**
 * Pack a vector for SQLite (BLOB).
 * @param {Float32Array} vector
 * @returns {Buffer}
 */
export function packVector(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/**
 * Unpack a stored blob. Returns null for a missing/mismatched width.
 * @param {Uint8Array|Buffer|null|undefined} blob
 * @param {number} [dims]
 * @returns {Float32Array|null}
 */
export function unpackVector(blob, dims = VECTOR_DIMS) {
  if (blob === null || blob === undefined) return null
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  if (bytes.byteLength !== dims * 4) return null
  // copy into an aligned buffer: Float32Array requires a 4-byte aligned view
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer)
}

/**
 * Cosine similarity for two normalized vectors (dot product).
 * @param {Float32Array|null} a
 * @param {Float32Array|null} b
 * @returns {number} -1..1
 */
export function cosine(a, b) {
  if (a === null || b === null) return 0
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
