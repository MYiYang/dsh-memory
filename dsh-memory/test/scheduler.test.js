import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../src/store.js'
import { getCursor } from '../src/l0.js'
import { createScheduler, nextThreshold } from '../src/scheduler.js'

function harness(options = {}) {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  /** @type {Array<{fn: () => void, ms: number, cleared: boolean}>} */
  const timers = []
  /** @type {Array<[string, string]>} */
  const fired = []
  let now = 1000
  const scheduler = createScheduler({
    db,
    everyN: options.everyN ?? 4,
    idleMs: options.idleMs ?? 100,
    onDue: (sessionId, reason) => fired.push([sessionId, reason]),
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true
    },
    hasPending: options.hasPending ?? (() => true),
  })
  return {
    db,
    timers,
    fired,
    scheduler,
    advance: (ms) => {
      now += ms
    },
    fireLastTimer: () => {
      const timer = [...timers].reverse().find((entry) => !entry.cleared)
      timer.fn()
    },
    liveTimers: () => timers.filter((entry) => !entry.cleared),
  }
}

test('nextThreshold doubles and caps at everyN', () => {
  assert.equal(nextThreshold(1, 5), 2)
  assert.equal(nextThreshold(2, 5), 4)
  assert.equal(nextThreshold(4, 5), 5)
  assert.equal(nextThreshold(5, 5), 5)
  assert.equal(nextThreshold(4, 4), 4)
})

test('warm-up fires at 1, 3, 7 with everyN=4', () => {
  const h = harness({ everyN: 4 })
  const fired = []
  for (let turn = 1; turn <= 8; turn++) {
    const result = h.scheduler.noteTurn('s1', turn)
    if (result.fired) fired.push(turn)
  }
  assert.deepEqual(fired, [1, 3, 7])
  assert.deepEqual(h.fired.map(([, reason]) => reason), ['threshold', 'threshold', 'threshold'])
  assert.equal(getCursor(h.db, 's1').threshold, 4)
})

test('idle timer fires only when turns are pending and advances the ladder', () => {
  const pending = { value: true }
  const h = harness({ everyN: 8, idleMs: 250, hasPending: () => pending.value })
  h.scheduler.noteTurn('s1', 1) // threshold 1 → fires, threshold 2
  h.scheduler.noteTurn('s1', 2) // since 1 < 2 → arms idle
  assert.equal(h.liveTimers().length, 1)
  assert.equal(h.liveTimers()[0].ms, 250)

  h.fireLastTimer()
  assert.deepEqual(h.fired.map(([, reason]) => reason), ['threshold', 'idle'])
  const cursor = getCursor(h.db, 's1')
  assert.equal(cursor.sinceExtract, 0)
  assert.equal(cursor.threshold, 4)

  // a second idle fire with nothing pending must not enqueue a job
  pending.value = false
  h.scheduler.noteTurn('s1', 3) // since 1 < 4 → arms idle
  h.fireLastTimer()
  assert.equal(h.fired.length, 2)
  assert.equal(getCursor(h.db, 's1').pendingSince, null)
})

test('manual trigger fires immediately and resets the idle timer', () => {
  const h = harness({ everyN: 8 })
  h.scheduler.noteTurn('s1', 1) // fires threshold
  h.scheduler.noteTurn('s1', 2) // arms idle
  h.scheduler.trigger('s1', 2)
  assert.equal(h.fired.at(-1)[1], 'manual')
  assert.equal(h.liveTimers().length, 0)
  assert.equal(getCursor(h.db, 's1').sinceExtract, 0)
})

test('dispose clears every idle timer', () => {
  const h = harness({ everyN: 8 })
  h.scheduler.noteTurn('s1', 1)
  h.scheduler.noteTurn('s1', 2)
  h.scheduler.noteTurn('s2', 1) // threshold 1 fires for s2, no timer
  h.scheduler.noteTurn('s2', 2)
  assert.equal(h.liveTimers().length, 2)
  h.scheduler.dispose()
  assert.equal(h.liveTimers().length, 0)
})
