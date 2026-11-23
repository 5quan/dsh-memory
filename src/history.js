import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { callLlmOneShot, resolveModelSelection } from './digest.js'
import { atomicWriteFile, estimateTokens } from './util.js'

export const HISTORY_DIR = 'history'
const L0_MAX_CHARS = 256
const L1_MAX_CHARS = 4000

const MONTH_HISTORY_SYSTEM_PROMPT = `你是一个严谨的历史记忆索引生成器。请基于给定某个月的不可变每日日报（单跳派生），生成该月的 L0 一句话摘要和 L1 结构化概览。
严格遵守以下规则：
1. 只能总结日报中确实存在的内容，绝不编造事实或跨月联想。
2. 必须严格按以下两个标记分段输出（不要包代码块）：
===L0_ABSTRACT===
<一句话总结本月核心主线与关键里程碑，不超过 256 字>
===L1_OVERVIEW===
# YYYY-MM 月度概览

## 关键决策
- [YYYY-MM-DD] [chat://...] ...

## 纠正与教训
- [YYYY-MM-DD] [chat://...] ...

## 核心事件索引
- [YYYY-MM-DD] [chat://...] ...
3. 每条重要记录必须附带对应的日期 [YYYY-MM-DD] 以及日报中的真实锚点 [chat://...]，严禁改写或编造锚点。
4. L1 总长度控制在 4000 字符以内，精炼准确，便于后续按日期下钻阅读完整日报。`

const MONTH_CHUNK_MAP_PROMPT = `请从这一批同月的每日日报中提取适合做月度 L1 索引的关键决策、用户纠正与重要事件，每条必须保留对应的 [YYYY-MM-DD] 日期和原始 [chat://...] 锚点，绝不编造。`

export function historyDir(home) {
  return join(home, HISTORY_DIR)
}

export function globalAbstractPath(home) {
  return join(historyDir(home), '.abstract.md')
}

export function monthHistoryDir(home, month) {
  return join(historyDir(home), month)
}

export function monthAbstractPath(home, month) {
  return join(monthHistoryDir(home, month), '.abstract.md')
}

export function monthOverviewPath(home, month) {
  return join(monthHistoryDir(home, month), '.overview.md')
}

function readTextIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim()
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function clipChars(text, maxChars) {
  const clean = String(text ?? '').trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1)}…`
}

export function listHistoryMonths(home) {
  const dir = historyDir(home)
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
    .map((entry) => {
      const month = entry.name
      const abstract = readTextIfExists(monthAbstractPath(home, month))
      const hasOverview = existsSync(monthOverviewPath(home, month))
      return { month, abstract, hasOverview }
    })
    .filter(item => item.abstract !== '' || item.hasOverview)
    .sort((a, b) => a.month.localeCompare(b.month))
}

export function verifyMonthAnchors(markdown, month, store) {
  const unverifiedAnchors = []
  const isValid = (anchor) => {
    const row = store.getMessageByAnchor(anchor)
    return Boolean(row && String(row.logical_date).startsWith(`${month}-`))
  }

  let output = String(markdown ?? '')
  output = output.replace(/\[(chat:\/\/[^\s\]\)\>,;'"`]+)\]/g, (full, anchor) => {
    if (isValid(anchor)) return full
    unverifiedAnchors.push(anchor)
    return '[unverified]'
  })
  output = output.replace(/chat:\/\/[^\s\]\)\>,;'"`]+/g, (anchor) => {
    if (isValid(anchor)) return anchor
    unverifiedAnchors.push(anchor)
    return '[unverified]'
  })
  return { markdown: output, unverifiedAnchors }
}

function parseMonthHistoryOutput(rawText, month) {
  const raw = String(rawText ?? '').trim()
  const l0Tag = '===L0_ABSTRACT==='
  const l1Tag = '===L1_OVERVIEW==='
  const l0Pos = raw.indexOf(l0Tag)
  const l1Pos = raw.indexOf(l1Tag)

  let abstract = ''
  let overview = ''

  if (l0Pos !== -1 && l1Pos !== -1 && l1Pos > l0Pos) {
    abstract = raw.slice(l0Pos + l0Tag.length, l1Pos).trim()
    overview = raw.slice(l1Pos + l1Tag.length).trim()
  } else if (l1Pos !== -1) {
    overview = raw.slice(l1Pos + l1Tag.length).trim()
    abstract = raw.slice(0, l1Pos).replace(l0Tag, '').trim()
  } else {
    overview = raw
    const firstContentLine = raw.split(/\r?\n/).find(line => line.trim() !== '' && !line.trim().startsWith('#')) ?? ''
    abstract = firstContentLine.replace(/^[-*]\s+/, '').trim()
  }

  if (abstract === '') {
    abstract = `${month} 历史记忆归档。`
  }
  if (overview === '') {
    overview = `# ${month} 月度概览\n\n- ${abstract}`
  }
  return {
    abstract: clipChars(abstract.replace(/\s+/g, ' '), L0_MAX_CHARS),
    overview: clipChars(overview, L1_MAX_CHARS),
  }
}

/**
 * Deterministically assemble history/.abstract.md from monthly L0 abstracts
 * without an LLM call (avoids summary-of-summary drift). Keeps newest months within budget.
 */
export async function rebuildGlobalAbstract(home, { maxTokens = 1000 } = {}) {
  const months = listHistoryMonths(home).filter(m => m.abstract !== '')
  if (months.length === 0) {
    try {
      rmSync(globalAbstractPath(home), { force: true })
    } catch {}
    return { updated: true, months: [], text: '' }
  }

  const newestFirst = [...months].reverse()
  const header = '# 历史总览地图（OpenViking L0）'
  const lines = [header]
  const included = []

  for (const item of newestFirst) {
    const line = `- **${item.month}**：${item.abstract.replace(/\r?\n+/g, ' ')}`
    const candidate = `${[...lines, line].join('\n')}\n`
    if (included.length > 0 && estimateTokens(candidate) > maxTokens) {
      break
    }
    lines.push(line)
    included.push(item.month)
  }

  const finalText = `${lines.join('\n')}\n`
  await atomicWriteFile(globalAbstractPath(home), finalText)
  return { updated: true, months: included, text: finalText }
}

export function createHistoryApi({ ctx, config, store, journalApi, warn = () => {} }) {
  function chunkJournals(entries, maxChunkTokens) {
    const chunks = []
    let current = []
    let used = 0
    for (const entry of entries) {
      const block = `### ${entry.date}\n${entry.raw}`
      const cost = estimateTokens(block) + 8
      if (current.length > 0 && used + cost > maxChunkTokens) {
        chunks.push(current)
        current = []
        used = 0
      }
      current.push(block)
      used += cost
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  async function rebuildMonthHistory(month, { signal } = {}) {
    if (!/^\d{4}-\d{2}$/.test(String(month ?? ''))) {
      throw new Error(`Invalid month format "${month}". Expected YYYY-MM.`)
    }

    const dates = journalApi.listJournalDates(config.home)
      .filter(date => date.startsWith(`${month}-`))
      .sort()

    if (dates.length === 0) {
      rmSync(monthHistoryDir(config.home, month), { recursive: true, force: true })
      await rebuildGlobalAbstract(config.home, { maxTokens: config.sections.historyOverview.maxTokens })
      return { ok: true, month, removed: true, journalCount: 0 }
    }

    const selection = resolveModelSelection(ctx, config)
    if (!selection) {
      throw new Error('No LLM provider/model resolved for history index generation')
    }

    const journals = dates
      .map(date => ({ date, raw: journalApi.readJournal(config.home, date).trim() }))
      .filter(item => item.raw !== '')

    const chunks = chunkJournals(journals, config.digest.maxChunkTokens)
    let rawOutput = ''

    if (chunks.length <= 1) {
      const body = chunks[0]?.join('\n\n') ?? ''
      rawOutput = await callLlmOneShot(ctx, {
        ...selection,
        system: MONTH_HISTORY_SYSTEM_PROMPT,
        prompt: `目标月份：${month}（共 ${journals.length} 份日报）\n\n${body}`,
        signal,
      })
    } else {
      const partials = []
      for (let i = 0; i < chunks.length; i += 1) {
        const part = await callLlmOneShot(ctx, {
          ...selection,
          system: MONTH_CHUNK_MAP_PROMPT,
          prompt: `目标月份：${month}（分块 ${i + 1}/${chunks.length}）\n\n${chunks[i].join('\n\n')}`,
          signal,
        })
        partials.push(`### 分块 ${i + 1}\n${part}`)
      }
      rawOutput = await callLlmOneShot(ctx, {
        ...selection,
        system: MONTH_HISTORY_SYSTEM_PROMPT,
        prompt: `目标月份：${month}。以下是同一月分块提取的要点（已保留原始日期与锚点），请合成为该月 L0 与 L1：\n\n${partials.join('\n\n')}`,
        signal,
      })
    }

    const parsed = parseMonthHistoryOutput(rawOutput, month)
    const checkedAbstract = verifyMonthAnchors(parsed.abstract, month, store)
    const checkedOverview = verifyMonthAnchors(parsed.overview, month, store)
    const unverifiedAnchors = [...checkedAbstract.unverifiedAnchors, ...checkedOverview.unverifiedAnchors]
    if (unverifiedAnchors.length > 0) {
      warn('dsh-memory: stripped %d unverified anchor(s) in %s history index: %s', unverifiedAnchors.length, month, unverifiedAnchors.join(', '))
    }

    const finalAbstract = `${clipChars(checkedAbstract.markdown, L0_MAX_CHARS)}\n`
    const finalOverview = `${clipChars(checkedOverview.markdown, L1_MAX_CHARS)}\n`

    await atomicWriteFile(monthAbstractPath(config.home, month), finalAbstract)
    await atomicWriteFile(monthOverviewPath(config.home, month), finalOverview)
    await rebuildGlobalAbstract(config.home, { maxTokens: config.sections.historyOverview.maxTokens })

    return {
      ok: true,
      month,
      removed: false,
      journalCount: journals.length,
      chunks: chunks.length,
      unverifiedAnchors,
      abstract: finalAbstract.trim(),
    }
  }

  async function rebuildAllHistory({ signal } = {}) {
    const journalMonths = journalApi.listJournalDates(config.home).map(d => d.slice(0, 7))
    const existingMonths = listHistoryMonths(config.home).map(m => m.month)
    const allMonths = [...new Set([...journalMonths, ...existingMonths])].sort()

    const results = []
    for (const month of allMonths) {
      results.push(await rebuildMonthHistory(month, { signal }))
    }
    if (allMonths.length === 0) {
      await rebuildGlobalAbstract(config.home, { maxTokens: config.sections.historyOverview.maxTokens })
    }
    return { months: results }
  }

  function readHistory({ month, level = 'L1' } = {}) {
    if (!month) {
      const globalText = readTextIfExists(globalAbstractPath(config.home))
      const months = listHistoryMonths(config.home)
      return { global: globalText, months }
    }
    const cleanMonth = String(month).trim()
    const abstract = readTextIfExists(monthAbstractPath(config.home, cleanMonth))
    const overview = level === 'L0' ? '' : readTextIfExists(monthOverviewPath(config.home, cleanMonth))
    const journalDates = journalApi.listJournalDates(config.home).filter(d => d.startsWith(`${cleanMonth}-`))
    return {
      month: cleanMonth,
      level,
      abstract,
      overview,
      journalDates,
    }
  }

  async function redactHistoryForForget({ anchors = [], keyword, affectedDates = [], todayDate } = {}) {
    const anchorSet = new Set(anchors.filter(Boolean))
    const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
    if (anchorSet.size === 0 && lowerKeyword === undefined && affectedDates.length === 0) {
      return { updatedMonths: [] }
    }

    const candidateMonths = affectedDates.length > 0 && anchorSet.size === 0 && lowerKeyword === undefined
      ? [...new Set(affectedDates.map(d => d.slice(0, 7)))]
      : listHistoryMonths(config.home).map(m => m.month)

    const marker = `- [已按用户要求遗忘 · ${todayDate}]`
    const updatedMonths = []
    let abstractChanged = false

    const matchesLine = (line) => {
      if ([...anchorSet].some(a => line.includes(a))) return true
      if (lowerKeyword !== undefined && line.toLowerCase().includes(lowerKeyword)) return true
      return affectedDates.some(d => line.includes(d)) && anchorSet.size === 0 && lowerKeyword === undefined
    }

    for (const month of candidateMonths) {
      let touched = false
      const ovPath = monthOverviewPath(config.home, month)
      const ovRaw = readTextIfExists(ovPath)
      if (ovRaw !== '') {
        const nextLines = ovRaw.split(/\r?\n/).map((line) => {
          if (/^#{1,6}\s/.test(line) || line.trim() === '' || line.trim() === marker) return line
          if (!matchesLine(line)) return line
          touched = true
          return marker
        })
        if (touched) {
          await atomicWriteFile(ovPath, `${nextLines.join('\n').replace(/\n+$/, '')}\n`)
        }
      }

      const absPath = monthAbstractPath(config.home, month)
      const absRaw = readTextIfExists(absPath)
      if (absRaw !== '' && matchesLine(absRaw)) {
        await atomicWriteFile(absPath, `${month} 历史摘要部分内容已按用户要求遗忘（${todayDate}）。\n`)
        touched = true
        abstractChanged = true
      }

      if (touched) updatedMonths.push(month)
    }

    if (abstractChanged) {
      await rebuildGlobalAbstract(config.home, { maxTokens: config.sections.historyOverview.maxTokens })
    }
    return { updatedMonths }
  }

  return {
    listHistoryMonths: () => listHistoryMonths(config.home),
    readHistory,
    rebuildMonthHistory,
    rebuildAllHistory,
    rebuildGlobalAbstract: () => rebuildGlobalAbstract(config.home, { maxTokens: config.sections.historyOverview.maxTokens }),
    redactHistoryForForget,
  }
}
