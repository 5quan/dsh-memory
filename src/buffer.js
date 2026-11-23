import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const BUFFER_DIR = 'buffer'
export const VALID_TARGETS = ['profile', 'note']

export function bufferDir(home) {
  return join(home, BUFFER_DIR)
}

export function bufferFilePath(home, logicalDate) {
  return join(bufferDir(home), `${logicalDate}.jsonl`)
}

export function isValidTarget(target) {
  return target === 'profile' || target === 'note' || (typeof target === 'string' && target.startsWith('entity:') && target.length > 7)
}

export function createBufferApi({ home, clock = { now: () => Date.now() } }) {
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
    return queued(async () => {
      const logicalDate = input.logicalDate || input.logical_date
      if (!logicalDate) throw new Error('appendCreate requires logicalDate')
      const content = String(input.content ?? '').trim()
      if (content === '') throw new Error('appendCreate requires non-empty content')
      const target = input.target ?? 'profile'
      if (!isValidTarget(target)) throw new Error(`Invalid buffer target: ${target}`)

      const id = input.id || `buf_${logicalDate.replaceAll('-', '')}_${randomUUID().slice(0, 8)}`
      const event = {
        event: 'create',
        id,
        logical_date: logicalDate,
        created_at: input.createdAt || new Date(clock.now()).toISOString(),
        scope: input.scope ?? 'default',
        source_type: input.sourceType ?? input.source_type ?? 'extracted',
        target,
        op: input.op ?? 'add',
        section: input.section || '其他长期事实',
        content,
        supersedes_id: input.supersedesId ?? input.supersedes_id ?? null,
        anchor: input.anchor ?? null,
        pinned: input.pinned === true,
      }
      await appendRawEvent(logicalDate, event)
      return { ...event, status: 'pending' }
    })
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
    return queued(async () => {
      const active = [...loadFoldedMap().values()].filter(
        item => (item.status === 'pending' || item.status === 'approved') && item.anchor && anchorSet.has(item.anchor),
      )
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

  function settleProfileForDate({ logicalDate, scope = 'default', store, profileApi, config }) {
    return queued(async () => {
      const items = [...loadFoldedMap(logicalDate).values()].filter(
        item => item.scope === scope && item.target === 'profile' && (item.status === 'pending' || item.status === 'approved'),
      )
      const committed = []
      const warnings = []
      const deferred = []
      const at = new Date(clock.now()).toISOString()
      const autoSources = new Set(config.buffer.autoCommitSources)

      for (const item of items) {
        let effectiveSource = item.source_type
        if (item.status === 'pending' && effectiveSource === 'explicit') {
          const msg = item.anchor ? store.getMessageByAnchor(item.anchor) : undefined
          if (!msg || msg.role !== 'user') {
            effectiveSource = 'extracted'
            await appendRawEvent(logicalDate, {
              event: 'status',
              id: item.id,
              status: 'pending',
              source_type: 'extracted',
              at,
              by: 'system',
              reason: 'explicit anchor verification failed; downgraded to extracted',
            })
            warnings.push({ id: item.id, reason: 'EXPLICIT_ANCHOR_INVALID' })
            deferred.push(item.id)
            continue
          }
        }

        const existingEntries = profileApi.parseProfileEntries(profileApi.readProfile(config.home))
        const targetEntry = item.supersedes_id ? existingEntries.find(e => e.id === item.supersedes_id) : undefined
        const isOverwrite = item.op !== 'add' || Boolean(item.supersedes_id) || Boolean(targetEntry?.pinned)

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
            pinned: item.pinned,
          },
          {
            maxTokens: config.sections.profile.maxTokens,
            allowPinned: item.status === 'approved',
          },
        )

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
          reason: `committed to PROFILE.md (${result.id})`,
        })
        committed.push(item.id)
      }

      return { committed, deferred, warnings }
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

  return {
    listItems,
    appendCreate,
    appendStatus,
    updateStatuses,
    rejectByAnchors,
    settleProfileForDate,
    closeNotesForDate,
  }
}
