import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkDuplicateContent, detectPromptInjection, detectSecret, MemoryGuardError } from './guard.js'
import * as defaultProfileApi from './profile.js'
import { mergeUniqueTerms } from './util.js'

export const BUFFER_DIR = 'buffer'
export const VALID_TARGETS = ['profile', 'note']

export function bufferDir(home) {
  return join(home, BUFFER_DIR)
}

export function bufferFilePath(home, logicalDate) {
  return join(bufferDir(home), `${logicalDate}.jsonl`)
}

export function isValidTarget(target) {
  return (
    target === 'profile'
    || target === 'note'
    || (typeof target === 'string' && target.startsWith('entity:') && target.slice('entity:'.length).trim().length > 0)
    || (typeof target === 'string' && target.startsWith('lesson:') && target.slice('lesson:'.length).trim().length > 0)
  )
}

export function createBufferApi({ home, config, profileApi = defaultProfileApi, lessonApi, clock = { now: () => Date.now() } }) {
  let writeChain = Promise.resolve()

  const queued = (task) => {
    const run = writeChain.then(task)
    writeChain = run.catch(() => {})
    return run
  }

  function listBufferFiles() {
    const dir = bufferDir(home)
    try {
      return readdirSync(dir)
        .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .sort()
        .map(name => ({ logicalDate: name.slice(0, 10), path: join(dir, name) }))
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  function foldFile(filePath, byId) {
    let raw = ''
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let evt
      try {
        evt = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!evt || typeof evt !== 'object' || typeof evt.id !== 'string') continue
      if (evt.event === 'create') {
        byId.set(evt.id, {
          id: evt.id,
          logical_date: evt.logical_date,
          created_at: evt.created_at,
          scope: evt.scope ?? 'default',
          source_type: evt.source_type ?? 'extracted',
          target: evt.target ?? 'profile',
          op: evt.op ?? 'add',
          section: evt.section ?? '其他长期事实',
          content: String(evt.content ?? ''),
          supersedes_id: evt.supersedes_id ?? null,
          anchor: evt.anchor ?? null,
          pinned: evt.pinned === true,
          ...(typeof evt.content_hash === 'string' && evt.content_hash !== '' ? { content_hash: evt.content_hash } : {}),
          ...(typeof evt.expires === 'string' && evt.expires !== '' ? { expires: evt.expires } : {}),
          ...(Array.isArray(evt.tags) && evt.tags.length > 0 ? { tags: evt.tags } : {}),
          ...(Array.isArray(evt.triggers) && evt.triggers.length > 0 ? { triggers: evt.triggers } : {}),
          ...(typeof evt.dream_key === 'string' && evt.dream_key !== '' ? { dream_key: evt.dream_key } : {}),
          ...(typeof evt.reason === 'string' && evt.reason !== '' ? { reason: evt.reason } : {}),
          ...(evt.conflict === true ? { conflict: true } : {}),
          ...(typeof evt.producer === 'string' && evt.producer !== '' ? { producer: evt.producer } : {}),
          status: evt.status ?? 'pending',
          history: [evt],
        })
      } else if (evt.event === 'status') {
        const existing = byId.get(evt.id)
        if (!existing) continue
        if (typeof evt.status === 'string') existing.status = evt.status
        if (typeof evt.source_type === 'string') existing.source_type = evt.source_type
        if (typeof evt.reason === 'string') existing.last_reason = evt.reason
        if (typeof evt.at === 'string') existing.updated_at = evt.at
        existing.history.push(evt)
      }
    }
  }

  function loadFoldedMap(logicalDate) {
    const byId = new Map()
    if (logicalDate) {
      foldFile(bufferFilePath(home, logicalDate), byId)
    } else {
      for (const file of listBufferFiles()) {
        foldFile(file.path, byId)
      }
    }
    return byId
  }

  async function appendRawEvent(logicalDate, payload) {
    const filePath = bufferFilePath(home, logicalDate)
    await mkdir(bufferDir(home), { recursive: true })
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8')
    return payload
  }

  function listItems({ scope, statuses, logicalDate, target } = {}) {
    const all = [...loadFoldedMap(logicalDate).values()]
    return all.filter((item) => {
      if (scope && item.scope !== scope) return false
      if (Array.isArray(statuses) && statuses.length > 0 && !statuses.includes(item.status)) return false
      if (target && item.target !== target) return false
      return true
    })
  }

  function appendCreate(input) {
    const content = String(input.content ?? '').trim()
    if (content === '') return Promise.reject(new Error('appendCreate requires non-empty content'))
    const secret = detectSecret(content)
    if (secret.detected) {
      return Promise.reject(new MemoryGuardError(secret.code, secret.message, { kind: secret.kind }))
    }
    if (config?.guard?.blockPromptInjection !== false) {
      const inj = detectPromptInjection(content)
      if (inj.detected) {
        return Promise.reject(new MemoryGuardError(inj.code, inj.message, { kind: inj.kind }))
      }
    }

    return queued(async () => {
      const logicalDate = input.logicalDate || input.logical_date
      if (!logicalDate) throw new Error('appendCreate requires logicalDate')
      const target = input.target ?? 'profile'
      if (!isValidTarget(target)) throw new Error(`Invalid buffer target: ${target}`)

      const scope = input.scope ?? 'default'
      const op = input.op ?? 'add'
      const section = input.section || '其他长期事实'
      const activeItems = [...loadFoldedMap().values()]
      const profileEntries = target === 'profile' && profileApi
        ? profileApi.parseProfileEntries(profileApi.readProfile(home))
        : []
      const lessonEntries = target.startsWith('lesson:') && lessonApi
        ? (lessonApi.readLesson(home, target.slice('lesson:'.length).trim())?.entries ?? [])
        : []
      const dup = checkDuplicateContent({
        content,
        scope,
        target,
        section,
        op,
        bufferItems: activeItems,
        profileEntries,
        lessonEntries,
      })
      if (dup.duplicate && input.allowDuplicate !== true) {
        return {
          ...(dup.existingItem ?? {}),
          id: dup.existingId,
          logical_date: dup.existingItem?.logical_date ?? logicalDate,
          scope,
          source_type: dup.existingItem?.source_type ?? (input.sourceType ?? input.source_type ?? 'extracted'),
          target,
          op,
          section,
          content: dup.existingItem?.content ?? dup.existingEntry?.content ?? content,
          content_hash: dup.contentHash,
          duplicate: true,
          skipped: true,
          duplicateIn: dup.duplicateIn,
        }
      }

      const id = input.id || `buf_${logicalDate.replaceAll('-', '')}_${randomUUID().slice(0, 8)}`
      const tags = mergeUniqueTerms([], Array.isArray(input.tags) ? input.tags : [])
      const triggers = mergeUniqueTerms([], Array.isArray(input.triggers) ? input.triggers : [])
      const event = {
        event: 'create',
        id,
        logical_date: logicalDate,
        created_at: input.createdAt || new Date(clock.now()).toISOString(),
        scope,
        source_type: input.sourceType ?? input.source_type ?? 'extracted',
        target,
        op,
        section,
        content,
        ...(dup.contentHash ? { content_hash: dup.contentHash } : {}),
        supersedes_id: input.supersedesId ?? input.supersedes_id ?? null,
        anchor: input.anchor ?? null,
        pinned: input.pinned === true,
        ...(tags.length > 0 ? { tags } : {}),
        ...(triggers.length > 0 ? { triggers } : {}),
        ...(typeof input.expires === 'string' && input.expires.trim() !== '' ? { expires: input.expires.trim() } : {}),
        ...(typeof input.dreamKey === 'string' && input.dreamKey.trim() !== '' ? { dream_key: input.dreamKey.trim() } : {}),
        ...(typeof input.reason === 'string' && input.reason.trim() !== '' ? { reason: input.reason.trim() } : {}),
        ...(input.conflict === true ? { conflict: true } : {}),
        ...(typeof input.producer === 'string' && input.producer.trim() !== '' ? { producer: input.producer.trim() } : {}),
      }
      await appendRawEvent(logicalDate, event)
      return { ...event, status: 'pending' }
    })
  }

  function hasAnchor(anchor, { scope, logicalDate } = {}) {
    if (!anchor) return false
    const items = [...loadFoldedMap(logicalDate).values()]
    return items.some((item) => {
      if (scope && item.scope !== scope) return false
      if (item.status === 'rejected') return false
      return item.anchor === anchor
    })
  }

  function flush() {
    return writeChain
  }

  function appendStatus({ id, logicalDate, status, at, by = 'system', reason, sourceType }) {
    return queued(async () => {
      const date = logicalDate || loadFoldedMap().get(id)?.logical_date
      if (!date) throw new Error(`Buffer item not found: ${id}`)
      const payload = {
        event: 'status',
        id,
        status,
        at: at || new Date(clock.now()).toISOString(),
        by,
        ...(reason ? { reason } : {}),
        ...(sourceType ? { source_type: sourceType } : {}),
      }
      await appendRawEvent(date, payload)
      return payload
    })
  }

  function updateStatuses(ids, status, { by = 'user', reason } = {}) {
    return queued(async () => {
      const idSet = new Set(ids)
      const items = [...loadFoldedMap().values()].filter(item => idSet.has(item.id))
      const at = new Date(clock.now()).toISOString()
      const updated = []
      for (const item of items) {
        await appendRawEvent(item.logical_date, {
          event: 'status',
          id: item.id,
          status,
          at,
          by,
          ...(reason ? { reason } : {}),
        })
        updated.push(item.id)
      }
      return updated
    })
  }

  function rejectByAnchors(anchors, { by = 'user', reason = 'memory_forget' } = {}) {
    const anchorSet = new Set((anchors ?? []).filter(Boolean))
    if (anchorSet.size === 0) return Promise.resolve([])
    return rejectForForget({ anchors: [...anchorSet], by, reason })
  }

  function rejectForForget({ anchors = [], keyword, date, scope, by = 'user', reason = 'memory_forget' } = {}) {
    const anchorSet = new Set((anchors ?? []).filter(Boolean))
    const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
    const forgetWholeDate = Boolean(date) && anchorSet.size === 0 && lowerKeyword === undefined
    if (anchorSet.size === 0 && lowerKeyword === undefined && !forgetWholeDate) {
      return Promise.resolve([])
    }
    return queued(async () => {
      const active = [...loadFoldedMap().values()].filter((item) => {
        if (item.status !== 'pending' && item.status !== 'approved') return false
        if (scope && item.scope !== scope) return false
        const hitAnchor = Boolean(item.anchor && anchorSet.has(item.anchor))
        const hitKeyword = lowerKeyword !== undefined && item.content.toLowerCase().includes(lowerKeyword)
        const hitDate = forgetWholeDate && item.logical_date === date
        return hitAnchor || hitKeyword || hitDate
      })
      const at = new Date(clock.now()).toISOString()
      const rejected = []
      for (const item of active) {
        await appendRawEvent(item.logical_date, {
          event: 'status',
          id: item.id,
          status: 'rejected',
          at,
          by,
          reason,
        })
        rejected.push(item.id)
      }
      return rejected
    })
  }

  function settleWithGate({ logicalDate, scope = 'default', store, config, filter, resolveOverwrite, applyItem }) {
    return queued(async () => {
      const items = [...loadFoldedMap(logicalDate).values()].filter(
        item => item.scope === scope && (item.status === 'pending' || item.status === 'approved') && filter(item),
      )
      const committed = []
      const warnings = []
      const deferred = []
      const at = new Date(clock.now()).toISOString()
      const autoSources = new Set(config.buffer.autoCommitSources)

      for (const item of items) {
        let effectiveSource = item.source_type
        if (item.status === 'pending' && (effectiveSource === 'explicit' || effectiveSource === 'correction')) {
          const msg = item.anchor ? store.getMessageByAnchor(item.anchor) : undefined
          const isValidHumanAnchor = Boolean(msg && (msg.role === 'user' || msg.role === 'card'))
          if (!isValidHumanAnchor) {
            const originalSource = effectiveSource
            effectiveSource = 'extracted'
            const reasonCode = originalSource === 'correction' ? 'CORRECTION_ANCHOR_INVALID' : 'EXPLICIT_ANCHOR_INVALID'
            await appendRawEvent(logicalDate, {
              event: 'status',
              id: item.id,
              status: 'pending',
              source_type: 'extracted',
              at,
              by: 'system',
              reason: `${originalSource} anchor verification failed; downgraded to extracted`,
            })
            warnings.push({ id: item.id, reason: reasonCode })
            deferred.push(item.id)
            continue
          }
        }

        const isOverwrite = resolveOverwrite(item)
        if (item.status !== 'approved') {
          if (!autoSources.has(effectiveSource)) {
            deferred.push(item.id)
            continue
          }
          if (config.buffer.requireConfirmOnOverwrite && isOverwrite) {
            deferred.push(item.id)
            continue
          }
        }

        const result = await applyItem(item, effectiveSource)
        if (!result.ok) {
          warnings.push({ id: item.id, ...result })
          deferred.push(item.id)
          continue
        }

        await appendRawEvent(logicalDate, {
          event: 'status',
          id: item.id,
          status: 'committed',
          at,
          by: item.status === 'approved' ? 'user-approved' : 'auto-commit',
          reason: result.commitReason,
        })
        committed.push(item.id)
      }

      return { committed, deferred, warnings }
    })
  }

  function settleProfileForDate({ logicalDate, scope = 'default', store, profileApi, config }) {
    return settleWithGate({
      logicalDate,
      scope,
      store,
      config,
      filter: item => item.target === 'profile',
      resolveOverwrite: (item) => {
        const existingEntries = profileApi.parseProfileEntries(profileApi.readProfile(config.home))
        const targetEntry = item.supersedes_id ? existingEntries.find(e => e.id === item.supersedes_id) : undefined
        return item.op !== 'add' || Boolean(item.supersedes_id) || Boolean(targetEntry?.pinned)
      },
      applyItem: async (item, effectiveSource) => {
        const result = await profileApi.applyProfileMutation(
          config.home,
          {
            op: item.op,
            section: item.section,
            content: item.content,
            targetId: item.supersedes_id,
            supersedesId: item.supersedes_id,
            added: item.logical_date,
            source: item.anchor || effectiveSource,
            ...(item.expires ? { expires: item.expires } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
            pinned: item.pinned,
          },
          {
            maxTokens: config.sections.profile.maxTokens,
            allowPinned: item.status === 'approved',
            nowIso: new Date(clock.now()).toISOString(),
          },
        )
        return result.ok ? { ...result, commitReason: `committed to PROFILE.md (${result.id})` } : result
      },
    })
  }

  function settleEntitiesForDate({ logicalDate, scope = 'default', store, entityApi, config }) {
    return settleWithGate({
      logicalDate,
      scope,
      store,
      config,
      filter: item => typeof item.target === 'string' && item.target.startsWith('entity:'),
      resolveOverwrite: (item) => {
        const entityName = item.target.slice('entity:'.length).trim()
        const existing = entityApi.readEntity(config.home, entityName)
        const targetFact = item.supersedes_id ? existing?.facts.find(f => f.id === item.supersedes_id) : undefined
        return item.op !== 'add' || Boolean(item.supersedes_id) || Boolean(targetFact?.pinned)
      },
      applyItem: async (item, effectiveSource) => {
        const entityName = item.target.slice('entity:'.length).trim()
        const result = await entityApi.upsertEntity(config.home, {
          name: entityName,
          op: item.op,
          content: item.content,
          targetId: item.supersedes_id,
          supersedesId: item.supersedes_id,
          added: item.logical_date,
          source: item.anchor || effectiveSource,
          pinned: item.pinned,
          allowPinned: item.status === 'approved',
        })
        return result.ok
          ? { ...result, commitReason: `committed to entities/${result.slug}.md (${result.factId ?? 'card'})` }
          : result
      },
    })
  }

  function settleLessonsForDate({ logicalDate, scope = 'default', store, lessonApi, config }) {
    return settleWithGate({
      logicalDate,
      scope,
      store,
      config,
      filter: item => typeof item.target === 'string' && item.target.startsWith('lesson:'),
      resolveOverwrite: (item) => {
        const lessonName = item.target.slice('lesson:'.length).trim()
        const existing = lessonApi.readLesson(config.home, lessonName)
        const targetEntry = item.supersedes_id ? existing?.entries.find(e => e.id === item.supersedes_id) : undefined
        return item.op !== 'add' || Boolean(item.supersedes_id) || Boolean(targetEntry?.pinned)
      },
      applyItem: async (item, effectiveSource) => {
        const lessonName = item.target.slice('lesson:'.length).trim()
        const result = await lessonApi.upsertLesson(config.home, {
          name: lessonName,
          tags: item.tags,
          triggers: item.triggers,
          op: item.op,
          content: item.content,
          targetId: item.supersedes_id,
          supersedesId: item.supersedes_id,
          added: item.logical_date,
          source: item.anchor || effectiveSource,
          ...(item.expires ? { expires: item.expires } : {}),
          pinned: item.pinned,
          allowPinned: item.status === 'approved',
        })
        return result.ok
          ? { ...result, commitReason: `committed to lessons/${result.slug}.md (${result.entryId ?? 'card'})` }
          : result
      },
    })
  }

  function closeNotesForDate({ logicalDate, scope = 'default' }) {
    return queued(async () => {
      const notes = [...loadFoldedMap(logicalDate).values()].filter(
        item => item.scope === scope && item.target === 'note' && (item.status === 'pending' || item.status === 'approved'),
      )
      const at = new Date(clock.now()).toISOString()
      const closed = []
      for (const item of notes) {
        await appendRawEvent(logicalDate, {
          event: 'status',
          id: item.id,
          status: 'committed',
          at,
          by: 'system',
          reason: 'archived to daily journal',
        })
        closed.push(item.id)
      }
      return closed
    })
  }

  async function settleDates({ dates = [], scope = 'default', store, profileApi, entityApi, lessonApi, config }) {
    const uniqueDates = [...new Set(dates.filter(Boolean))].sort()
    const profile = { committed: [], deferred: [], warnings: [] }
    const entity = { committed: [], deferred: [], warnings: [] }
    const lesson = { committed: [], deferred: [], warnings: [] }

    for (const logicalDate of uniqueDates) {
      if (profileApi) {
        const pRes = await settleProfileForDate({ logicalDate, scope, store, profileApi, config })
        profile.committed.push(...pRes.committed)
        profile.deferred.push(...pRes.deferred)
        profile.warnings.push(...pRes.warnings)
      }
      if (entityApi) {
        const eRes = await settleEntitiesForDate({ logicalDate, scope, store, entityApi, config })
        entity.committed.push(...eRes.committed)
        entity.deferred.push(...eRes.deferred)
        entity.warnings.push(...eRes.warnings)
      }
      if (lessonApi) {
        const lRes = await settleLessonsForDate({ logicalDate, scope, store, lessonApi, config })
        lesson.committed.push(...lRes.committed)
        lesson.deferred.push(...lRes.deferred)
        lesson.warnings.push(...lRes.warnings)
      }
    }

    return {
      dates: uniqueDates,
      profile,
      entity,
      lesson,
      committedCount: profile.committed.length + entity.committed.length + lesson.committed.length,
    }
  }

  return {
    listItems,
    hasAnchor,
    flush,
    appendCreate,
    appendStatus,
    updateStatuses,
    rejectByAnchors,
    rejectForForget,
    settleProfileForDate,
    settleEntitiesForDate,
    settleLessonsForDate,
    settleDates,
    closeNotesForDate,
  }
}
