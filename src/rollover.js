import { extractJournalHighlights } from './briefing.js'
import { clipText, logicalDateOf } from './util.js'

export function createRolloverApi({
  ctx,
  config,
  store,
  digestApi,
  contextApi,
  journalApi,
  bufferApi,
  clock = { now: () => Date.now() },
  onRollover,
  warn = () => {},
}) {
  let lastActivityAt = clock.now()
  let running = null

  function buildRolloverPayload(date, scope, digestResult) {
    const journalPath = digestResult?.path ?? journalApi?.journalPath?.(config.home, date) ?? null
    const rawJournal = journalApi?.readJournal?.(config.home, date) ?? ''
    const highlights = rawJournal
      ? extractJournalHighlights(rawJournal)
      : {
        title: `# ${date} 日报`,
        happened: [],
        decisions: [],
        changes: [],
        lessons: [],
        openQuestions: [],
        entities: [],
        hasContent: false,
      }
    const pendingBufferCount = bufferApi?.listItems?.({ scope, statuses: ['pending'] })?.length ?? 0
    const summaryLines = [
      ...highlights.decisions.slice(0, 2).map(line => `决定：${line}`),
      ...highlights.lessons.slice(0, 2).map(line => `教训：${line}`),
      ...highlights.openQuestions.slice(0, 2).map(line => `待办/未决：${line}`),
    ]
    if (summaryLines.length === 0) {
      summaryLines.push(...highlights.happened.slice(0, 2))
    }
    return {
      date,
      scope,
      journalPath,
      summary: {
        title: highlights.title || `# ${date} 日报`,
        highlights,
        pendingBufferCount,
        text: clipText(summaryLines.join('\n'), 500),
      },
    }
  }

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
          const eventPayload = buildRolloverPayload(date, scope, res)
          try {
            ctx?.emit?.('dsh-memory/day-rolled-over', eventPayload)
          } catch {}
          try {
            await onRollover?.(eventPayload)
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
