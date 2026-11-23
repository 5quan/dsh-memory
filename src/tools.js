import { defineTool } from '@deepseek-ai/dsh-tools'
import { VALID_MEMORY_MODES } from './config.js'
import { clipText, logicalDateOf } from './util.js'

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export function createToolsApi({ ctx, config, store, bufferApi, journalApi, digestApi, contextApi, historyApi, entityApi, clock = { now: () => Date.now() } }) {
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
    defineTool({
      name: 'memory_search',
      description: 'Search historical conversation transcripts (FTS5 trigram + LIKE, with multi-term OR fallback ranked by coverage) and daily journals by keyword or date range. Omit query to browse recent archived messages by date range. Returns snippets with exact chat:// anchors.',
      parameters: {
        query: { type: 'string', description: 'Optional keywords or phrase to search. Omit to browse recent archived messages in the date range (defaults up to today).' },
        dateFrom: { type: 'string', description: 'Optional inclusive start date (YYYY-MM-DD).' },
        dateTo: { type: 'string', description: 'Optional inclusive end date (YYYY-MM-DD).' },
        scope: { type: 'string', description: 'Optional memory scope (default "default").' },
        limit: { type: 'integer', description: 'Maximum hits per source (default 10, max 50).' },
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

        if (msgHits.length === 0 && journalHits.length === 0) {
          return rawQuery
            ? `No memory matches found for "${rawQuery}".`
            : 'No archived messages found for the specified date range.'
        }

        const sections = []
        if (journalHits.length > 0) {
          sections.push(
            '### Journal Matches',
            ...journalHits.map(hit => `- [${hit.date}${hit.section ? ` · ${hit.section}` : ''}] ${hit.line}`),
          )
        }
        if (msgHits.length > 0) {
          sections.push(
            '### Archive Matches',
            ...msgHits.map(hit => `- [${hit.anchor}] (${hit.role}) ${clipText(hit.text, 300)}`),
          )
        }
        return sections.join('\n')
      },
    }),

    defineTool({
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

    defineTool({
      name: 'memory_buffer_add',
      description: 'Add a memory item or user correction to the daily append-only buffer (never mutates PROFILE.md mid-day). Anchors are bound automatically from the live user message.',
      parameters: {
        content: { type: 'string', required: true, description: 'Concise memory fact, preference, or correction to record.' },
        sourceType: { type: 'string', enum: ['explicit', 'correction', 'extracted'], required: true, description: 'Origin of this memory item.' },
        target: { type: 'string', description: 'Target store: "profile" (default), "note" (for today journal), or "entity:<name>".' },
        section: { type: 'string', description: 'Target section name in PROFILE.md (e.g. "沟通与工作偏好").' },
        op: { type: 'string', enum: ['add', 'replace', 'retire'], description: 'Operation type (default "add").' },
        supersedesId: { type: 'string', description: 'Existing PROFILE entry id to replace or retire.' },
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
        const latestUser = sessionId ? store.getLatestUserMessage(sessionId) : undefined
        const boundAnchor = latestUser?.anchor ?? null

        let effectiveSourceType = args.sourceType
        let downgradeNote = ''
        if (effectiveSourceType === 'explicit' && !boundAnchor) {
          effectiveSourceType = 'extracted'
          downgradeNote = ' (downgraded to "extracted" because no verified user message anchor exists in this session)'
        }

        const logicalDate = currentLogicalDate()
        const created = await bufferApi.appendCreate({
          logicalDate,
          scope,
          sourceType: effectiveSourceType,
          target: args.target ?? 'profile',
          op: args.op ?? 'add',
          section: args.section ?? '其他长期事实',
          content: args.content,
          supersedesId: args.supersedesId ?? null,
          anchor: boundAnchor,
          pinned: args.pinned === true,
        })

        return `Buffered item ${created.id} for ${logicalDate} (target=${created.target}, sourceType=${created.source_type}, anchor=${created.anchor ?? 'none'})${downgradeNote}.`
      },
    }),

    defineTool({
      name: 'memory_buffer_manage',
      description: 'List, approve, or reject pending items in the daily memory buffer so the user can review and choose what gets committed. Note: "approve" marks items ready for settlement at daily rollover (preserving today\'s frozen prefix cache); it does NOT immediately rewrite PROFILE.md unless memory_digest_now is run.',
      parameters: {
        action: { type: 'string', enum: ['list', 'approve', 'reject'], required: true, description: 'Action to run on buffer items.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Buffer item IDs for approve/reject.' },
        date: { type: 'string', description: 'Optional logical date filter (YYYY-MM-DD) for list.' },
        reason: { type: 'string', description: 'Optional reason recorded on status change.' },
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
        const nextStatus = args.action === 'approve' ? 'approved' : 'rejected'
        const updated = await bufferApi.updateStatuses(ids, nextStatus, {
          by: 'user',
          reason: args.reason,
        })
        if (updated.length === 0) {
          return 'No matching buffer items found.'
        }
        if (nextStatus === 'approved') {
          return `Updated ${updated.length} buffer item(s) to "approved": ${updated.join(', ')}. They will be settled into PROFILE.md/entities during daily rollover (or run memory_digest_now with today's date if immediate settlement is explicitly requested).`
        }
        return `Updated ${updated.length} buffer item(s) to "${nextStatus}": ${updated.join(', ')}`
      },
    }),

    defineTool({
      name: 'memory_mode_set',
      description: 'Switch memory/incognito mode ("full", "read-only", or "off") for the current session or global default.',
      parameters: {
        mode: { type: 'string', enum: ['full', 'read-only', 'off'], required: true, description: 'Target memory mode.' },
        scope: { type: 'string', enum: ['session', 'global'], description: 'Apply to current "session" (default) or "global" defaultMode.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        if (!VALID_MEMORY_MODES.has(args.mode)) {
          return `Invalid mode "${args.mode}". Use full, read-only, or off.`
        }
        const targetScope = args.scope ?? 'session'
        if (targetScope === 'global') {
          config.defaultMode = args.mode
          contextApi.invalidateSnapshots()
          return `Global default memory mode set to "${args.mode}".`
        }
        const sessionId = exec.agent?.id
        if (!sessionId) {
          return 'No active session id available for session-scoped mode change.'
        }
        store.setSessionMode(sessionId, args.mode, clock.now())
        if (args.mode === 'off') {
          contextApi.invalidateSnapshots({ sessionId })
        }
        return `Session ${sessionId} memory mode set to "${args.mode}".`
      },
    }),

    defineTool({
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
        const allWarnings = [...res.profileSettlement.warnings, ...(res.entitySettlement?.warnings ?? [])]
        return [
          `Generated journal for ${targetDate} (${res.chunks} chunk(s)): ${res.path}`,
          `Notes closed: ${res.closedNotes.length}, Profile committed: ${res.profileSettlement.committed.length}, Deferred: ${res.profileSettlement.deferred.length}${entityCountText}`,
          ...(res.unverifiedAnchors.length > 0 ? [`Stripped unverified anchors: ${res.unverifiedAnchors.join(', ')}`] : []),
          ...(allWarnings.length > 0
            ? [`Warnings: ${allWarnings.map(w => `${w.id}:${w.reason}`).join(', ')}`]
            : []),
        ].join('\n')
      },
    }),

    defineTool({
      name: 'memory_forget',
      description: 'Actively forget memories requested by the user: permanently deletes matching messages from archive and FTS5, rejects matching buffer items, redacts matching lines in daily journals, entities, and history index, and invalidates snapshots.',
      parameters: {
        anchor: { type: 'string', description: 'Exact chat:// anchor to forget.' },
        date: { type: 'string', description: 'Optional logical date filter (YYYY-MM-DD).' },
        keyword: { type: 'string', description: 'Optional substring/keyword to forget.' },
        sessionId: { type: 'string', description: 'Optional session id filter.' },
      },
      output: stringOutput,
      async execute(args, exec) {
        if (!args.anchor && !args.date && !args.keyword && !args.sessionId) {
          return 'Refusing empty forget request: provide at least one of anchor, date, keyword, or sessionId.'
        }
        const callerSessionId = exec.agent?.id
        const scope = sessionScopeOf(callerSessionId)
        const todayDate = currentLogicalDate()

        const deleted = store.deleteMessages({
          anchor: args.anchor?.trim() || undefined,
          date: args.date?.trim() || undefined,
          keyword: args.keyword?.trim() || undefined,
          sessionId: args.sessionId?.trim() || undefined,
          scope,
        })

        const anchorsToReject = [...deleted.deletedAnchors, ...(args.anchor ? [args.anchor.trim()] : [])]
        const rejectedBufferIds = await bufferApi.rejectByAnchors(anchorsToReject, {
          by: 'user',
          reason: 'memory_forget',
        })

        const redactedJournals = await journalApi.redactJournalForForget(config.home, {
          date: args.date?.trim() || undefined,
          anchors: anchorsToReject,
          keyword: args.keyword?.trim() || undefined,
          sessionId: args.sessionId?.trim() || undefined,
          todayDate,
        })

        const redactedEntities = entityApi
          ? await entityApi.redactEntitiesForForget(config.home, {
            anchors: anchorsToReject,
            keyword: args.keyword?.trim() || undefined,
            todayDate,
          })
          : { updatedEntities: [] }

        const redactedHistory = historyApi
          ? await historyApi.redactHistoryForForget({
            anchors: anchorsToReject,
            keyword: args.keyword?.trim() || undefined,
            affectedDates: [...new Set([...deleted.affectedDates, ...redactedJournals])],
            todayDate,
          })
          : { updatedMonths: [] }

        contextApi.invalidateSnapshots()

        return [
          `Forgot ${deleted.deletedCount} archived message(s).`,
          `Rejected ${rejectedBufferIds.length} buffer item(s).`,
          `Redacted ${redactedJournals.length} daily journal(s)${redactedJournals.length > 0 ? `: ${redactedJournals.join(', ')}` : ''}.`,
          `Redacted ${redactedEntities.updatedEntities.length} entity card(s)${redactedEntities.updatedEntities.length > 0 ? `: ${redactedEntities.updatedEntities.join(', ')}` : ''}.`,
          `Redacted ${redactedHistory.updatedMonths.length} history month(s)${redactedHistory.updatedMonths.length > 0 ? `: ${redactedHistory.updatedMonths.join(', ')}` : ''}.`,
        ].join(' ')
      },
    }),

    defineTool({
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

    defineTool({
      name: 'memory_entity_manage',
      description: 'List, read, create/update, or delete entity memory cards (people, projects, servers) and their alias triggers.',
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'upsert', 'delete'], required: true, description: 'Operation on entity cards.' },
        name: { type: 'string', description: 'Entity name, alias, or slug (required for read/upsert/delete).' },
        type: { type: 'string', description: 'Entity type (e.g. person, project, server, tool).' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Aliases that automatically trigger dynamic context injection.' },
        content: { type: 'string', description: 'Fact content to add or replace.' },
        op: { type: 'string', enum: ['add', 'replace', 'retire'], description: 'Fact mutation operation on upsert (default "add").' },
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
            .map(e => `- ${e.name} [${e.slug}] (${e.type}; aliases: ${e.aliases.join(', ') || 'none'}; facts: ${e.facts.length})`)
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
          aliases: args.aliases,
          op: args.op ?? 'add',
          content: args.content,
          supersedesId: args.supersedesId,
          added: currentLogicalDate(),
          source: latestUser?.anchor ?? 'manual',
          pinned: args.pinned === true,
          allowPinned: true,
        })
        if (!res.ok) {
          return `Failed to upsert entity "${name}": ${res.reason}.`
        }
        return `Updated entity "${res.entity.name}" (${res.slug})${res.factId ? `, fact=${res.factId}` : ''}.`
      },
    }),
  ]

  function install() {
    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), `dsh-memory: tool ${tool.name}`)
    }
  }

  return { install, tools }
}
