import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { computeContentHash, detectPromptInjection, detectSecret } from './guard.js'
import { formatProfileMeta, parseMetaParts } from './profile.js'
import {
  atomicWriteFile,
  extractExtraCardLines,
  mergeUniqueTerms,
  searchCardRecords,
  slugifyName,
  triggerMatchIndex,
} from './util.js'

export const LESSONS_DIR = 'lessons'
const META_RE = /\s*`\[([^\]]+)\]`\s*$/

export function lessonsDir(home) {
  return join(home, LESSONS_DIR)
}

export function lessonSlug(name) {
  return slugifyName(name, 'les')
}

export function lessonPath(home, slug) {
  return join(lessonsDir(home), `${slug}.md`)
}

function splitTermList(raw) {
  return mergeUniqueTerms([], String(raw ?? '').split(/[,，]/))
}

export function parseLessonMarkdown(raw, slug) {
  const lines = String(raw ?? '').split(/\r?\n/)
  let name = slug
  let status = 'active'
  let tags = []
  let triggers = []
  const entries = []
  let inEntries = false

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && name === slug) {
      name = h1[1].trim()
      continue
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      inEntries = h2[1].trim() === '避坑条目'
      continue
    }
    if (!inEntries) {
      const statusMatch = /^[-*]\s*status:\s*(.+?)\s*$/i.exec(line)
      if (statusMatch) {
        status = statusMatch[1].trim().toLowerCase() === 'archived' ? 'archived' : 'active'
        continue
      }
      const tagsMatch = /^[-*]\s*tags:\s*(.+?)\s*$/i.exec(line)
      if (tagsMatch) {
        tags = splitTermList(tagsMatch[1])
        continue
      }
      const triggersMatch = /^[-*]\s*triggers:\s*(.+?)\s*$/i.exec(line)
      if (triggersMatch) {
        triggers = splitTermList(triggersMatch[1])
        continue
      }
      continue
    }

    const bullet = /^[-*]\s+(.+?)\s*$/.exec(line)
    if (!bullet) continue
    const body = bullet[1]
    const metaMatch = META_RE.exec(body)
    const meta = metaMatch ? parseMetaParts(metaMatch[1]) : { pinned: false }
    const content = metaMatch ? body.slice(0, metaMatch.index).trim() : body.trim()
    entries.push({
      id: meta.id,
      content,
      added: meta.added,
      source: meta.source,
      supersedes: meta.supersedes,
      expires: meta.expires,
      pinned: meta.pinned === true,
      meta,
      rawLine: line,
    })
  }

  return {
    slug,
    name,
    status,
    tags,
    triggers,
    entries,
    raw: String(raw ?? ''),
  }
}

export function serializeLessonMarkdown(lesson) {
  const status = lesson.status === 'archived' ? 'archived' : 'active'
  const lines = [
    `# ${lesson.name}`,
    '',
    `- status: ${status}`,
    `- tags: ${(lesson.tags ?? []).join(', ')}`,
    `- triggers: ${(lesson.triggers ?? []).join(', ')}`,
    '',
    '## 避坑条目',
  ]
  for (const entry of lesson.entries ?? []) {
    if (entry.rawOnly) {
      lines.push(entry.rawLine)
      continue
    }
    const metaText = formatProfileMeta({
      id: entry.id,
      added: entry.added,
      source: entry.source,
      supersedes: entry.supersedes,
      expires: entry.expires,
      pinned: entry.pinned === true,
    })
    lines.push(`- ${String(entry.content).trim()}${metaText}`)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

export function listLessons(home) {
  const dir = lessonsDir(home)
  let files = []
  try {
    files = readdirSync(dir)
      .filter(name => name.endsWith('.md'))
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return files.map((file) => {
    const slug = file.slice(0, -3)
    const raw = readFileSync(join(dir, file), 'utf8')
    return parseLessonMarkdown(raw, slug)
  })
}

export function readLesson(home, nameOrSlug) {
  const query = String(nameOrSlug ?? '').trim()
  if (query === '') return undefined
  const lower = query.toLowerCase()
  const targetSlug = lessonSlug(query)
  const all = listLessons(home)
  return all.find(lesson => (
    lesson.slug.toLowerCase() === lower
    || lesson.slug === targetSlug
    || lesson.name.toLowerCase() === lower
  ))
}

function nextLessonEntryId(entries) {
  let maxNum = 0
  for (const entry of entries) {
    const m = /^les_(\d+)$/.exec(entry.id ?? '')
    if (m) maxNum = Math.max(maxNum, Number(m[1]))
  }
  return `les_${String(maxNum + 1).padStart(2, '0')}`
}

function normalizeExpires(rawExpires, fallback) {
  if (rawExpires === undefined) return fallback
  const clean = typeof rawExpires === 'string' ? rawExpires.trim() : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : undefined
}

export async function upsertLesson(home, options) {
  const rawName = String(options?.name ?? '').trim()
  if (rawName === '') {
    return { ok: false, reason: 'NAME_REQUIRED' }
  }

  const op = options?.op ?? 'add'
  const rawContent = String(options?.content ?? '').trim()
  if (rawContent !== '' && op !== 'retire') {
    const secret = detectSecret(rawContent)
    if (secret.detected) {
      return {
        ok: false,
        reason: secret.code,
        kind: secret.kind,
        message: secret.message,
      }
    }
    if (options?.blockPromptInjection !== false) {
      const inj = detectPromptInjection(`${rawName}\n${rawContent}`)
      if (inj.detected) {
        return {
          ok: false,
          reason: inj.code,
          kind: inj.kind,
          message: inj.message,
        }
      }
    }
  }

  const existing = readLesson(home, rawName)
  const slug = existing?.slug ?? lessonSlug(rawName)
  const lesson = existing
    ? {
      ...existing,
      tags: [...existing.tags],
      triggers: [...existing.triggers],
      entries: [...existing.entries],
    }
    : { slug, name: rawName, status: 'active', tags: [], triggers: [], entries: [] }

  if (options?.status === 'active' || options?.status === 'archived') {
    lesson.status = options.status
  }

  if (Array.isArray(options?.tags)) {
    lesson.tags = mergeUniqueTerms(lesson.tags, options.tags)
  }
  if (Array.isArray(options?.triggers)) {
    lesson.triggers = mergeUniqueTerms(lesson.triggers, options.triggers)
  }

  let entryId
  if (op === 'add') {
    if (rawContent !== '') {
      const incomingHash = computeContentHash(rawContent)
      const dup = incomingHash && options?.allowDuplicate !== true
        ? lesson.entries.find(e => !e.rawOnly && computeContentHash(e.content) === incomingHash)
        : undefined
      if (dup) {
        return {
          ok: true,
          slug,
          entryId: dup.id,
          duplicate: true,
          lesson: existing ?? parseLessonMarkdown(serializeLessonMarkdown(lesson), slug),
        }
      }
      entryId = options?.id || nextLessonEntryId(lesson.entries)
      lesson.entries.push({
        id: entryId,
        content: rawContent,
        added: options?.added || '',
        source: options?.source || 'manual',
        supersedes: options?.supersedes || options?.supersedesId || undefined,
        expires: normalizeExpires(options?.expires),
        pinned: options?.pinned === true,
      })
    }
  } else if (op === 'replace' || op === 'retire') {
    const targetId = options?.targetId || options?.supersedesId
    const idx = lesson.entries.findIndex(e => e.id === targetId)
    if (idx === -1) {
      return { ok: false, reason: 'TARGET_NOT_FOUND', targetId }
    }
    const target = lesson.entries[idx]
    if (target.pinned && !options?.allowPinned) {
      return { ok: false, reason: 'PINNED_PROTECTED', targetId }
    }
    if (op === 'retire') {
      lesson.entries.splice(idx, 1)
      entryId = targetId
    } else {
      if (rawContent === '') return { ok: false, reason: 'CONTENT_REQUIRED' }
      entryId = options?.id || nextLessonEntryId(lesson.entries)
      lesson.entries[idx] = {
        id: entryId,
        content: rawContent,
        added: options?.added || target.added || '',
        source: options?.source || target.source || 'manual',
        supersedes: target.id,
        expires: normalizeExpires(options?.expires, target.expires),
        pinned: options?.pinned === true || target.pinned,
      }
    }
  } else {
    return { ok: false, reason: `UNSUPPORTED_OP:${op}` }
  }

  const markdown = serializeLessonMarkdown(lesson)
  await atomicWriteFile(lessonPath(home, slug), markdown)
  return { ok: true, slug, entryId, lesson: parseLessonMarkdown(markdown, slug) }
}

export async function deleteLesson(home, nameOrSlug, { force = false } = {}) {
  const lesson = readLesson(home, nameOrSlug)
  if (!lesson) return { ok: false, reason: 'NOT_FOUND' }
  if (!force && lesson.entries.some(e => e.pinned)) {
    return { ok: false, reason: 'PINNED_PROTECTED', slug: lesson.slug }
  }
  try {
    unlinkSync(lessonPath(home, lesson.slug))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { ok: true, slug: lesson.slug }
}

export function matchLessonsInText(home, text, { tags = [] } = {}) {
  const input = String(text ?? '')
  const hasText = input.trim() !== ''
  const lowerText = hasText ? input.toLowerCase() : ''

  const requestedTagSet = new Set(
    (Array.isArray(tags) ? tags : [])
      .map(t => String(t ?? '').trim().toLowerCase())
      .filter(Boolean),
  )
  if (!hasText && requestedTagSet.size === 0) return []

  const lessons = listLessons(home)
  const matched = []

  for (const lesson of lessons) {
    if (lesson.status === 'archived') continue
    let bestIndex = -1
    let bestTrigger
    if (hasText) {
      const triggers = mergeUniqueTerms([lesson.name], [...lesson.triggers, ...lesson.tags])
      for (const trigger of triggers) {
        const idx = triggerMatchIndex(trigger, input, lowerText)
        if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
          bestIndex = idx
          bestTrigger = trigger
        }
      }
    }

    const matchedTags = requestedTagSet.size > 0
      ? lesson.tags.filter(tag => requestedTagSet.has(tag.toLowerCase()))
      : []

    if (bestIndex !== -1 || matchedTags.length > 0) {
      matched.push({
        lesson,
        matchedTrigger: bestTrigger,
        matchIndex: bestIndex,
        matchedTags,
      })
    }
  }

  return matched.sort((a, b) => {
    const aDual = a.matchedTags.length > 0 && a.matchIndex !== -1 ? 1 : 0
    const bDual = b.matchedTags.length > 0 && b.matchIndex !== -1 ? 1 : 0
    if (bDual !== aDual) return bDual - aDual
    if (b.matchedTags.length !== a.matchedTags.length) return b.matchedTags.length - a.matchedTags.length
    const aHasIdx = a.matchIndex !== -1 ? 1 : 0
    const bHasIdx = b.matchIndex !== -1 ? 1 : 0
    if (bHasIdx !== aHasIdx) return bHasIdx - aHasIdx
    if (a.matchIndex !== b.matchIndex) return a.matchIndex - b.matchIndex
    return a.lesson.slug.localeCompare(b.lesson.slug)
  })
}

export function formatLessonCardForPrompt(lesson) {
  const metaParts = []
  if (lesson.tags.length > 0) metaParts.push(`tags: ${lesson.tags.join(', ')}`)
  if (lesson.triggers.length > 0) metaParts.push(`触发词: ${lesson.triggers.join(', ')}`)
  const metaSuffix = metaParts.length > 0 ? `（${metaParts.join('；')}）` : ''
  const header = `### 避坑经验：${lesson.name}${metaSuffix}`
  const body = lesson.entries.length > 0
    ? lesson.entries.map((entry) => {
      const notes = []
      if (entry.source) notes.push(`来源: ${entry.source}`)
      if (entry.expires) notes.push(`有效期至: ${entry.expires}`)
      return `- ${entry.content}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`
    })
    : ['- （暂无具体避坑条目）']
  return [header, ...body].join('\n')
}

export async function redactLessonsForForget(home, { anchors = [], keyword, force = false, todayDate } = {}) {
  const anchorSet = new Set((anchors ?? []).filter(Boolean))
  const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
  if (anchorSet.size === 0 && lowerKeyword === undefined) {
    return { updatedLessons: [], skippedPinnedIds: [] }
  }

  const updatedLessons = []
  const skippedPinnedIds = []
  const markerText = `[已按用户要求遗忘 · ${todayDate}]`

  for (const lesson of listLessons(home)) {
    let changed = false
    const nextEntries = lesson.entries.map((entry) => {
      const hitAnchor = [...anchorSet].some(a => entry.rawLine?.includes(a))
      const hitKeyword = lowerKeyword !== undefined && entry.content.toLowerCase().includes(lowerKeyword)
      if (!hitAnchor && !hitKeyword) return entry
      if (entry.pinned && !force) {
        skippedPinnedIds.push(entry.id ? `${lesson.slug}:${entry.id}` : lesson.slug)
        return entry
      }
      changed = true
      return {
        rawOnly: true,
        rawLine: `- ${markerText}`,
        pinned: false,
      }
    })
    if (changed) {
      const nextRaw = serializeLessonMarkdown({ ...lesson, entries: nextEntries })
      await atomicWriteFile(lessonPath(home, lesson.slug), nextRaw)
      updatedLessons.push(lesson.slug)
    }
  }

  return { updatedLessons, skippedPinnedIds }
}

export function searchLessons(home, { query = '', limit = 10 } = {}) {
  return searchCardRecords(listLessons(home), {
    query,
    limit,
    buildHeaderLower: lesson => [lesson.name, lesson.slug, ...lesson.tags, ...lesson.triggers].filter(Boolean).join(' ').toLowerCase(),
    buildBodyItems: lesson => [
      ...lesson.entries.map(entry => ({
        content: entry.content,
        entryId: entry.id || null,
        source: entry.source || '',
        added: entry.added || '',
      })),
      ...extractExtraCardLines(lesson.raw, '避坑条目', /^[-*]\s*(?:status|tags|triggers):/i).map(line => ({
        content: line,
      })),
    ],
    formatFallbackSummary: (lesson) => {
      const metaParts = []
      if (lesson.tags.length > 0) metaParts.push(`tags: ${lesson.tags.join(', ')}`)
      if (lesson.triggers.length > 0) metaParts.push(`triggers: ${lesson.triggers.join(', ')}`)
      const metaText = metaParts.length > 0 ? `(${metaParts.join('; ')})` : '(lesson)'
      const preview = lesson.entries[0]?.content ? ` — ${lesson.entries[0].content}` : ''
      return `${metaText}${preview}`
    },
    toHit: (lesson, score) => ({
      kind: 'lesson',
      slug: lesson.slug,
      name: lesson.name,
      tags: [...lesson.tags],
      ...score,
    }),
  })
}
