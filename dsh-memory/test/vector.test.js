import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VECTOR_DIMS,
  VECTOR_MODEL,
  cosine,
  embed,
  extractFeatures,
  fnv1a,
  packVector,
  unpackVector,
} from '../src/vector.js'

function norm(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

test('embedding is deterministic across calls and runs', () => {
  const a = embed('项目构建用 pnpm build')
  const b = embed('项目构建用 pnpm build')
  assert.deepEqual([...a], [...b])
  assert.equal(a.length, VECTOR_DIMS)
  assert.match(VECTOR_MODEL, /hash-ngram-v1-384/)
})

test('vectors are L2-normalized and empty text yields a zero vector', () => {
  assert.ok(Math.abs(norm(embed('pnpm build 构建')) - 1) < 1e-5)
  assert.equal(norm(embed('')), 0)
})

test('related text scores higher than unrelated text', () => {
  const query = embed('构建命令用 pnpm build')
  const related = embed('项目构建用 pnpm build，CI 也是')
  const unrelated = embed('数据库是 MySQL 8.0，端口 3306')
  assert.ok(cosine(query, related) > cosine(query, unrelated))
  assert.ok(cosine(query, related) > 0.3)
})

test('2-char CJK overlap is captured (FTS trigram would miss it)', () => {
  const a = embed('部署流程')
  const b = embed('部署步骤')
  const unrelated = embed('数据库端口')
  const relatedScore = cosine(a, b)
  assert.ok(relatedScore > 0.1, `cosine=${relatedScore}`)
  assert.ok(relatedScore > Math.abs(cosine(a, unrelated)))
})

test('features include CJK n-grams and latin words', () => {
  const features = extractFeatures('pnpm 构建 build')
  assert.ok(features.has('w:pnpm'))
  assert.ok(features.has('w:build'))
  assert.ok(features.has('c:构建'))
  assert.ok(features.has('c1:构') === false) // single chars only for runs of length 1
})

test('pack/unpack round-trips and rejects wrong widths', () => {
  const vector = embed('测试向量')
  const packed = packVector(vector)
  assert.equal(packed.byteLength, VECTOR_DIMS * 4)
  const restored = unpackVector(packed)
  assert.deepEqual([...restored], [...vector])
  assert.equal(unpackVector(Buffer.alloc(12)), null)
  assert.equal(unpackVector(null), null)
})

test('fnv1a is stable and unsigned', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'))
  assert.ok(fnv1a('abc') >= 0)
  assert.notEqual(fnv1a('abc'), fnv1a('abd'))
})
