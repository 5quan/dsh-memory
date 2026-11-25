import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const WIN_RENAME_TRIES = 6
const WIN_RENAME_WAIT_MS = 40
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const ASCII_TRIGGER_RE = /^[a-z0-9_.\- ]+$/i

const dayFormatters = new Map()
const timeFormatters = new Map()

function dayFormatter(timeZone) {
  let fmt = dayFormatters.get(timeZone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayFormatters.set(timeZone, fmt)
  }
  return fmt
}

function timeFormatter(timeZone) {
  let fmt = timeFormatters.get(timeZone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    timeFormatters.set(timeZone, fmt)
  }
  return fmt
}

/**
 * Shift timestamp back by dayStartHour so late-night sessions before e.g. 02:00
 * remain in the previous logical date.
 */
export function logicalDateOf(timestampMs, { timeZone, dayStartHour = 2 }) {
  const shifted = timestampMs - dayStartHour * 3_600_000
  return dayFormatter(timeZone).format(shifted)
}

export function formatClock(timestampMs, timeZone) {
  const parts = Object.fromEntries(
    timeFormatter(timeZone)
      .formatToParts(timestampMs)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function dateDiffDays(fromDate, toDate) {
  const [fy, fm, fd] = String(fromDate).split('-').map(Number)
  const [ty, tm, td] = String(toDate).split('-').map(Number)
  const fromUtc = Date.UTC(fy, fm - 1, fd)
  const toUtc = Date.UTC(ty, tm - 1, td)
  return Math.round((toUtc - fromUtc) / 86_400_000)
}

export function safeId(id) {
  const text = String(id ?? '')
  return /^[\w-]{1,128}$/.test(text)
    ? text
    : createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export function slugifyName(name, reservedPrefix = 'ent') {
  const cleaned = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9FFF\uF900-\uFAFF-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '' || cleaned.length > 80) return safeId(name)
  return WIN_RESERVED_RE.test(cleaned) ? `${reservedPrefix}-${cleaned}` : cleaned
}

export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function triggerMatchIndex(trigger, text, lowerText) {
  const clean = String(trigger ?? '').trim()
  if ([...clean].length < 2) return -1
  if (ASCII_TRIGGER_RE.test(clean)) {
    const re = new RegExp(`(?<![a-z0-9_])${escapeRegExp(clean)}(?![a-z0-9_])`, 'i')
    const m = re.exec(text)
    return m ? m.index : -1
  }
  return lowerText.indexOf(clean.toLowerCase())
}

export function mergeUniqueTerms(existing = [], incoming = []) {
  const merged = []
  const seen = new Set()
  for (const raw of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const val = String(raw ?? '').trim()
    if (!val) continue
    const lower = val.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    merged.push(val)
  }
  return merged
}

export function parseSearchTerms(query) {
  const seen = new Set()
  const terms = []
  for (const raw of String(query ?? '').trim().toLowerCase().split(/\s+/)) {
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    terms.push({ term: raw, len: [...raw].length })
  }
  return terms
}

export function scoreTextAgainstTerms(lowerText, termEntries) {
  let matchedCount = 0
  let matchedChars = 0
  for (const entry of termEntries) {
    if (lowerText.includes(entry.term)) {
      matchedCount += 1
      matchedChars += entry.len
    }
  }
  return { matchedCount, matchedChars }
}

export function extractExtraCardLines(raw, structuredSectionTitle, headerMetaRe) {
  const extras = []
  let inStructuredSection = false
  let seenH2 = false
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (/^#\s+/.test(line)) continue
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      seenH2 = true
      inStructuredSection = h2[1].trim() === structuredSectionTitle
      continue
    }
    if (/^#{3,6}\s+/.test(line)) continue
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!seenH2 && headerMetaRe.test(line)) continue
    if (inStructuredSection && /^[-*]\s+/.test(line)) continue
    extras.push(trimmed)
  }
  return extras
}

export function searchCardRecords(cards, {
  query = '',
  limit = 10,
  buildHeaderLower,
  buildBodyItems,
  formatFallbackSummary,
  toHit,
} = {}) {
  const termEntries = parseSearchTerms(query)
  if (termEntries.length === 0) return []
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100)

  const andHits = []
  const orHits = []

  for (const card of cards) {
    const headerLower = buildHeaderLower(card)
    const bodyItems = buildBodyItems(card)
    let bodyMatchedAny = false

    for (const item of bodyItems) {
      const bodyLower = String(item.content ?? '').toLowerCase()
      const bodyScore = scoreTextAgainstTerms(bodyLower, termEntries)
      if (bodyScore.matchedCount === 0) continue

      bodyMatchedAny = true
      const combinedScore = scoreTextAgainstTerms(`${headerLower}\n${bodyLower}`, termEntries)
      const isAndMatch = combinedScore.matchedCount === termEntries.length
      const hit = toHit(card, {
        entryId: item.entryId ?? null,
        source: item.source ?? '',
        added: item.added ?? '',
        snippet: clipText(item.content, 300),
        matchedCount: combinedScore.matchedCount,
        matchedChars: combinedScore.matchedChars,
        bodyMatchedCount: bodyScore.matchedCount,
        isAndMatch,
      })
      if (isAndMatch) {
        andHits.push(hit)
      } else if (termEntries.length > 1) {
        orHits.push(hit)
      }
    }

    if (!bodyMatchedAny) {
      const headerScore = scoreTextAgainstTerms(headerLower, termEntries)
      if (headerScore.matchedCount > 0) {
        const isAndMatch = headerScore.matchedCount === termEntries.length
        const hit = toHit(card, {
          entryId: null,
          source: '',
          added: '',
          snippet: clipText(formatFallbackSummary(card), 300),
          matchedCount: headerScore.matchedCount,
          matchedChars: headerScore.matchedChars,
          bodyMatchedCount: 0,
          isAndMatch,
        })
        if (isAndMatch) {
          andHits.push(hit)
        } else if (termEntries.length > 1) {
          orHits.push(hit)
        }
      }
    }
  }

  if (andHits.length > 0 || termEntries.length <= 1) {
    return andHits
      .sort((a, b) =>
        b.bodyMatchedCount - a.bodyMatchedCount
        || b.matchedChars - a.matchedChars
        || a.slug.localeCompare(b.slug))
      .slice(0, safeLimit)
  }

  return orHits
    .sort((a, b) =>
      b.matchedCount - a.matchedCount
      || b.matchedChars - a.matchedChars
      || b.bodyMatchedCount - a.bodyMatchedCount
      || a.slug.localeCompare(b.slug))
    .slice(0, safeLimit)
}

export function estimateTokens(text) {
  const input = String(text ?? '')
  if (input === '') return 0
  const cjkCount = (input.match(CJK_RE) ?? []).length
  const otherCount = input.length - cjkCount
  return Math.ceil(cjkCount * 0.7 + otherCount * 0.25)
}

export function anchorOf(logicalDate, sessionId, seq) {
  return `chat://${logicalDate}#${sessionId}#${seq}`
}

export function parseAnchor(anchor) {
  const clean = String(anchor ?? '').trim()
  const match = /^chat:\/\/(\d{4}-\d{2}-\d{2})#(.+)#(\d+)$/.exec(clean)
  if (!match) return null
  return {
    logicalDate: match[1],
    sessionId: match[2],
    seq: Number.parseInt(match[3], 10),
  }
}

export function clipText(text, maxChars = 400) {
  const input = String(text ?? '')
  if (input.length <= maxChars) return input
  return `${input.slice(0, maxChars)}…`
}

export async function atomicWriteFile(filePath, text) {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${basename(filePath).slice(0, 32)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temp, text, 'utf8')
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temp, filePath)
      return
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= WIN_RENAME_TRIES || !BUSY_CODES.has(error?.code)) {
        throw error
      }
      await delay(WIN_RENAME_WAIT_MS * attempt)
    }
  }
}

export function extractTextBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function stripSystemReminders(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim()
}

export function parseCardReplyText(rawText) {
  let payload
  try {
    payload = JSON.parse(rawText)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  if (payload.kind === 'answer_to_pending_handoff') {
    const reason = typeof payload.reason === 'string' ? payload.reason : 'browser handoff'
    const outcome = typeof payload.outcome === 'string' ? payload.outcome : 'done'
    return `[Browser handoff] ${reason} -> ${outcome}`
  }
  if (Array.isArray(payload.questions) && payload.questions.length > 0) {
    const answers = Array.isArray(payload.answers) ? payload.answers : []
    return payload.questions
      .filter(q => typeof q?.question === 'string')
      .map((q) => {
        const ans = answers.find(a => a?.id === q.id)
        const vals = [...(Array.isArray(ans?.selected) ? ans.selected : []), ...(ans?.custom ? [ans.custom] : [])]
        return `[Card] ${q.question} -> ${vals.length > 0 ? vals.join(', ') : '(skipped)'}`
      })
      .join('\n')
  }
  if (Array.isArray(payload.views) && payload.views.length > 0) {
    return payload.views
      .map(view => `[View] ${view?.title ?? view?.id ?? 'view'}: ${JSON.stringify(view?.values ?? view?.answer ?? '')}`)
      .join('\n')
  }
  return undefined
}
