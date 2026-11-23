import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, clipText, dateDiffDays, estimateTokens } from './util.js'

export const JOURNALS_DIR = 'journals'

export const JOURNAL_SECTIONS = [
  '发生了什么',
  '做出的决定',
  '新建/变更的事项',
  '纠正与教训',
  '悬而未决的问题',
  '提到的实体',
]

// Priority order when a single day exceeds token budget: lessons > decisions > open questions
const RECENT_PRIORITY_SECTIONS = ['纠正与教训', '做出的决定', '悬而未决的问题']

export function journalsDir(home) {
  return join(home, JOURNALS_DIR)
}

export function journalPath(home, date) {
  return join(journalsDir(home), `${date}.md`)
}

export function listJournalDates(home) {
  try {
    return readdirSync(journalsDir(home))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map(name => name.slice(0, 10))
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export function readJournal(home, date) {
  try {
    return readFileSync(journalPath(home, date), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export async function writeJournalAtomic(home, date, content, { force = false } = {}) {
  const existing = readJournal(home, date)
  if (existing !== '' && !force) {
    return { written: false, reason: 'ALREADY_EXISTS' }
  }
  const normalized = `${String(content ?? '').trim()}\n`
  await atomicWriteFile(journalPath(home, date), normalized)
  return { written: true, path: journalPath(home, date) }
}

/**
 * Validate every `chat://...` anchor in generated journal markdown against `messages`.
 * Fabricated or wrong-date anchors are stripped and replaced with `[unverified]`.
 */
export function verifyJournalAnchors(markdown, logicalDate, store) {
  const unverifiedAnchors = []
  let output = String(markdown ?? '')

  // First handle bracketed `[chat://...]` so we don't produce double brackets `[[unverified]]`
  output = output.replace(/\[(chat:\/\/[^\s\]\)\>,;'"`]+)\]/g, (full, anchor) => {
    if (store.hasAnchorForDate(anchor, logicalDate)) return full
    unverifiedAnchors.push(anchor)
    return '[unverified]'
  })

  // Then handle any bare `chat://...`
  output = output.replace(/chat:\/\/[^\s\]\)\>,;'"`]+/g, (anchor) => {
    if (store.hasAnchorForDate(anchor, logicalDate)) return anchor
    unverifiedAnchors.push(anchor)
    return '[unverified]'
  })

  return { markdown: output, unverifiedAnchors }
}

export function parseJournalSections(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  let title = ''
  const sections = new Map()
  let current = null

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && title === '') {
      title = h1[1]
      continue
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      current = h2[1].trim()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current !== null) {
      sections.get(current).push(line)
    }
  }

  const trimmed = new Map()
  for (const [name, secLines] of sections) {
    const body = secLines.join('\n').trim()
    if (body !== '' && body !== '（无）' && body !== '(无)' && body !== '- 无') {
      trimmed.set(name, body)
    }
  }
  return { title, sections: trimmed }
}

function formatRecentDayBlock(date, todayDate, sections, includedNames) {
  const diff = dateDiffDays(date, todayDate)
  const heading = `### ${date}（${diff} 天前）`
  const parts = [heading]
  for (const name of includedNames) {
    const body = sections.get(name)
    if (body) parts.push(`#### ${name}\n${body}`)
  }
  return parts.join('\n')
}

function fitSingleRecentDay(date, todayDate, sections, maxTokens) {
  const candidates = [
    ['纠正与教训', '做出的决定', '悬而未决的问题'],
    ['纠正与教训', '做出的决定'],
    ['纠正与教训'],
    [],
  ]
  for (const order of candidates) {
    const block = formatRecentDayBlock(date, todayDate, sections, order)
    if (estimateTokens(block) <= maxTokens) return block
  }
  const diff = dateDiffDays(date, todayDate)
  const heading = `### ${date}（${diff} 天前）`
  return estimateTokens(heading) <= maxTokens ? heading : ''
}

/**
 * Render days 2..N prior to today (excluding yesterdayDate), oldest dropped first on overflow.
 */
export function renderRecentDays({ home, todayDate, yesterdayDate, recentDaysCount = 7, maxTokens = 2000 }) {
  if (recentDaysCount <= 1 || maxTokens <= 0) return ''
  const dates = listJournalDates(home)
    .filter((date) => {
      if (date >= todayDate || date === yesterdayDate) return false
      const diff = dateDiffDays(date, todayDate)
      return diff >= 1 && diff <= recentDaysCount
    })
    .sort() // oldest -> newest

  if (dates.length === 0) return ''

  const newestFirst = [...dates].reverse()
  const kept = []
  let usedTokens = 0

  for (const date of newestFirst) {
    const raw = readJournal(home, date)
    if (!raw) continue
    const { sections } = parseJournalSections(raw)
    const fullBlock = formatRecentDayBlock(date, todayDate, sections, RECENT_PRIORITY_SECTIONS)
    const cost = estimateTokens(fullBlock)
    if (usedTokens + cost <= maxTokens) {
      kept.push({ date, block: fullBlock, cost })
      usedTokens += cost
      continue
    }
    if (kept.length === 0) {
      const trimmed = fitSingleRecentDay(date, todayDate, sections, maxTokens)
      if (trimmed) kept.push({ date, block: trimmed, cost: estimateTokens(trimmed) })
    }
    break
  }

  return kept
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(item => item.block)
    .join('\n\n')
}

export async function redactJournalForForget(home, { date, anchors = [], keyword, sessionId, todayDate }) {
  const targetDates = date ? [date] : listJournalDates(home)
  const anchorSet = new Set(anchors.filter(Boolean))
  const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
  const forgetWholeDate = Boolean(date) && anchorSet.size === 0 && lowerKeyword === undefined && !sessionId
  const updatedDates = []
  const marker = `- [已按用户要求遗忘 · ${todayDate}]`

  for (const d of targetDates) {
    const raw = readJournal(home, d)
    if (!raw) continue
    const lines = raw.split(/\r?\n/)
    let changed = false
    const nextLines = lines.map((line) => {
      if (/^#{1,6}\s/.test(line) || line.trim() === '') return line
      if (line.trim() === marker) return line
      const hitAnchor = [...anchorSet].some(a => line.includes(a))
      const hitKeyword = lowerKeyword !== undefined && line.toLowerCase().includes(lowerKeyword)
      if (!forgetWholeDate && !hitAnchor && !hitKeyword) return line
      changed = true
      return marker
    })
    if (changed) {
      await atomicWriteFile(journalPath(home, d), `${nextLines.join('\n').replace(/\n+$/, '')}\n`)
      updatedDates.push(d)
    }
  }
  return updatedDates
}

export function searchJournals(home, { query = '', dateFrom, dateTo, limit = 10 } = {}) {
  const terms = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const dates = listJournalDates(home)
    .filter(date => (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo))
    .reverse()

  const hits = []
  for (const date of dates) {
    const raw = readJournal(home, date)
    if (!raw) continue
    let currentSection = ''
    for (const line of raw.split(/\r?\n/)) {
      const h2 = /^##\s+(.+?)\s*$/.exec(line)
      if (h2) {
        currentSection = h2[1].trim()
        continue
      }
      const lower = line.toLowerCase()
      if (terms.every(term => lower.includes(term))) {
        hits.push({
          date,
          section: currentSection,
          line: clipText(line.trim(), 300),
        })
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}
