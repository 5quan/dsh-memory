import { readFileSync, rmSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteFile, estimateTokens } from './util.js'

export const PROFILE_FILENAME = 'PROFILE.md'
export const RETIRED_FILENAME = 'retired.jsonl'
const DEFAULT_HEADER = '# 核心画像（Profile）'
const DEFAULT_SECTION = '其他长期事实'
const META_RE = /\s*`\[([^\]]+)\]`\s*$/

export function profilePath(home) {
  return join(home, PROFILE_FILENAME)
}

export function retiredPath(home) {
  return join(home, RETIRED_FILENAME)
}

export function readProfile(home) {
  try {
    return readFileSync(profilePath(home), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export function parseMetaParts(rawMeta) {
  const parts = String(rawMeta ?? '').split(';').map(item => item.trim()).filter(Boolean)
  const meta = { pinned: false }
  for (const part of parts) {
    if (part === 'pinned') {
      meta.pinned = true
      continue
    }
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) meta[key] = val
  }
  return meta
}

export function formatProfileMeta(meta) {
  const fields = []
  if (meta.id) fields.push(`id: ${meta.id}`)
  if (meta.added) fields.push(`added: ${meta.added}`)
  if (meta.source) fields.push(`source: ${meta.source}`)
  if (meta.supersedes) fields.push(`supersedes: ${meta.supersedes}`)
  if (meta.expires) fields.push(`expires: ${meta.expires}`)
  if (meta.pinned) fields.push('pinned')
  return fields.length > 0 ? ` \`[${fields.join('; ')}]\`` : ''
}

export function parseProfileEntries(raw) {
  const lines = String(raw ?? '').split(/\r?\n/)
  const entries = []
  let currentSection = DEFAULT_SECTION

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      currentSection = heading[1]
      continue
    }
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line)
    if (!bullet) continue
    const body = bullet[1]
    const metaMatch = META_RE.exec(body)
    const meta = metaMatch ? parseMetaParts(metaMatch[1]) : { pinned: false }
    const content = metaMatch ? body.slice(0, metaMatch.index).trim() : body.trim()
    entries.push({
      lineIndex: i,
      section: currentSection,
      content,
      id: meta.id,
      added: meta.added,
      source: meta.source,
      supersedes: meta.supersedes,
      expires: meta.expires,
      pinned: meta.pinned === true,
      meta,
      rawLine: line,
    })
  }
  return entries
}

function nextProfileId(entries) {
  let maxNum = 0
  for (const entry of entries) {
    const m = /^prof_(\d+)$/.exec(entry.id ?? '')
    if (m) maxNum = Math.max(maxNum, Number(m[1]))
  }
  return `prof_${String(maxNum + 1).padStart(2, '0')}`
}

function insertLineInSection(lines, sectionTitle, formattedLine) {
  const result = lines.length === 1 && lines[0] === '' ? [DEFAULT_HEADER] : [...lines]
  if (result.length === 0 || !/^#\s+/.test(result[0])) {
    result.unshift(DEFAULT_HEADER, '')
  }

  const targetHeader = `## ${sectionTitle}`
  const headerIndex = result.findIndex(line => line.trim() === targetHeader)
  if (headerIndex === -1) {
    if (result.length > 0 && result.at(-1).trim() !== '') result.push('')
    result.push(targetHeader, formattedLine)
    return result
  }

  let insertAt = result.length
  for (let i = headerIndex + 1; i < result.length; i += 1) {
    if (/^##\s+/.test(result[i])) {
      insertAt = i
      while (insertAt > headerIndex + 1 && result[insertAt - 1].trim() === '') {
        insertAt -= 1
      }
      break
    }
  }
  result.splice(insertAt, 0, formattedLine)
  return result
}

export function planProfileMutation(currentRaw, mutation, { maxTokens = 2000, allowPinned = false } = {}) {
  const entries = parseProfileEntries(currentRaw)
  const lines = currentRaw === '' ? [] : currentRaw.split(/\r?\n/)
  const op = mutation.op ?? 'add'

  if (op === 'add') {
    const section = (mutation.section || DEFAULT_SECTION).trim()
    const id = mutation.id || nextProfileId(entries)
    const meta = {
      id,
      added: mutation.added || '',
      source: mutation.source || 'manual',
      ...(mutation.supersedes ? { supersedes: mutation.supersedes } : {}),
      ...(mutation.expires ? { expires: mutation.expires } : {}),
      pinned: mutation.pinned === true,
    }
    const line = `- ${String(mutation.content).trim()}${formatProfileMeta(meta)}`
    const nextLines = insertLineInSection(lines, section, line)
    const nextRaw = `${nextLines.join('\n').replace(/\n+$/, '')}\n`
    const estimatedTokens = estimateTokens(nextRaw)
    if (estimatedTokens > maxTokens) {
      return {
        ok: false,
        reason: 'PROFILE_BUDGET_EXCEEDED',
        estimatedTokens,
        maxTokens,
      }
    }
    return { ok: true, id, raw: nextRaw, estimatedTokens }
  }

  const targetId = mutation.targetId || mutation.supersedesId
  const target = entries.find(entry => entry.id === targetId)
  if (!target) {
    return { ok: false, reason: 'TARGET_NOT_FOUND', targetId }
  }
  if (target.pinned && !allowPinned) {
    return { ok: false, reason: 'PINNED_PROTECTED', targetId }
  }

  if (op === 'retire') {
    const nextLines = lines.filter((_line, index) => index !== target.lineIndex)
    const nextRaw = nextLines.length === 0 ? '' : `${nextLines.join('\n').replace(/\n+$/, '')}\n`
    return { ok: true, id: targetId, retired: target, raw: nextRaw, estimatedTokens: estimateTokens(nextRaw) }
  }

  if (op === 'replace') {
    const id = mutation.id || nextProfileId(entries)
    const meta = {
      id,
      added: mutation.added || target.added || '',
      source: mutation.source || target.source || 'manual',
      supersedes: target.id,
      ...(mutation.expires ? { expires: mutation.expires } : {}),
      pinned: mutation.pinned === true || target.pinned,
    }
    const nextLines = [...lines]
    nextLines[target.lineIndex] = `- ${String(mutation.content).trim()}${formatProfileMeta(meta)}`
    const nextRaw = `${nextLines.join('\n').replace(/\n+$/, '')}\n`
    const estimatedTokens = estimateTokens(nextRaw)
    if (estimatedTokens > maxTokens) {
      return {
        ok: false,
        reason: 'PROFILE_BUDGET_EXCEEDED',
        estimatedTokens,
        maxTokens,
      }
    }
    return { ok: true, id, replaced: target, raw: nextRaw, estimatedTokens }
  }

  return { ok: false, reason: `UNSUPPORTED_OP:${op}` }
}

function serializeRetiredEntry(entry) {
  return {
    id: entry.id,
    section: entry.section,
    content: entry.content,
    added: entry.added || '',
    source: entry.source || 'manual',
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    ...(entry.expires ? { expires: entry.expires } : {}),
    pinned: entry.pinned === true,
  }
}

export function readRetiredRecords(home) {
  let raw = ''
  try {
    raw = readFileSync(retiredPath(home), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') records.push(parsed)
    } catch {}
  }
  return records
}

export async function appendRetiredRecord(home, record) {
  const filePath = retiredPath(home)
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

export function previewProfileBatch(currentRaw, mutations, { maxTokens = 2000, allowPinned = false } = {}) {
  let workingRaw = String(currentRaw ?? '')
  const applied = []
  const archived = []
  for (const mutation of mutations) {
    const planned = planProfileMutation(workingRaw, mutation, { maxTokens, allowPinned })
    if (!planned.ok) {
      return planned
    }
    workingRaw = planned.raw
    applied.push({ id: planned.id, section: mutation.section || DEFAULT_SECTION, content: String(mutation.content ?? '').trim() })
    if (planned.retired) {
      archived.push({
        op: 'retire',
        replacedBy: null,
        reason: mutation.reason || 'profile_retire',
        entry: serializeRetiredEntry(planned.retired),
      })
    } else if (planned.replaced) {
      archived.push({
        op: 'replace',
        replacedBy: planned.id,
        reason: mutation.reason || 'profile_replace',
        entry: serializeRetiredEntry(planned.replaced),
      })
    }
  }
  return {
    ok: true,
    raw: workingRaw,
    applied,
    archived,
    estimatedTokens: estimateTokens(workingRaw),
  }
}

export async function applyProfileBatch(home, mutations, { maxTokens = 2000, allowPinned = false, recordRetired = true, nowIso } = {}) {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    const raw = readProfile(home)
    return { ok: true, raw, applied: [], archived: [], estimatedTokens: estimateTokens(raw) }
  }
  const planned = previewProfileBatch(readProfile(home), mutations, { maxTokens, allowPinned })
  if (!planned.ok) return planned
  await atomicWriteFile(profilePath(home), planned.raw)
  if (recordRetired && planned.archived.length > 0) {
    const retiredAt = nowIso || new Date().toISOString()
    for (const item of planned.archived) {
      await appendRetiredRecord(home, {
        event: 'retired',
        retired_at: retiredAt,
        reason: item.reason,
        op: item.op,
        replaced_by: item.replacedBy,
        entry: item.entry,
      })
    }
  }
  return planned
}

export async function applyProfileMutation(home, mutation, { maxTokens = 2000, allowPinned = false, recordRetired = true, nowIso } = {}) {
  const planned = planProfileMutation(readProfile(home), mutation, { maxTokens, allowPinned })
  if (!planned.ok) return planned
  await atomicWriteFile(profilePath(home), planned.raw)
  if (recordRetired && (planned.retired || planned.replaced)) {
    const oldEntry = planned.retired || planned.replaced
    const op = planned.retired ? 'retire' : 'replace'
    await appendRetiredRecord(home, {
      event: 'retired',
      retired_at: nowIso || new Date().toISOString(),
      reason: mutation.reason || (op === 'retire' ? 'profile_retire' : 'profile_replace'),
      op,
      replaced_by: planned.retired ? null : planned.id,
      entry: serializeRetiredEntry(oldEntry),
    })
  }
  return planned
}

export async function rollbackProfileEntry(home, entryId, { maxTokens = 2000, nowIso } = {}) {
  const cleanId = String(entryId ?? '').trim()
  if (!cleanId) return { ok: false, reason: 'ENTRY_ID_REQUIRED' }

  const records = readRetiredRecords(home)
  let targetRecord = null
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i]
    if (rec?.event === 'retired' && rec.entry?.id === cleanId) {
      targetRecord = rec
      break
    }
  }
  if (!targetRecord) {
    return { ok: false, reason: 'RETIRED_ENTRY_NOT_FOUND', entryId: cleanId }
  }

  const currentRaw = readProfile(home)
  const entries = parseProfileEntries(currentRaw)
  if (entries.some(e => e.id === cleanId)) {
    return { ok: false, reason: 'ENTRY_ALREADY_ACTIVE', entryId: cleanId }
  }

  // Follow replacement chain if the direct replacement was itself later replaced
  let activeReplacement = null
  let cursorId = targetRecord.replaced_by
  const visited = new Set([cleanId])
  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId)
    const active = entries.find(e => e.id === cursorId)
    if (active) {
      activeReplacement = active
      break
    }
    const nextRec = [...records].reverse().find(r => r?.event === 'retired' && r.entry?.id === cursorId)
    cursorId = nextRec?.replaced_by ?? null
  }
  if (!activeReplacement) {
    activeReplacement = entries.find(e => e.supersedes === cleanId) ?? null
  }

  const oldEntry = targetRecord.entry
  const restoredLine = `- ${String(oldEntry.content).trim()}${formatProfileMeta(oldEntry)}`
  let nextRaw = ''

  if (activeReplacement) {
    const lines = currentRaw.split(/\r?\n/)
    lines[activeReplacement.lineIndex] = restoredLine
    nextRaw = `${lines.join('\n').replace(/\n+$/, '')}\n`
    const estimatedTokens = estimateTokens(nextRaw)
    if (estimatedTokens > maxTokens) {
      return { ok: false, reason: 'PROFILE_BUDGET_EXCEEDED', estimatedTokens, maxTokens }
    }
  } else {
    const planned = planProfileMutation(currentRaw, {
      op: 'add',
      id: oldEntry.id,
      section: oldEntry.section || DEFAULT_SECTION,
      content: oldEntry.content,
      added: oldEntry.added || '',
      source: oldEntry.source || 'manual',
      supersedes: oldEntry.supersedes,
      expires: oldEntry.expires,
      pinned: oldEntry.pinned === true,
    }, { maxTokens })
    if (!planned.ok) return planned
    nextRaw = planned.raw
  }

  await atomicWriteFile(profilePath(home), nextRaw)
  const at = nowIso || new Date().toISOString()
  if (activeReplacement) {
    await appendRetiredRecord(home, {
      event: 'retired',
      retired_at: at,
      reason: `rollback:${cleanId}`,
      op: 'rollback',
      replaced_by: cleanId,
      entry: serializeRetiredEntry(activeReplacement),
    })
  }
  await appendRetiredRecord(home, {
    event: 'rollback_restore',
    at,
    restored_id: cleanId,
    retired_replacement_id: activeReplacement?.id ?? null,
  })

  return {
    ok: true,
    restoredId: cleanId,
    retiredReplacementId: activeReplacement?.id ?? null,
    estimatedTokens: estimateTokens(nextRaw),
  }
}

export async function redactProfileForForget(home, { anchors = [], keyword, force = false } = {}) {
  const currentRaw = readProfile(home)
  if (!currentRaw) {
    return { removedIds: [], skippedPinnedIds: [], changed: false }
  }
  const anchorSet = new Set((anchors ?? []).filter(Boolean))
  const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
  if (anchorSet.size === 0 && lowerKeyword === undefined) {
    return { removedIds: [], skippedPinnedIds: [], changed: false }
  }

  const entries = parseProfileEntries(currentRaw)
  const removeLineIndices = new Set()
  const removedIds = []
  const skippedPinnedIds = []

  for (const entry of entries) {
    const hitAnchor = entry.source && anchorSet.has(entry.source)
    const hitKeyword = lowerKeyword !== undefined && (
      entry.content.toLowerCase().includes(lowerKeyword)
      || entry.rawLine.toLowerCase().includes(lowerKeyword)
    )
    if (!hitAnchor && !hitKeyword) continue

    if (entry.pinned && !force) {
      skippedPinnedIds.push(entry.id || entry.content)
      continue
    }
    removeLineIndices.add(entry.lineIndex)
    removedIds.push(entry.id || entry.content)
  }

  if (removeLineIndices.size === 0) {
    return { removedIds: [], skippedPinnedIds, changed: false }
  }

  const nextLines = currentRaw.split(/\r?\n/).filter((_line, index) => !removeLineIndices.has(index))
  const hasRemainingBullets = parseProfileEntries(nextLines.join('\n')).length > 0
  const nextRaw = hasRemainingBullets ? `${nextLines.join('\n').replace(/\n+$/, '')}\n` : ''
  await atomicWriteFile(profilePath(home), nextRaw)
  return { removedIds, skippedPinnedIds, changed: true }
}

export async function purgeRetiredForForget(home, { anchors = [], keyword, entryIds = [] } = {}) {
  const records = readRetiredRecords(home)
  if (records.length === 0) return { purgedCount: 0 }

  const anchorSet = new Set((anchors ?? []).filter(Boolean))
  const idSet = new Set((entryIds ?? []).filter(Boolean))
  const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
  if (anchorSet.size === 0 && idSet.size === 0 && lowerKeyword === undefined) {
    return { purgedCount: 0 }
  }

  const kept = []
  let purgedCount = 0
  for (const rec of records) {
    const serialized = JSON.stringify(rec).toLowerCase()
    const entry = rec?.entry
    const hitAnchor = entry?.source && anchorSet.has(entry.source)
    const hitId = (entry?.id && idSet.has(entry.id)) || (rec?.restored_id && idSet.has(rec.restored_id))
    const hitKeyword = lowerKeyword !== undefined && serialized.includes(lowerKeyword)
    if (hitAnchor || hitId || hitKeyword) {
      purgedCount += 1
      continue
    }
    kept.push(JSON.stringify(rec))
  }

  if (purgedCount === 0) return { purgedCount: 0 }
  if (kept.length === 0) {
    try { rmSync(retiredPath(home), { force: true }) } catch {}
  } else {
    await atomicWriteFile(retiredPath(home), `${kept.join('\n')}\n`)
  }
  return { purgedCount }
}
