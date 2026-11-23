import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { anchorOf, extractTextBlocks, logicalDateOf, parseCardReplyText, stripSystemReminders } from './util.js'

const USER_ALLOWED_KINDS = new Set(['user', 'user-question-reply'])

function extractSemanticEntry(event) {
  if (!isAppendSurfaceEvent(event)) return undefined

  if (event.type === 'assistant/message') {
    const raw = extractTextBlocks(event.data?.message?.content)
    const text = stripSystemReminders(raw)
    if (text === '') return undefined
    return { role: 'assistant', text }
  }

  if (event.type === 'user/message') {
    const source = event.data?.source
    const kind = source?.kind
    if (typeof kind === 'string' && kind.startsWith('dsh-memory/')) return undefined
    if (kind === 'bot' && (source?.handoff === true || source?.role === 'kickoff' || source?.role === 'goal')) {
      return undefined
    }
    if (kind !== undefined && !USER_ALLOWED_KINDS.has(kind)) {
      return undefined
    }

    const raw = extractTextBlocks(event.data?.content)
    if (kind === 'user-question-reply') {
      const cardText = parseCardReplyText(raw)
      if (!cardText) return undefined
      return { role: 'card', text: cardText }
    }

    const text = stripSystemReminders(raw)
    if (text === '') return undefined
    if (text.startsWith('[Group chat')) return undefined
    return { role: 'user', text }
  }

  return undefined
}

export function createIngestApi({ ctx, config, store, rolloverApi, clock = { now: () => Date.now() }, warn = () => {} }) {
  const excludedSessions = new Set(config.ingest.excludeSessionIds)
  const allowedScopes = new Set(config.ingest.includeScopes)

  function effectiveMode(sessionId) {
    const row = store.getSessionState(sessionId)
    return row?.memoryMode ?? config.defaultMode
  }

  function handleSessionEvent(session, event, { touchIdle = true } = {}) {
    if (!session || !event) return false
    const sessionId = session.id ?? session.header?.id
    if (!sessionId || excludedSessions.has(sessionId)) return false

    const inheritedCount = typeof session.inheritedEventCount === 'number'
      ? session.inheritedEventCount
      : (typeof session.header?.inheritedEventCount === 'number' ? session.header.inheritedEventCount : 0)
    if (typeof event.seq === 'number' && event.seq < inheritedCount) return false

    const header = session.header
    const isSubagent = header?.origin === 'subagent'
    const policy = config.ingest.subagentPolicy

    if (isSubagent && policy === 'ignore') return false
    if (isSubagent && policy === 'user-only' && event.type !== 'user/message') return false

    const entry = extractSemanticEntry(event)
    if (!entry) return false

    const timestamp = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : clock.now()
    if (touchIdle) {
      rolloverApi?.touchActivity?.(timestamp)
    }

    const state = store.getSessionState(sessionId)
    const scope = state?.scope ?? 'default'
    if (!allowedScopes.has(scope)) return false

    const mode = state?.memoryMode ?? config.defaultMode
    if (mode !== 'full') return false

    const logicalDate = logicalDateOf(timestamp, {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
    const anchor = anchorOf(logicalDate, sessionId, event.seq)
    const res = store.insertMessage({
      scope,
      sessionId,
      parentSessionId: header?.parentSession ?? null,
      isSubagent,
      logicalDate,
      seq: event.seq,
      role: entry.role,
      text: entry.text,
      timestamp,
      anchor,
    })

    const nextSeq = Math.max(state?.lastSeq ?? -1, Number(event.seq ?? -1))
    store.upsertSessionState(sessionId, {
      scope,
      parentSessionId: header?.parentSession ?? null,
      memoryMode: mode,
      lastSeq: nextSeq,
      updatedAt: clock.now(),
    })

    return res.inserted
  }

  async function catchUpFromSessionQuery() {
    const sessionQuery = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : ctx?.sessionQuery
    if (!sessionQuery?.listSessions || !sessionQuery?.readSession) return { sessionsChecked: 0, inserted: 0 }

    let sessionsChecked = 0
    let inserted = 0
    try {
      const records = await sessionQuery.listSessions()
      for (const rec of records) {
        const header = rec?.header
        const sessionId = header?.id
        if (!sessionId || excludedSessions.has(sessionId)) continue
        sessionsChecked += 1

        const state = store.getSessionState(sessionId)
        const lastSeq = state?.lastSeq ?? -1
        const mode = state?.memoryMode ?? config.defaultMode
        if (mode !== 'full') continue

        let snapshot
        try {
          snapshot = await sessionQuery.readSession(sessionId)
        } catch {
          continue
        }
        const fakeSession = {
          id: sessionId,
          header: snapshot.session ?? header,
          inheritedEventCount: snapshot.inheritedEventCount ?? 0,
        }
        for (const event of snapshot.events ?? []) {
          if (typeof event.seq === 'number' && event.seq <= lastSeq) continue
          if (handleSessionEvent(fakeSession, event, { touchIdle: false })) {
            inserted += 1
          }
        }
      }
    } catch (error) {
      warn('dsh-memory: catch-up via sessionQuery failed: %s', error?.message ?? error)
    }
    return { sessionsChecked, inserted }
  }

  function install() {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        handleSessionEvent(session, event, { touchIdle: true })
      } catch (error) {
        warn('dsh-memory: failed to ingest session event: %s', error?.message ?? error)
      }
    }), 'dsh-memory: session event ingest')
  }

  return {
    install,
    handleSessionEvent,
    catchUpFromSessionQuery,
    effectiveMode,
  }
}
