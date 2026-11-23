import { logicalDateOf } from './util.js'

export function createRolloverApi({ ctx, config, store, digestApi, contextApi, clock = { now: () => Date.now() }, onRollover, warn = () => {} }) {
  let lastActivityAt = clock.now()
  let running = null

  function touchActivity(atMs = clock.now()) {
    if (atMs > lastActivityAt) lastActivityAt = atMs
  }

  function currentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function isIdleEnough() {
    return clock.now() - lastActivityAt >= config.idleMinutes * 60_000
  }

  async function processPendingDates({ isStartup = false, scope = 'default' } = {}) {
    const today = currentLogicalDate()
    const pendingDates = store.listPendingRolloverDates(today, scope)
    if (pendingDates.length === 0) return { rolledOver: [], failed: [] }

    if (!isStartup && !isIdleEnough()) {
      return { rolledOver: [], failed: [], waitingIdle: true }
    }

    const rolledOver = []
    const failed = []

    for (const date of pendingDates) {
      const prev = store.getRolloverState(date, scope)
      const attempts = (prev?.attempts ?? 0) + 1
      store.setRolloverState(date, scope, { status: 'running', attempts, error: null })
      try {
        const res = await digestApi.generateDailyDigest(date, { scope, force: false })
        store.setRolloverState(date, scope, {
          status: 'done',
          attempts,
          error: null,
          completedAt: clock.now(),
        })
        rolledOver.push({ date, skipped: res.skipped })
        if (!res.skipped) {
          contextApi?.invalidateSnapshots?.()
          try {
            ctx?.emit?.('dsh-memory/day-rolled-over', { date, scope })
          } catch {}
          try {
            await onRollover?.({ date, scope })
          } catch (hookError) {
            warn('dsh-memory: onRollover hook failed for %s: %s', date, hookError?.message ?? hookError)
          }
        }
      } catch (error) {
        const message = error?.message ?? String(error)
        store.setRolloverState(date, scope, {
          status: 'failed',
          attempts,
          error: message,
        })
        failed.push({ date, error: message })
        warn('dsh-memory: rollover failed for %s: %s', date, message)
      }
    }

    return { rolledOver, failed }
  }

  function checkAndRollover(options = {}) {
    if (running) return running
    running = processPendingDates(options).finally(() => {
      running = null
    })
    return running
  }

  function startTimer() {
    if (config.rolloverCheckIntervalMs <= 0) return () => {}
    const timer = setInterval(() => {
      void checkAndRollover({ isStartup: false }).catch(err => warn('dsh-memory: timer rollover error: %s', err))
    }, config.rolloverCheckIntervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return {
    touchActivity,
    currentLogicalDate,
    isIdleEnough,
    checkAndRollover,
    startTimer,
    getLastActivityAt: () => lastActivityAt,
  }
}
