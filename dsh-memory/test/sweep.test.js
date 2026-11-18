import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, getMeta } from '../src/store.js'
import { appendTurn } from '../src/l0.js'
import { createStartupSweeper } from '../src/sweep.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  return db
}

function turn(db, sessionId, count = 1) {
  for (let i = 0; i < count; i++) {
    appendTurn(db, { sessionId, turn: i + 1, userText: `u${i}`, assistantText: `a${i}` }, 1_000 + i)
  }
}

function fakePipeline(options = {}) {
  const scheduled = []
  let flushes = 0
  return {
    scheduled,
    get flushes() {
      return flushes
    },
    schedule(sessionId, reason) {
      scheduled.push({ sessionId, reason })
    },
    async flush() {
      flushes += 1
      if (options.flushError) throw options.flushError
    },
  }
}

test('the startup sweep hands the oldest backlog to the queue and records the result', async () => {
  const db = setup()
  turn(db, 'session-old', 2)
  turn(db, 'session-new', 1)
  const pipeline = fakePipeline()
  const sweep = createStartupSweeper({ db, pipeline, sessions: 20, now: () => 123 })
  const result = await sweep.run()
  assert.equal(result.sessions, 2)
  assert.deepEqual(pipeline.scheduled.map((entry) => entry.sessionId), ['session-old', 'session-new'])
  assert.equal(pipeline.scheduled[0].reason, 'sweep')
  assert.equal(pipeline.flushes, 1)
  assert.deepEqual(JSON.parse(getMeta(db, 'l0-sweep-last')), { at: 123, sessions: 2, pendingBefore: 3, pendingAfter: 3 })
})

test('a sweep with nothing pending does nothing and writes no marker', async () => {
  const db = setup()
  const pipeline = fakePipeline()
  const sweep = createStartupSweeper({ db, pipeline })
  const result = await sweep.run()
  assert.equal(result.sessions, 0)
  assert.equal(pipeline.flushes, 0)
  assert.equal(getMeta(db, 'l0-sweep-last'), undefined)
})

test('sweepSessions bounds one sweep to the oldest sessions', async () => {
  const db = setup()
  turn(db, 's1', 1)
  turn(db, 's2', 1)
  turn(db, 's3', 1)
  const pipeline = fakePipeline()
  const sweep = createStartupSweeper({ db, pipeline, sessions: 2 })
  await sweep.run()
  assert.deepEqual(pipeline.scheduled.map((entry) => entry.sessionId), ['s1', 's2'])
})

test('a failing flush is reported instead of thrown', async () => {
  const db = setup()
  turn(db, 's1', 1)
  const pipeline = fakePipeline({ flushError: new Error('boom') })
  const sweep = createStartupSweeper({ db, pipeline })
  const result = await sweep.run()
  assert.equal(result.error, 'boom')
})

test('schedule fires the sweep once through the injected timer', async () => {
  const db = setup()
  turn(db, 's1', 1)
  const pipeline = fakePipeline()
  const timers = []
  const sweep = createStartupSweeper({
    db,
    pipeline,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() { handle.unrefd = true } }
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      handle.cleared = true
    },
  })
  sweep.schedule(5_000)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5_000)
  assert.equal(timers[0].unrefd, true)
  timers[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pipeline.scheduled.length, 1)
  assert.equal(pipeline.flushes, 1)
})

test('cancelling the scheduled sweep clears the timer', () => {
  const db = setup()
  const pipeline = fakePipeline()
  const timers = []
  const sweep = createStartupSweeper({
    db,
    pipeline,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      handle.cleared = true
    },
  })
  const cancel = sweep.schedule(1_000)
  cancel()
  assert.equal(timers[0].cleared, true)
})

test('the periodic pass repeats through the injected interval', async () => {
  const db = setup()
  turn(db, 's1', 1)
  const pipeline = fakePipeline()
  const timers = []
  const intervals = []
  const sweep = createStartupSweeper({
    db,
    pipeline,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      timers.push(handle)
      return handle
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearInterval: () => {},
  })
  sweep.schedule(1_000, 5_000)
  assert.equal(intervals.length, 0)
  timers[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 5_000)
  intervals[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pipeline.flushes, 2)
})

test('intervalMs 0 keeps the sweep startup-only', async () => {
  const db = setup()
  turn(db, 's1', 1)
  const pipeline = fakePipeline()
  const timers = []
  const intervals = []
  const sweep = createStartupSweeper({
    db,
    pipeline,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      timers.push(handle)
      return handle
    },
    clearTimeout: () => {},
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref() {} }
      intervals.push(handle)
      return handle
    },
    clearInterval: () => {},
  })
  sweep.schedule(1_000, 0)
  timers[0].fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(intervals.length, 0)
})

test('a periodic pass leaves fresh turns to the normal path', async () => {
  const db = setup()
  appendTurn(db, { sessionId: 'fresh', turn: 1, userText: 'u', assistantText: 'a' }, Date.now())
  const pipeline = fakePipeline()
  const sweep = createStartupSweeper({ db, pipeline, minAgeMs: 30 * 60_000 })
  const result = await sweep.run()
  assert.equal(result.skipped, 'fresh')
  assert.equal(pipeline.scheduled.length, 0)
  assert.equal(pipeline.flushes, 0)
})

test('a periodic pass still sweeps backlog older than the threshold', async () => {
  const db = setup()
  appendTurn(db, { sessionId: 'old', turn: 1, userText: 'u', assistantText: 'a' }, Date.now() - 60 * 60_000)
  const pipeline = fakePipeline()
  const sweep = createStartupSweeper({ db, pipeline, minAgeMs: 30 * 60_000 })
  const result = await sweep.run()
  assert.equal(result.sessions, 1)
  assert.equal(pipeline.scheduled.length, 1)
})
