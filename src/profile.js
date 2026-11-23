import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, estimateTokens } from './util.js'

export const PROFILE_FILENAME = 'PROFILE.md'
const DEFAULT_HEADER = '# 核心画像（Profile）'
const DEFAULT_SECTION = '其他长期事实'
const META_RE = /\s*`\[([^\]]+)\]`\s*$/

export function profilePath(home) {
  return join(home, PROFILE_FILENAME)
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

export async function applyProfileMutation(home, mutation, { maxTokens = 2000, allowPinned = false } = {}) {
  const currentRaw = readProfile(home)
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
    await atomicWriteFile(profilePath(home), nextRaw)
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
    await atomicWriteFile(profilePath(home), nextRaw)
    return { ok: true, id: targetId, retired: target, raw: nextRaw }
  }

  if (op === 'replace') {
    const id = mutation.id || nextProfileId(entries)
    const meta = {
      id,
      added: mutation.added || target.added || '',
      source: mutation.source || target.source || 'manual',
      supersedes: target.id,
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
    await atomicWriteFile(profilePath(home), nextRaw)
    return { ok: true, id, replaced: target, raw: nextRaw, estimatedTokens }
  }

  return { ok: false, reason: `UNSUPPORTED_OP:${op}` }
}
