import { defineTool } from '@deepseek-ai/dsh-tools'
import { VALID_MEMORY_MODES, VALID_SCENE_MODES } from './config.js'
import { MemoryGuardError } from './guard.js'
import * as defaultProfileApi from './profile.js'
import { clipText, logicalDateOf } from './util.js'
import { rrfMerge } from './vector.js'

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const SUBAGENT_READ_ONLY_TOOLS = new Set([
  'memory_search',
  'memory_read_context',
  'memory_journal_read',
])
const SUBAGENT_READ_ONLY_ACTIONS = new Map([
  ['memory_history_browse', new Set(['list', 'read'])],
  ['memory_entity_manage', new Set(['list', 'read'])],
  ['memory_lesson_manage', new Set(['list', 'read'])],
])

function isSubagentExec(exec) {
  return exec?.agent?.session?.header?.origin === 'subagent'
}

function subagentDenialMessage(toolName, args, exec) {
  if (!isSubagentExec(exec)) return null
  if (SUBAGENT_READ_ONLY_TOOLS.has(toolName)) return null
  const allowedActions = SUBAGENT_READ_ONLY_ACTIONS.get(toolName)
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  if (allowedActions && allowedActions.has(action)) return null
  const actionSuffix = action ? ` (action="${action}")` : ''
  const hint = allowedActions
    ? ` Subagent sessions may only run read-only actions (${[...allowedActions].join('/')}) on ${toolName}.`
    : ' Subagent sessions are restricted to read-only memory queries (memory_search, memory_read_context, memory_journal_read, memory_history_browse(list/read), memory_entity_manage(list/read), memory_lesson_manage(list/read)).'
  return `Refused: "${toolName}"${actionSuffix} is not permitted in subagent sessions.${hint}`
}

function defineMemoryTool(spec) {
  const { execute, ...rest } = spec
  return defineTool({
    ...rest,
    async execute(args, exec) {
      const denied = subagentDenialMessage(spec.name, args, exec)
      if (denied) return denied
      return await execute(args, exec)
    },
  })
}

function formatContextWindowLines(ctxRes, { maxCharsPerMessage = 800, maxTotalChars = 6000 } = {}) {
  if (!ctxRes?.target) return []
  const targetIdx = ctxRes.messages.findIndex(m => m.anchor === ctxRes.target.anchor)
  const orderedIndices = [targetIdx]
  for (let offset = 1; offset < ctxRes.messages.length; offset += 1) {
    if (targetIdx - offset >= 0) orderedIndices.push(targetIdx - offset)
    if (targetIdx + offset < ctxRes.messages.length) orderedIndices.push(targetIdx + offset)
  }

  const chosen = new Set()
  let usedChars = 0
  const formattedByIdx = new Map()
  for (const idx of orderedIndices) {
    const row = ctxRes.messages[idx]
    const prefix = idx === targetIdx ? '>>> ' : '    '
    const line = `${prefix}[${row.anchor}] (${row.role}) ${clipText(row.text, maxCharsPerMessage)}`
    if (idx === targetIdx || usedChars + line.length + 1 <= maxTotalChars) {
      chosen.add(idx)
      formattedByIdx.set(idx, line)
      usedChars += line.length + 1
    }
  }

  return ctxRes.messages
    .map((_row, idx) => (chosen.has(idx) ? formattedByIdx.get(idx) : null))
    .filter(Boolean)
}

const COMPACT_HIDDEN_ADMIN_TOOLS = new Set([
  'memory_dream_now',
  'memory_digest_now',
  'memory_rollback',
])

export function createToolsApi({
  ctx,
  config,
  store,
  bufferApi,
  journalApi,
  digestApi,
  contextApi,
  historyApi,
  entityApi,
  lessonApi,
  onboardingApi,
  briefingApi,
  profileApi = defaultProfileApi,
  dreamApi,
  vectorApi,
  clock = { now: () => Date.now() },
}) {
  function currentLogicalDate() {
    return logicalDateOf(clock.now(), {
      timeZone: config.timeZone,
      dayStartHour: config.dayStartHour,
    })
  }

  function sessionScopeOf(sessionId) {
    return (sessionId && store.getSessionState(sessionId)?.scope) || 'default'
  }

  function effectiveModeOf(sessionId) {
    return (sessionId && store.getSessionState(sessionId)?.memoryMode) || config.defaultMode
  }

  const tools = [
    defineMemoryTool({
      name: 'memory_search',
      description: 'Search historical conversation transcripts (FTS5 trigram + LIKE, with multi-term OR fallback ranked by coverage), daily journals, and entity/lesson card bodies by keyword or date range. Omit query to browse recent archived messages by date range. Returns snippets with exact chat:// anchors and card references.',
      parameters: {
        query: { type: 'string', description: 'Optional keywords or phrase to search. Omit to browse recent archived messages in the date range (defaults up to today).' },
        dateFrom: { type: 'string', description: 'Optional inclusive start date (YYYY-MM-DD).' },
        dateTo: { type: 'string', description: 'Optional inclusive end date (YYYY-MM-DD).' },
        scope: { type: 'string', description: 'Optional memory scope (default "default").' },
        limit: { type: 'integer', description: 'Maximum hits per source (default 10, max 50).' },
        contextTurns: { type: 'integer', description: 'Optional number of adjacent turns (0-3, default 0) to expand around each archived match.' },
      },
      output: stringOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        if (effectiveModeOf(sessionId) === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        const scope = args.scope?.trim() || sessionScopeOf(sessionId)
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50)
        const contextTurns = Math.min(Math.max(Number.parseInt(args.contextTurns, 10) || 0, 0), 3)
        const rawQuery = typeof args.query === 'string' ? args.query.trim() : ''
        const dateFrom = args.dateFrom?.trim() || undefined
        let dateTo = args.dateTo?.trim() || undefined
        if (!rawQuery && !dateFrom && !dateTo) {
          dateTo = currentLogicalDate()
        }

        const msgHits = store.searchMessages({
          query: rawQuery,
          dateFrom,
          dateTo,
          scope,
          limit,
        })
        const journalHits = rawQuery
          ? journalApi.searchJournals(config.home, {
            query: rawQuery,
            dateFrom,
            dateTo,
            limit,
          })
          : []
        const entityHits = rawQuery && entityApi?.searchEntities
          ? entityApi.searchEntities(config.home, { query: rawQuery, limit })
          : []
        const lessonHits = rawQuery && lessonApi?.searchLessons
          ? lessonApi.searchLessons(config.home, { query: rawQuery, limit })
          : []
        const combinedCardHits = [...entityHits, ...lessonHits]
        const andCardHits = combinedCardHits.filter(hit => hit.isAndMatch)
        const cardHits = (andCardHits.length > 0 ? andCardHits : combinedCardHits)
          .sort((a, b) =>
            b.matchedCount - a.matchedCount
            || b.matchedChars - a.matchedChars
            || (b.bodyMatchedCount ?? 0) - (a.bodyMatchedCount ?? 0)
            || a.kind.localeCompare(b.kind)
            || a.slug.localeCompare(b.slug))
          .slice(0, limit)

        const vectorHits = rawQuery && config.retrieval?.vector?.enabled === true && vectorApi
          ? vectorApi.search({
            query: rawQuery,
            scope,
            dateFrom,
            dateTo,
            limit,
            minScore: config.retrieval?.vector?.minScore,
          })
          : []

        const rrfHits = vectorHits.length > 0
          ? rrfMerge([
            [
              ...cardHits.map(h => ({
                key: `${h.kind}:${h.slug}`,
                kind: h.kind,
                title: h.name,
                snippet: h.snippet,
                sourceChannel: 'card',
              })),
              ...journalHits.map(h => ({
                key: `journal:${h.date}`,
                kind: 'journal',
                title: `${h.date}${h.section ? ` · ${h.section}` : ''}`,
                snippet: h.line,
                sourceChannel: 'journal',
              })),
              ...msgHits.map(h => ({
                key: `msg:${h.anchor}`,
                kind: 'archive',
                title: h.anchor,
                snippet: clipText(h.text, 240),
                sourceChannel: 'fts5',
              })),
            ],
            vectorHits.map(vh => ({
              key: vh.docKey,
              kind: vh.kind,
              title: vh.title || vh.docKey,
              snippet: vh.snippet,
              vectorScore: vh.score,
              sourceChannel: 'vector',
            })),
          ], {
            k: config.retrieval?.vector?.rrfK ?? 60,
            limit,
          })
          : []

        if (msgHits.length === 0 && journalHits.length === 0 && cardHits.length === 0 && vectorHits.length === 0) {
          return rawQuery
            ? `No memory matches found for "${rawQuery}".`
            : 'No archived messages found for the specified date range.'
        }

        const sections = []
        if (rrfHits.length > 0) {
          sections.push(
            '### Hybrid / Semantic Matches (RRF)',
            ...rrfHits.map((hit) => {
              const vs = hit.vectorScore !== undefined ? `, vec=${hit.vectorScore.toFixed(2)}` : ''
              return `- [${hit.key} (${hit.sources.join('+')}, rrf=${hit.rrfScore.toFixed(4)}${vs})] ${hit.snippet}`
            }),
          )
        }
        if (cardHits.length > 0) {
          sections.push(
            '### Card Matches',
            ...cardHits.map((hit) => {
              const meta = [hit.kind === 'entity' ? `entity:${hit.name}` : `lesson:${hit.name}`]
              if (hit.entryId) meta.push(hit.entryId)
              if (hit.source) meta.push(hit.source)
              return `- [${meta.join(' · ')}] ${hit.snippet}`
            }),
          )
        }
        if (journalHits.length > 0) {
          sections.push(
            '### Journal Matches',
            ...journalHits.map(hit => `- [${hit.date}${hit.section ? ` · ${hit.section}` : ''}] ${hit.line}`),
          )
        }
        if (msgHits.length > 0) {
          sections.push('### Archive Matches')
          if (contextTurns > 0 && typeof store.getMessageContext === 'function') {
            for (const hit of msgHits) {
              const ctxRes = store.getMessageContext({
                anchor: hit.anchor,
                before: contextTurns,
                after: contextTurns,
                scope,
              })
              if (!ctxRes) {
                sections.push(`- [${hit.anchor}] (${hit.role}) ${clipText(hit.text, 300)}`)
              } else {
                sections.push(...formatContextWindowLines(ctxRes, { maxCharsPerMessage: 300, maxTotalChars: 1600 }))
              }
            }
          } else {
            sections.push(...msgHits.map(hit => `- [${hit.anchor}] (${hit.role}) ${clipText(hit.text, 300)}`))
          }
        }
        return sections.join('\n')
      },
    }),

    defineMemoryTool({
      name: 'memory_read_context',
      description: 'Expand surrounding archived conversation turns (before and after) around a specific chat:// anchor using row-window queries.',
      parameters: {
        anchor: { type: 'string', required: true, description: 'Exact chat://YYYY-MM-DD#session#seq anchor.' },
        before: { type: 'integer', description: 'Number of preceding turns to fetch (default 2, max 20).' },
        after: { type: 'integer', description: 'Number of following turns to fetch (default 2, max 20).' },
        maxCharsPerMessage: { type: 'integer', description: 'Optional max chars per message (default 800).' },
        maxTotalChars: { type: 'integer', description: 'Optional max total chars across window (default 6000).' },
      },
      output: stringOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        if (effectiveModeOf(sessionId) === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        const scope = sessionScopeOf(sessionId)
        const anchor = args.anchor?.trim()
        if (!anchor) {
          return 'Please provide a valid chat:// anchor.'
        }
        const ctxRes = store.getMessageContext({
          anchor,
          before: args.before ?? 2,
          after: args.after ?? 2,
          scope,
        })
        if (!ctxRes) {
          return `No archived message found for anchor "${anchor}".`
        }
        const maxPerMsg = Math.min(Math.max(Number.parseInt(args.maxCharsPerMessage, 10) || 800, 100), 4000)
        const maxTotal = Math.min(Math.max(Number.parseInt(args.maxTotalChars, 10) || 6000, 300), 24000)
        const lines = formatContextWindowLines(ctxRes, { maxCharsPerMessage: maxPerMsg, maxTotalChars: maxTotal })
        return [
          `Context around ${ctxRes.target.anchor} (session=${ctxRes.target.session_id}, before=${ctxRes.before.length}, after=${ctxRes.after.length}):`,
          ...lines,
        ].join('\n')
      },
    }),

    defineMemoryTool({
      name: 'memory_journal_read',
      description: 'Read the immutable daily journal for a specific date (YYYY-MM-DD), or list available journal dates when date is omitted.',
      parameters: {
        date: { type: 'string', description: 'Logical date in YYYY-MM-DD format. Omit to list all available journal dates.' },
      },
      output: stringOutput,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (effectiveModeOf(exec.agent?.id) === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        const date = args.date?.trim()
        if (!date) {
          const dates = journalApi.listJournalDates(config.home)
          return dates.length > 0
            ? `Available journal dates (${dates.length}): ${dates.join(', ')}`
            : 'No daily journals have been generated yet.'
        }
        const content = journalApi.readJournal(config.home, date)
        if (!content) {
          return `No journal found for ${date}.`
        }
        return content
      },
    }),

    defineMemoryTool({
      name: 'memory_buffer_add',
      description: 'Add a memory item or user correction to the daily append-only buffer (never mutates PROFILE.md mid-day). Anchors are bound automatically from the live user message.',
      parameters: {
        content: { type: 'string', required: true, description: 'Concise memory fact, preference, or correction to record.' },
        sourceType: { type: 'string', enum: ['explicit', 'correction', 'extracted'], required: true, description: 'Origin of this memory item.' },
        target: { type: 'string', description: 'Target store: "profile" (default), "note" (for today journal), "entity:<name>", or "lesson:<name>".' },
        section: { type: 'string', description: 'Target section name in PROFILE.md (e.g. "沟通与工作偏好").' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags when target is "lesson:<name>" (e.g. ["deploy", "nginx"]).' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'Optional trigger keywords when target is "lesson:<name>".' },
        op: { type: 'string', enum: ['add', 'replace', 'retire'], description: 'Operation type (default "add").' },
        supersedesId: { type: 'string', description: 'Existing PROFILE/entity/lesson entry id to replace or retire.' },
        expires: { type: 'string', description: 'Optional expiration date (YYYY-MM-DD) for phase-limited facts or lessons.' },
        pinned: { type: 'boolean', description: 'Whether to mark as pinned (protected from automated Dream deletion).' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode !== 'full') {
          return `Cannot write to memory buffer while session mode is "${mode}".`
        }

        const scope = sessionScopeOf(sessionId)
        const latestUser = sessionId
          ? (store.getLatestUserOrCardMessage?.(sessionId) ?? store.getLatestUserMessage(sessionId))
          : undefined
        const boundAnchor = latestUser?.anchor ?? null

        let effectiveSourceType = args.sourceType
        let downgradeNote = ''
        if ((effectiveSourceType === 'explicit' || effectiveSourceType === 'correction') && !boundAnchor) {
          effectiveSourceType = 'extracted'
          downgradeNote = ' (downgraded to "extracted" because no verified user message anchor exists in this session)'
        }

        const logicalDate = currentLogicalDate()
        let created
        try {
          created = await bufferApi.appendCreate({
            logicalDate,
            scope,
            sourceType: effectiveSourceType,
            target: args.target ?? 'profile',
            op: args.op ?? 'add',
            section: args.section ?? '其他长期事实',
            content: args.content,
            supersedesId: args.supersedesId ?? null,
            expires: args.expires?.trim() || undefined,
            tags: args.tags,
            triggers: args.triggers,
            anchor: boundAnchor,
            pinned: args.pinned === true,
          })
        } catch (error) {
          if (error instanceof MemoryGuardError) {
            return `Refused to buffer (${error.code}): ${error.message}`
          }
          throw error
        }

        if (created.duplicate) {
          return `Skipped duplicate item: already exists as ${created.id} (${created.duplicateIn}).`
        }

        return `Buffered item ${created.id} for ${logicalDate} (target=${created.target}, sourceType=${created.source_type}, anchor=${created.anchor ?? 'none'})${downgradeNote}.`
      },
    }),

    defineMemoryTool({
      name: 'memory_buffer_manage',
      description: 'List, approve, or reject pending items in the daily memory buffer so the user can review and choose what gets committed. Note: "approve" marks items ready for settlement at daily rollover (preserving today\'s frozen prefix cache) unless settleNow is true.',
      parameters: {
        action: { type: 'string', enum: ['list', 'approve', 'reject'], required: true, description: 'Action to run on buffer items.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Buffer item IDs for approve/reject.' },
        date: { type: 'string', description: 'Optional logical date filter (YYYY-MM-DD) for list.' },
        reason: { type: 'string', description: 'Optional reason recorded on status change.' },
        settleNow: { type: 'boolean', description: 'When action is "approve", if true, immediately settle approved profile/entity buffer items to disk and refresh snapshots.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const scope = sessionScopeOf(sessionId)
        if (args.action === 'list') {
          const items = bufferApi.listItems({
            scope,
            ...(args.date ? { logicalDate: args.date.trim() } : {}),
            statuses: ['pending', 'approved'],
          })
          if (items.length === 0) {
            return 'No pending or approved items in the buffer.'
          }
          return items
            .map(item => `- [${item.id}] (${item.logical_date} | ${item.status} | ${item.source_type} -> ${item.target}) ${item.content}${item.anchor ? ` [${item.anchor}]` : ''}`)
            .join('\n')
        }

        const ids = Array.isArray(args.ids) ? args.ids.filter(Boolean) : []
        if (ids.length === 0) {
          return `Please provide at least one item id in "ids" to ${args.action}.`
        }

        if (args.action === 'approve' && args.settleNow === true && briefingApi) {
          const res = await briefingApi.confirmItems({
            approveIds: ids,
            reason: args.reason,
            settleNow: true,
            scope,
          })
          if (res.approved.length === 0) {
            return 'No matching buffer items found.'
          }
          const committed = res.settlement?.committedCount ?? 0
          const warnings = [
            ...(res.settlement?.profile?.warnings ?? []),
            ...(res.settlement?.entity?.warnings ?? []),
            ...(res.settlement?.lesson?.warnings ?? []),
          ]
          return [
            `Updated ${res.approved.length} buffer item(s) to "approved": ${res.approved.join(', ')}.`,
            `Immediate settlement committed ${committed} item(s).`,
            ...(warnings.length > 0 ? [`Warnings: ${warnings.map(w => `${w.id}:${w.reason}`).join(', ')}`] : []),
          ].join(' ')
        }

        const nextStatus = args.action === 'approve' ? 'approved' : 'rejected'
        const existingItems = args.settleNow === true ? bufferApi.listItems({ scope, statuses: ['pending', 'approved'] }) : []
        const updated = await bufferApi.updateStatuses(ids, nextStatus, {
          by: 'user',
          reason: args.reason,
        })
        if (updated.length === 0) {
          return 'No matching buffer items found.'
        }
        if (nextStatus === 'approved' && args.settleNow === true && profileApi) {
          const updatedSet = new Set(updated)
          const dates = existingItems.filter(i => updatedSet.has(i.id)).map(i => i.logical_date)
          const settlement = await bufferApi.settleDates({ dates, scope, store, profileApi, entityApi, lessonApi, config })
          if (settlement.profile.committed.length > 0) contextApi?.invalidateSnapshots?.()
          return `Updated ${updated.length} buffer item(s) to "approved": ${updated.join(', ')}. Immediate settlement committed ${settlement.committedCount} item(s).`
        }
        if (nextStatus === 'approved') {
          return `Updated ${updated.length} buffer item(s) to "approved": ${updated.join(', ')}. They will be settled into PROFILE.md/entities during daily rollover (or run memory_digest_now with today's date if immediate settlement is explicitly requested).`
        }
        return `Updated ${updated.length} buffer item(s) to "${nextStatus}": ${updated.join(', ')}`
      },
    }),

    defineMemoryTool({
      name: 'memory_mode_set',
      description: 'Switch memory mode ("full", "read-only", "off") and/or scene mode ("work", "chat") for the current session or global default.',
      parameters: {
        mode: { type: 'string', enum: ['full', 'read-only', 'off'], description: 'Optional target memory mode.' },
        scene: { type: 'string', enum: ['work', 'chat'], description: 'Optional target scene mode ("work" injects work journals & cards; "chat" silences work context).' },
        scope: { type: 'string', enum: ['session', 'global'], description: 'Apply to current "session" (default) or "global" default.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const hasMode = args.mode !== undefined
        const hasScene = args.scene !== undefined
        if (!hasMode && !hasScene) {
          return 'Please specify at least one of "mode" (full/read-only/off) or "scene" (work/chat).'
        }
        if (hasMode && !VALID_MEMORY_MODES.has(args.mode)) {
          return `Invalid mode "${args.mode}". Use full, read-only, or off.`
        }
        if (hasScene && !VALID_SCENE_MODES.has(args.scene)) {
          return `Invalid scene "${args.scene}". Use work or chat.`
        }

        const targetScope = args.scope ?? 'session'
        if (targetScope === 'global') {
          const changes = []
          if (hasMode) {
            config.defaultMode = args.mode
            changes.push(`defaultMode="${args.mode}"`)
          }
          if (hasScene) {
            config.defaultScene = args.scene
            changes.push(`defaultScene="${args.scene}"`)
          }
          contextApi.invalidateSnapshots()
          return `Global ${changes.join(', ')} updated.`
        }

        const sessionId = exec.agent?.id
        if (!sessionId) {
          return 'No active session id available for session-scoped mode change.'
        }
        const changes = []
        if (hasMode) {
          store.setSessionMode(sessionId, args.mode, clock.now())
          changes.push(`memory mode="${args.mode}"`)
        }
        if (hasScene) {
          store.setSessionScene(sessionId, args.scene, clock.now())
          changes.push(`scene="${args.scene}"`)
        }
        if (args.mode === 'off' || hasScene) {
          contextApi.invalidateSnapshots({ sessionId })
        }
        return `Session ${sessionId} ${changes.join(', ')} set.`
      },
    }),

    defineMemoryTool({
      name: 'memory_digest_now',
      description: 'Manually trigger daily digest generation and buffer settlement for a logical date (defaults to yesterday).',
      parameters: {
        date: { type: 'string', description: 'Logical date (YYYY-MM-DD). Defaults to yesterday relative to current logical date.' },
        force: { type: 'boolean', description: 'If true, overwrite an existing daily journal.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const scope = sessionScopeOf(sessionId)
        const today = currentLogicalDate()
        let targetDate = args.date?.trim()
        if (!targetDate) {
          const d = new Date(`${today}T00:00:00Z`)
          d.setUTCDate(d.getUTCDate() - 1)
          targetDate = d.toISOString().slice(0, 10)
        }
        const res = await digestApi.generateDailyDigest(targetDate, {
          scope,
          force: args.force === true,
          signal: exec.signal,
        })
        if (res.skipped) {
          return `Digest skipped for ${targetDate}: ${res.reason}.`
        }
        store.setRolloverState(targetDate, scope, {
          status: 'done',
          completedAt: clock.now(),
          error: null,
        })
        contextApi.invalidateSnapshots()
        const entityCountText = res.entitySettlement
          ? `, Entities committed: ${res.entitySettlement.committed.length}, Entity deferred: ${res.entitySettlement.deferred.length}`
          : ''
        const lessonCountText = res.lessonSettlement
          ? `, Lessons committed: ${res.lessonSettlement.committed.length}, Lesson deferred: ${res.lessonSettlement.deferred.length}`
          : ''
        const allWarnings = [
          ...res.profileSettlement.warnings,
          ...(res.entitySettlement?.warnings ?? []),
          ...(res.lessonSettlement?.warnings ?? []),
        ]
        return [
          `Generated journal for ${targetDate} (${res.chunks} chunk(s)): ${res.path}`,
          `Notes closed: ${res.closedNotes.length}, Profile committed: ${res.profileSettlement.committed.length}, Deferred: ${res.profileSettlement.deferred.length}${entityCountText}${lessonCountText}`,
          ...(res.unverifiedAnchors.length > 0 ? [`Stripped unverified anchors: ${res.unverifiedAnchors.join(', ')}`] : []),
          ...(allWarnings.length > 0
            ? [`Warnings: ${allWarnings.map(w => `${w.id}:${w.reason}`).join(', ')}`]
            : []),
        ].join('\n')
      },
    }),

    defineMemoryTool({
      name: 'memory_forget',
      description: 'Actively forget memories requested by the user: permanently deletes matching messages from archive and FTS5, rejects matching buffer items, redacts matching lines in daily journals, entities, lessons, and history index, removes matching entries from PROFILE.md and retired.jsonl, and invalidates snapshots.',
      parameters: {
        anchor: { type: 'string', description: 'Exact chat:// anchor to forget.' },
        date: { type: 'string', description: 'Optional logical date filter (YYYY-MM-DD).' },
        keyword: { type: 'string', description: 'Optional substring/keyword to forget.' },
        sessionId: { type: 'string', description: 'Optional session id filter.' },
        force: { type: 'boolean', description: 'If true, also remove matched pinned entries in PROFILE.md and lessons/.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        if (!args.anchor && !args.date && !args.keyword && !args.sessionId) {
          return 'Refusing empty forget request: provide at least one of anchor, date, keyword, or sessionId.'
        }
        const callerSessionId = exec.agent?.id
        const scope = sessionScopeOf(callerSessionId)
        const todayDate = currentLogicalDate()
        const cleanAnchor = args.anchor?.trim() || undefined
        const cleanDate = args.date?.trim() || undefined
        const cleanKeyword = args.keyword?.trim() || undefined
        const cleanSessionId = args.sessionId?.trim() || undefined

        const deleted = store.deleteMessages({
          anchor: cleanAnchor,
          date: cleanDate,
          keyword: cleanKeyword,
          sessionId: cleanSessionId,
          scope,
        })

        const anchorsToReject = [...deleted.deletedAnchors, ...(cleanAnchor ? [cleanAnchor] : [])]
        const rejectedBufferIds = typeof bufferApi.rejectForForget === 'function'
          ? await bufferApi.rejectForForget({
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            date: cleanDate,
            scope,
            by: 'user',
            reason: 'memory_forget',
          })
          : await bufferApi.rejectByAnchors(anchorsToReject, {
            by: 'user',
            reason: 'memory_forget',
          })

        const redactedJournals = await journalApi.redactJournalForForget(config.home, {
          date: cleanDate,
          anchors: anchorsToReject,
          keyword: cleanKeyword,
          sessionId: cleanSessionId,
          todayDate,
        })

        const redactedEntities = entityApi
          ? await entityApi.redactEntitiesForForget(config.home, {
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            todayDate,
          })
          : { updatedEntities: [] }

        const redactedLessons = lessonApi
          ? await lessonApi.redactLessonsForForget(config.home, {
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            force: args.force === true,
            todayDate,
          })
          : { updatedLessons: [], skippedPinnedIds: [] }

        const redactedHistory = historyApi
          ? await historyApi.redactHistoryForForget({
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            affectedDates: [...new Set([...deleted.affectedDates, ...redactedJournals])],
            todayDate,
          })
          : { updatedMonths: [] }

        const redactedProfile = profileApi?.redactProfileForForget
          ? await profileApi.redactProfileForForget(config.home, {
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            force: args.force === true,
          })
          : { removedIds: [], skippedPinnedIds: [], changed: false }

        const purgedRetired = profileApi?.purgeRetiredForForget
          ? await profileApi.purgeRetiredForForget(config.home, {
            anchors: anchorsToReject,
            keyword: cleanKeyword,
            entryIds: redactedProfile.removedIds,
          })
          : { purgedCount: 0 }

        contextApi.invalidateSnapshots()

        return [
          `Forgot ${deleted.deletedCount} archived message(s).`,
          `Rejected ${rejectedBufferIds.length} buffer item(s).`,
          `Redacted ${redactedJournals.length} daily journal(s)${redactedJournals.length > 0 ? `: ${redactedJournals.join(', ')}` : ''}.`,
          `Redacted ${redactedEntities.updatedEntities.length} entity card(s)${redactedEntities.updatedEntities.length > 0 ? `: ${redactedEntities.updatedEntities.join(', ')}` : ''}.`,
          `Redacted ${redactedLessons.updatedLessons.length} lesson card(s)${redactedLessons.updatedLessons.length > 0 ? `: ${redactedLessons.updatedLessons.join(', ')}` : ''}${redactedLessons.skippedPinnedIds.length > 0 ? ` (skipped pinned: ${redactedLessons.skippedPinnedIds.join(', ')}; pass force=true to delete)` : ''}.`,
          `Redacted ${redactedHistory.updatedMonths.length} history month(s)${redactedHistory.updatedMonths.length > 0 ? `: ${redactedHistory.updatedMonths.join(', ')}` : ''}.`,
          `Removed ${redactedProfile.removedIds.length} profile entry(s)${redactedProfile.skippedPinnedIds.length > 0 ? ` (skipped pinned: ${redactedProfile.skippedPinnedIds.join(', ')}; pass force=true to delete)` : ''}.`,
          `Purged ${purgedRetired.purgedCount} retired record(s).`,
        ].join(' ')
      },
    }),

    defineMemoryTool({
      name: 'memory_history_browse',
      description: 'Browse OpenViking L0/L1 historical memory index by month or rebuild it single-hop from immutable daily journals, then drill down to L2 with memory_journal_read.',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'rebuild'], required: true, description: 'Operation: list months, read L0/L1 overview, or rebuild from journals.' },
        month: { type: 'string', description: 'Month in YYYY-MM format (optional on list/rebuild; defaults to latest month on read).' },
        level: { type: 'string', enum: ['L0', 'L1'], description: 'Detail level to read (default "L1").' },
      },
      output: stringOutput,
      isConcurrencySafe: args => args?.action !== 'rebuild',
      async execute(args, exec) {
        if (effectiveModeOf(exec.agent?.id) === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!historyApi) {
          return 'History index module is not available.'
        }

        if (args.action === 'list') {
          const data = historyApi.readHistory()
          if (data.months.length === 0) {
            return 'No historical monthly summaries have been built yet.'
          }
          return [
            data.global || '# 历史总览地图（L0）',
            '',
            'Available months:',
            ...data.months.map(m => `- ${m.month}${m.hasOverview ? ' (L0+L1)' : ' (L0)'}: ${m.abstract}`),
          ].join('\n')
        }

        if (args.action === 'rebuild') {
          const month = args.month?.trim()
          if (month) {
            const res = await historyApi.rebuildMonthHistory(month, { signal: exec.signal })
            contextApi.invalidateSnapshots()
            return res.removed
              ? `Cleared empty history index for ${month} (no journals found).`
              : `Rebuilt ${month} history index from ${res.journalCount} journal(s).`
          }
          const res = await historyApi.rebuildAllHistory({ signal: exec.signal })
          contextApi.invalidateSnapshots()
          return `Rebuilt history index for ${res.months.length} month(s).`
        }

        const months = historyApi.listHistoryMonths()
        const targetMonth = args.month?.trim() || months.at(-1)?.month
        if (!targetMonth) {
          return 'No historical monthly summaries found.'
        }
        const level = args.level === 'L0' ? 'L0' : 'L1'
        const res = historyApi.readHistory({ month: targetMonth, level })
        if (!res.abstract && !res.overview) {
          return `No history index found for ${targetMonth}.${res.journalDates.length > 0 ? ` Available L2 journals: ${res.journalDates.join(', ')}` : ''}`
        }
        const parts = [`## ${targetMonth} History (${level})`]
        if (res.abstract) parts.push(`### L0 Abstract\n${res.abstract}`)
        if (level === 'L1' && res.overview) parts.push(`### L1 Overview\n${res.overview}`)
        if (res.journalDates.length > 0) {
          parts.push(`L2 daily journals in ${targetMonth}: ${res.journalDates.join(', ')} (use memory_journal_read to inspect full details)`)
        }
        return parts.join('\n\n')
      },
    }),

    defineMemoryTool({
      name: 'memory_entity_manage',
      description: 'List, read, create/update, or delete entity memory cards (people, projects, servers) and their alias triggers.',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'upsert', 'delete'], required: true, description: 'Operation on entity cards.' },
        name: { type: 'string', description: 'Entity name, alias, or slug (required for read/upsert/delete).' },
        type: { type: 'string', description: 'Entity type (e.g. person, project, server, tool).' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Aliases that automatically trigger dynamic context injection.' },
        content: { type: 'string', description: 'Fact content to add or replace.' },
        op: { type: 'string', enum: ['add', 'replace', 'retire'], description: 'Fact mutation operation on upsert (default "add").' },
        status: { type: 'string', enum: ['active', 'archived'], description: 'Lifecycle status ("archived" silences automatic recall while keeping search visibility).' },
        supersedesId: { type: 'string', description: 'Existing fact id (e.g. ent_01) to replace or retire.' },
        pinned: { type: 'boolean', description: 'Pin this fact against automated deletion.' },
        force: { type: 'boolean', description: 'Force delete even when the entity holds pinned facts.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!entityApi) {
          return 'Entity cards module is not available.'
        }

        if (args.action === 'list') {
          const entities = entityApi.listEntities(config.home)
          if (entities.length === 0) return 'No entity cards saved yet.'
          return entities
            .map(e => `- ${e.name} [${e.slug}]${e.status === 'archived' ? ' [archived]' : ''} (${e.type}; aliases: ${e.aliases.join(', ') || 'none'}; facts: ${e.facts.length})`)
            .join('\n')
        }

        const name = args.name?.trim()
        if (!name) return `Please provide "name" for entity action "${args.action}".`

        if (args.action === 'read') {
          const entity = entityApi.readEntity(config.home, name)
          return entity ? entity.raw : `No entity card found matching "${name}".`
        }

        if (mode !== 'full') {
          return `Cannot modify entity cards while session mode is "${mode}".`
        }

        if (args.action === 'delete') {
          const res = await entityApi.deleteEntity(config.home, name, { force: args.force === true })
          if (!res.ok) return `Failed to delete entity "${name}": ${res.reason}.`
          return `Deleted entity card "${res.slug}".`
        }

        const latestUser = sessionId ? store.getLatestUserMessage(sessionId) : undefined
        const res = await entityApi.upsertEntity(config.home, {
          name,
          type: args.type,
          status: args.status,
          aliases: args.aliases,
          op: args.op ?? 'add',
          content: args.content,
          supersedesId: args.supersedesId,
          added: currentLogicalDate(),
          source: latestUser?.anchor ?? 'manual',
          pinned: args.pinned === true,
          allowPinned: true,
          blockPromptInjection: config.guard?.blockPromptInjection !== false,
        })
        if (!res.ok) {
          return `Failed to upsert entity "${name}": ${res.reason}${res.message ? ` (${res.message})` : ''}.`
        }
        return `Updated entity "${res.entity.name}" (${res.slug}, status=${res.entity.status ?? 'active'})${res.factId ? `, fact=${res.factId}` : ''}.`
      },
    }),

    defineMemoryTool({
      name: 'memory_lesson_manage',
      description: 'List, read, create/update, or delete procedural lesson/pitfall cards in lessons/ along with their tags and trigger keywords.',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'upsert', 'delete'], required: true, description: 'Operation on lesson cards.' },
        name: { type: 'string', description: 'Lesson card name or slug (required for read/upsert/delete).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Topic/domain tags (e.g. ["deploy", "nginx"]).' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'Keywords or phrases that automatically trigger dynamic context injection.' },
        content: { type: 'string', description: 'Lesson/pitfall content to add or replace.' },
        op: { type: 'string', enum: ['add', 'replace', 'retire'], description: 'Entry mutation operation on upsert (default "add").' },
        status: { type: 'string', enum: ['active', 'archived'], description: 'Lifecycle status ("archived" silences automatic recall while keeping search visibility).' },
        supersedesId: { type: 'string', description: 'Existing lesson entry id (e.g. les_01) to replace or retire.' },
        pinned: { type: 'boolean', description: 'Pin this entry against automated deletion.' },
        expires: { type: 'string', description: 'Optional expiration date (YYYY-MM-DD) for temporary operational caveats.' },
        force: { type: 'boolean', description: 'Force delete even when the lesson card holds pinned entries.' },
      },
      output: stringOutput,
      isConcurrencySafe: args => args?.action === 'list' || args?.action === 'read',
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!lessonApi) {
          return 'Lesson cards module is not available.'
        }

        if (args.action === 'list') {
          const lessons = lessonApi.listLessons(config.home)
          if (lessons.length === 0) return 'No lesson cards saved yet.'
          return lessons
            .map(l => `- ${l.name} [${l.slug}]${l.status === 'archived' ? ' [archived]' : ''} (tags: ${l.tags.join(', ') || 'none'}; triggers: ${l.triggers.join(', ') || 'none'}; entries: ${l.entries.length})`)
            .join('\n')
        }

        const name = args.name?.trim()
        if (!name) return `Please provide "name" for lesson action "${args.action}".`

        if (args.action === 'read') {
          const lesson = lessonApi.readLesson(config.home, name)
          return lesson ? lesson.raw : `No lesson card found matching "${name}".`
        }

        if (mode !== 'full') {
          return `Cannot modify lesson cards while session mode is "${mode}".`
        }

        if (args.action === 'delete') {
          const res = await lessonApi.deleteLesson(config.home, name, { force: args.force === true })
          if (!res.ok) return `Failed to delete lesson "${name}": ${res.reason}.`
          return `Deleted lesson card "${res.slug}".`
        }

        const latestUser = sessionId
          ? (store.getLatestUserOrCardMessage?.(sessionId) ?? store.getLatestUserMessage(sessionId))
          : undefined
        const res = await lessonApi.upsertLesson(config.home, {
          name,
          status: args.status,
          tags: args.tags,
          triggers: args.triggers,
          op: args.op ?? 'add',
          content: args.content,
          supersedesId: args.supersedesId,
          expires: args.expires?.trim() || undefined,
          added: currentLogicalDate(),
          source: latestUser?.anchor ?? 'manual',
          pinned: args.pinned === true,
          allowPinned: true,
          blockPromptInjection: config.guard?.blockPromptInjection !== false,
        })
        if (!res.ok) {
          return `Failed to upsert lesson "${name}": ${res.reason}${res.message ? ` (${res.message})` : ''}.`
        }
        if (res.duplicate) {
          return `Skipped duplicate lesson entry in "${res.lesson.name}" (${res.slug}), existing=${res.entryId}.`
        }
        return `Updated lesson "${res.lesson.name}" (${res.slug})${res.entryId ? `, entry=${res.entryId}` : ''}.`
      },
    }),

    defineMemoryTool({
      name: 'memory_onboarding',
      description: 'Inspect status, run interactive questionnaire, submit initial profile answers, skip, or reset cold-start profile onboarding.',
      parameters: {
        action: { type: 'string', enum: ['status', 'prompt', 'submit', 'skip', 'reset'], required: true, description: 'Onboarding operation to perform.' },
        identity: { type: 'string', description: 'User name/role and environment facts (for submit).' },
        preferences: { type: 'string', description: 'Communication and output style preferences (for submit).' },
        rules: { type: 'string', description: 'Long-term rules and hard boundaries (pinned by default on submit).' },
        entities: {
          type: 'array',
          description: 'Optional key people, projects, or servers to create entity cards for.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', description: 'Entity name.' },
              type: { type: 'string', description: 'Entity type (person, project, server, etc.).' },
              aliases: { type: 'array', items: { type: 'string' }, description: 'Trigger aliases.' },
              content: { type: 'string', description: 'Initial entity fact.' },
              pinned: { type: 'boolean', description: 'Pin initial fact.' },
            },
          },
        },
        entries: {
          type: 'array',
          description: 'Optional structured profile entries with explicit section/pinned flags.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              section: { type: 'string', description: 'Target PROFILE.md section.' },
              content: { type: 'string', required: true, description: 'Profile entry text.' },
              pinned: { type: 'boolean', description: 'Pin this entry.' },
            },
          },
        },
        writeMode: { type: 'string', enum: ['direct', 'buffer'], description: 'Write directly to PROFILE.md (pre-session) or to daily buffer (default in-session to protect Prefix Cache).' },
        forceDirect: { type: 'boolean', description: 'If true, allow direct PROFILE.md write even if today already has a session snapshot.' },
        reason: { type: 'string', description: 'Optional reason for submit/skip.' },
      },
      output: stringOutput,
      isConcurrencySafe: args => args?.action === 'status',
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!onboardingApi) {
          return 'Onboarding module is not available.'
        }
        const scope = sessionScopeOf(sessionId)

        if (args.action === 'status') {
          const state = onboardingApi.getState({ scope })
          return [
            `Onboarding status: ${state.status} (needsOnboarding=${state.needsOnboarding}, enabled=${state.enabled})`,
            `PROFILE.md entries: ${state.profileEntryCount}, estimated tokens: ${state.profileTokens}/${state.maxProfileTokens}`,
          ].join('\n')
        }

        if (mode !== 'full') {
          return `Cannot modify onboarding state while session mode is "${mode}".`
        }

        if (args.action === 'skip') {
          const res = onboardingApi.skip({ scope, reason: args.reason })
          return `Onboarding skipped for scope "${res.scope}". It will not prompt automatically again unless reset.`
        }

        if (args.action === 'reset') {
          const res = onboardingApi.reset({ scope })
          return `Onboarding reset to "${res.status}" for scope "${res.scope}".`
        }

        if (args.action === 'prompt') {
          const res = await onboardingApi.promptInteractive({
            agent: exec.agent,
            signal: exec.signal,
            scope,
            writeMode: args.writeMode,
          })
          if (!res.ok && res.reason === 'USER_QUESTIONS_UNAVAILABLE') {
            return [
              'Interactive userQuestions card is unavailable in this host. Ask the user concisely using your chat UI or text across these dimensions, then call memory_onboarding(action="submit") or memory_onboarding(action="skip"):',
              ...res.dimensions.map((d, idx) => `${idx + 1}. ${d.title} (${d.section}): ${d.question}`),
            ].join('\n')
          }
          if (res.skipped) {
            return 'User skipped interactive onboarding. Marked onboarding as skipped.'
          }
          if (!res.ok) {
            return `Onboarding prompt failed: ${res.reason}.`
          }
          return `Interactive onboarding saved (writeMode=${res.writeMode}, estimatedTokens=${res.estimatedProfileTokens}/${res.maxProfileTokens}).`
        }

        const res = await onboardingApi.submit({
          identity: args.identity,
          preferences: args.preferences,
          rules: args.rules,
          entities: args.entities,
          entries: args.entries,
          writeMode: args.writeMode,
          forceDirect: args.forceDirect === true,
          reason: args.reason,
          sessionId,
          scope,
        })
        if (!res.ok) {
          if (res.reason === 'PROFILE_BUDGET_EXCEEDED') {
            return `Onboarding rejected: PROFILE.md would reach ${res.estimatedTokens} tokens (max ${res.maxProfileTokens}). Please shorten entries and retry.`
          }
          return `Onboarding submit failed: ${res.reason}.`
        }
        const savedInfo = res.writeMode === 'direct'
          ? `committed ${res.committedProfileIds.length} profile entry(s) and ${res.committedEntitySlugs.length} entity card(s) directly`
          : `queued ${res.bufferedIds.length} explicit item(s) into today's buffer (preserving Prefix Cache)`
        return `Onboarding completed (${savedInfo}${res.downgradedForCache ? '; downgraded direct->buffer to preserve today snapshot' : ''}; estimated PROFILE tokens=${res.estimatedProfileTokens}/${res.maxProfileTokens}).`
      },
    }),

    defineMemoryTool({
      name: 'memory_briefing',
      description: 'Fetch daily morning briefing summary (yesterday journal highlights + pending buffer items), interactively or batch confirm/reject items, or dismiss today briefing.',
      parameters: {
        action: { type: 'string', enum: ['get', 'confirm', 'dismiss'], required: true, description: 'Briefing action.' },
        date: { type: 'string', description: 'Optional logical date (YYYY-MM-DD).' },
        approveIds: { type: 'array', items: { type: 'string' }, description: 'Buffer item IDs to approve.' },
        rejectIds: { type: 'array', items: { type: 'string' }, description: 'Buffer item IDs to reject.' },
        settleNow: { type: 'boolean', description: 'If true on confirm, immediately settle approved items into PROFILE.md/entities and refresh snapshots.' },
        interactive: { type: 'boolean', description: 'If true on confirm without explicit IDs, invoke host userQuestions multi-select card when available.' },
        reason: { type: 'string', description: 'Optional confirmation reason.' },
      },
      output: stringOutput,
      isConcurrencySafe: args => args?.action === 'get',
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!briefingApi) {
          return 'Briefing module is not available.'
        }
        const scope = sessionScopeOf(sessionId)

        if (args.action === 'get') {
          const briefing = briefingApi.getMorningBriefing({ date: args.date?.trim() || undefined, scope })
          return `${briefing.markdown}\n\n[alreadyDelivered=${briefing.alreadyDelivered}, pending=${briefing.buffer.totalPending}, approved=${briefing.buffer.totalApproved}]`
        }

        if (mode !== 'full') {
          return `Cannot modify briefing/buffer state while session mode is "${mode}".`
        }

        if (args.action === 'dismiss') {
          const res = briefingApi.markDelivered({ date: args.date?.trim() || undefined, scope, sessionId })
          return `Marked morning briefing delivered for ${res.date} (scope=${res.scope}).`
        }

        const hasExplicitIds = (Array.isArray(args.approveIds) && args.approveIds.length > 0)
          || (Array.isArray(args.rejectIds) && args.rejectIds.length > 0)

        if (args.interactive === true && !hasExplicitIds) {
          const res = await briefingApi.promptInteractiveConfirm({
            agent: exec.agent,
            signal: exec.signal,
            scope,
            settleNow: args.settleNow,
          })
          if (!res.ok && res.reason === 'USER_QUESTIONS_UNAVAILABLE') {
            return `${res.briefing.markdown}\n\nInteractive userQuestions unavailable; confirm manually via memory_briefing(action="confirm", approveIds=[...], rejectIds=[...]).`
          }
          if (res.pendingCount === 0) return res.message
          return `Briefing interactive confirmation complete: approved=${res.approved.length}, rejected=${res.rejected.length}${res.settlement ? `, settled=${res.settlement.committedCount}` : ''}.`
        }

        const res = await briefingApi.confirmItems({
          approveIds: args.approveIds,
          rejectIds: args.rejectIds,
          reason: args.reason,
          settleNow: args.settleNow === true,
          scope,
        })
        briefingApi.markDelivered({ date: args.date?.trim() || undefined, scope, sessionId })

        const warnings = [
          ...(res.settlement?.profile?.warnings ?? []),
          ...(res.settlement?.entity?.warnings ?? []),
          ...(res.settlement?.lesson?.warnings ?? []),
        ]
        return [
          `Morning briefing confirmed: approved=${res.approved.length} (${res.approved.join(', ') || 'none'}), rejected=${res.rejected.length} (${res.rejected.join(', ') || 'none'}).`,
          ...(res.settlement ? [`Immediate settlement committed ${res.settlement.committedCount} item(s).`] : []),
          ...(warnings.length > 0 ? [`Warnings: ${warnings.map(w => `${w.id}:${w.reason}`).join(', ')}`] : []),
        ].join(' ')
      },
    }),

    defineMemoryTool({
      name: 'memory_dream_now',
      description: 'Manually trigger M4 Dream background consolidation (rule + optional LLM pass) to queue dedup, expiry, or conflict proposals into buffer without silently mutating PROFILE.md.',
      parameters: {
        dryRun: { type: 'boolean', description: 'If true, preview proposals without writing to buffer or advancing Dream watermark.' },
        useLlm: { type: 'boolean', description: 'Whether to run semantic LLM pass alongside rules (defaults to config.dream.useLlm, which is false by default).' },
        scope: { type: 'string', description: 'Optional memory scope (default current session scope).' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode === 'off') {
          return 'Memory is disabled (mode=off) for this session.'
        }
        if (!dreamApi) {
          return 'Dream consolidation module is not available.'
        }
        const dryRun = args.dryRun === true
        if (!dryRun && mode !== 'full') {
          return `Cannot write Dream proposals while session mode is "${mode}".`
        }
        const scope = args.scope?.trim() || sessionScopeOf(sessionId)
        const res = await dreamApi.runDream({
          scope,
          dryRun,
          useLlm: typeof args.useLlm === 'boolean' ? args.useLlm : undefined,
          force: true,
          signal: exec.signal,
        })
        if (res.skipped) {
          return `Dream skipped: ${res.reason}.`
        }
        const header = [
          `Dream ${dryRun ? 'dry-run' : 'completed'} for ${res.todayDate} (scope=${res.scope}, llm=${res.llmStatus}${res.degraded ? ', degraded/watermark-held' : ''}):`,
          `Accepted proposals: ${res.proposals.length} (written=${res.writtenProposals.length}, profile cap=${res.maxProfileProposals} across ${res.nonPinnedCount} non-pinned entries).`,
        ]
        if (res.proposals.length > 0) {
          header.push(
            'Proposals:',
            ...res.proposals.map(p => `- [${p.channel} | ${p.op} -> ${p.target}${p.targetId ? `:${p.targetId}` : ''}] ${p.content} (${p.reason})`),
          )
        }
        if (res.diagnostics?.oversizedEntities?.length > 0) {
          header.push(`Oversized entity cards: ${res.diagnostics.oversizedEntities.join(', ')}`)
        }
        if (res.diagnostics?.oversizedLessons?.length > 0) {
          header.push(`Oversized lesson cards: ${res.diagnostics.oversizedLessons.join(', ')}`)
        }
        return header.join('\n')
      },
    }),

    defineMemoryTool({
      name: 'memory_rollback',
      description: 'Roll back a retired or replaced PROFILE.md entry by entryId using append-only retired.jsonl audit history, then invalidate prompt snapshots.',
      parameters: {
        entryId: { type: 'string', required: true, description: 'PROFILE.md entry id to restore (e.g. prof_01).' },
      },
      output: stringOutput,
      async execute(args, exec) {
        const sessionId = exec.agent?.id
        const mode = effectiveModeOf(sessionId)
        if (mode !== 'full') {
          return `Cannot rollback PROFILE.md while session mode is "${mode}".`
        }
        const entryId = args.entryId?.trim()
        if (!entryId) {
          return 'Please provide entryId to roll back.'
        }
        const res = await profileApi.rollbackProfileEntry(config.home, entryId, {
          maxTokens: config.sections.profile.maxTokens,
          nowIso: new Date(clock.now()).toISOString(),
        })
        if (!res.ok) {
          return `Rollback failed for "${entryId}": ${res.reason}.`
        }
        contextApi?.invalidateSnapshots?.()
        return `Rolled back profile entry ${res.restoredId}${res.retiredReplacementId ? ` (retired replacement ${res.retiredReplacementId})` : ''}. Estimated PROFILE.md tokens: ${res.estimatedTokens}/${config.sections.profile.maxTokens}.`
      },
    }),
  ]

  function isToolEnabledInContext(toolName, context) {
    if (context?.agent?.session?.header?.origin === 'subagent') {
      return SUBAGENT_READ_ONLY_TOOLS.has(toolName) || SUBAGENT_READ_ONLY_ACTIONS.has(toolName)
    }
    if ((config.tools?.profile ?? 'compact') === 'compact') {
      if (COMPACT_HIDDEN_ADMIN_TOOLS.has(toolName)) return false
      if (toolName === 'memory_onboarding') {
        const sessionId = context?.agent?.id
        const scope = sessionScopeOf(sessionId)
        return onboardingApi?.getState?.({ scope })?.needsOnboarding === true
      }
    }
    return true
  }

  function install() {
    for (const tool of tools) {
      ctx.effect(
        () => ctx.tools.register(tool, { when: context => isToolEnabledInContext(tool.name, context) }),
        `dsh-memory: tool ${tool.name}`,
      )
    }
  }

  return { install, tools, isToolEnabledInContext }
}
