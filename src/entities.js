import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { detectPromptInjection, detectSecret } from './guard.js'
import { formatProfileMeta, parseMetaParts } from './profile.js'
import {
  atomicWriteFile,
  extractExtraCardLines,
  mergeUniqueTerms,
  searchCardRecords,
  slugifyName,
  triggerMatchIndex,
} from './util.js'

export const ENTITIES_DIR = 'entities'
const META_RE = /\s*`\[([^\]]+)\]`\s*$/

export function entitiesDir(home) {
  return join(home, ENTITIES_DIR)
}

export function entitySlug(name) {
  return slugifyName(name, 'ent')
}

export function entityPath(home, slug) {
  return join(entitiesDir(home), `${slug}.md`)
}

export function parseEntityMarkdown(raw, slug) {
  const lines = String(raw ?? '').split(/\r?\n/)
  let name = slug
  let type = 'general'
  let aliases = []
  let status = 'active'
  const facts = []
  let inFacts = false

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && name === slug) {
      name = h1[1].trim()
      continue
    }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      inFacts = h2[1].trim() === '事实记录'
      continue
    }
    if (!inFacts) {
      const typeMatch = /^[-*]\s*type:\s*(.+?)\s*$/i.exec(line)
      if (typeMatch) {
        type = typeMatch[1].trim() || 'general'
        continue
      }
      const statusMatch = /^[-*]\s*status:\s*(.+?)\s*$/i.exec(line)
      if (statusMatch) {
        const val = statusMatch[1].trim().toLowerCase()
        status = val === 'archived' ? 'archived' : 'active'
        continue
      }
      const aliasMatch = /^[-*]\s*aliases:\s*(.+?)\s*$/i.exec(line)
      if (aliasMatch) {
        aliases = aliasMatch[1]
          .split(/[,，]/)
          .map(item => item.trim())
          .filter(Boolean)
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
    facts.push({
      id: meta.id,
      content,
      added: meta.added,
      source: meta.source,
      supersedes: meta.supersedes,
      pinned: meta.pinned === true,
      meta,
      rawLine: line,
    })
  }

  return {
    slug,
    name,
    type,
    status,
    aliases: [...new Set(aliases)],
    facts,
    raw: String(raw ?? ''),
  }
}

export function serializeEntityMarkdown(entity) {
  const status = entity.status === 'archived' ? 'archived' : 'active'
  const lines = [
    `# ${entity.name}`,
    '',
    `- type: ${entity.type || 'general'}`,
    `- status: ${status}`,
    `- aliases: ${(entity.aliases ?? []).join(', ')}`,
    '',
    '## 事实记录',
  ]
  for (const fact of entity.facts ?? []) {
    if (fact.rawOnly) {
      lines.push(fact.rawLine)
      continue
    }
    const metaText = formatProfileMeta({
      id: fact.id,
      added: fact.added,
      source: fact.source,
      supersedes: fact.supersedes,
      pinned: fact.pinned === true,
    })
    lines.push(`- ${String(fact.content).trim()}${metaText}`)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

export function listEntities(home) {
  const dir = entitiesDir(home)
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
    return parseEntityMarkdown(raw, slug)
  })
}

export function readEntity(home, nameOrSlug) {
  const query = String(nameOrSlug ?? '').trim()
  if (query === '') return undefined
  const lower = query.toLowerCase()
  const targetSlug = entitySlug(query)
  const all = listEntities(home)
  return all.find(ent => (
    ent.slug.toLowerCase() === lower
    || ent.slug === targetSlug
    || ent.name.toLowerCase() === lower
    || ent.aliases.some(alias => alias.toLowerCase() === lower)
  ))
}

function nextFactId(facts) {
  let maxNum = 0
  for (const fact of facts) {
    const m = /^ent_(\d+)$/.exec(fact.id ?? '')
    if (m) maxNum = Math.max(maxNum, Number(m[1]))
  }
  return `ent_${String(maxNum + 1).padStart(2, '0')}`
}

export async function upsertEntity(home, options) {
  const rawName = String(options?.name ?? '').trim()
  if (rawName === '') {
    return { ok: false, reason: 'NAME_REQUIRED' }
  }

  const op = options.op ?? 'add'
  const rawContent = String(options.content ?? '').trim()
  if (op !== 'retire' && rawContent !== '') {
    const secret = detectSecret(rawContent)
    if (secret.detected) {
      return { ok: false, reason: secret.code, kind: secret.kind, message: secret.message }
    }
    if (options.blockPromptInjection !== false) {
      const inj = detectPromptInjection(`${rawName}\n${rawContent}`)
      if (inj.detected) {
        return { ok: false, reason: inj.code, kind: inj.kind, message: inj.message }
      }
    }
  }

  const existing = readEntity(home, rawName)
  const slug = existing?.slug ?? entitySlug(rawName)
  const entity = existing
    ? { ...existing, facts: [...existing.facts], aliases: [...existing.aliases] }
    : { slug, name: rawName, type: 'general', status: 'active', aliases: [], facts: [] }

  if (typeof options.type === 'string' && options.type.trim() !== '') {
    entity.type = options.type.trim()
  }
  if (options.status === 'active' || options.status === 'archived') {
    entity.status = options.status
  }
  if (Array.isArray(options.aliases)) {
    entity.aliases = mergeUniqueTerms(entity.aliases, options.aliases)
  }

  let factId

  if (op === 'add') {
    const content = String(options.content ?? '').trim()
    if (content !== '') {
      factId = options.id || nextFactId(entity.facts)
      entity.facts.push({
        id: factId,
        content,
        added: options.added || '',
        source: options.source || 'manual',
        supersedes: options.supersedes || options.supersedesId || undefined,
        pinned: options.pinned === true,
      })
    }
  } else if (op === 'replace' || op === 'retire') {
    const targetId = options.targetId || options.supersedesId
    const idx = entity.facts.findIndex(f => f.id === targetId)
    if (idx === -1) {
      return { ok: false, reason: 'TARGET_NOT_FOUND', targetId }
    }
    const target = entity.facts[idx]
    if (target.pinned && !options.allowPinned) {
      return { ok: false, reason: 'PINNED_PROTECTED', targetId }
    }
    if (op === 'retire') {
      entity.facts.splice(idx, 1)
      factId = targetId
    } else {
      const content = String(options.content ?? '').trim()
      if (content === '') return { ok: false, reason: 'CONTENT_REQUIRED' }
      factId = options.id || nextFactId(entity.facts)
      entity.facts[idx] = {
        id: factId,
        content,
        added: options.added || target.added || '',
        source: options.source || target.source || 'manual',
        supersedes: target.id,
        pinned: options.pinned === true || target.pinned,
      }
    }
  } else {
    return { ok: false, reason: `UNSUPPORTED_OP:${op}` }
  }

  const markdown = serializeEntityMarkdown(entity)
  await atomicWriteFile(entityPath(home, slug), markdown)
  return { ok: true, slug, factId, entity: parseEntityMarkdown(markdown, slug) }
}

export async function deleteEntity(home, nameOrSlug, { force = false } = {}) {
  const entity = readEntity(home, nameOrSlug)
  if (!entity) return { ok: false, reason: 'NOT_FOUND' }
  if (!force && entity.facts.some(f => f.pinned)) {
    return { ok: false, reason: 'PINNED_PROTECTED', slug: entity.slug }
  }
  try {
    unlinkSync(entityPath(home, entity.slug))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { ok: true, slug: entity.slug }
}

export function matchEntitiesInText(home, text) {
  const input = String(text ?? '')
  if (input.trim() === '') return []
  const lowerText = input.toLowerCase()
  const entities = listEntities(home)
  const matched = []

  for (const entity of entities) {
    if (entity.status === 'archived') continue
    const triggers = [entity.name, ...entity.aliases]
    let bestIndex = -1
    let bestTrigger
    for (const trigger of triggers) {
      const idx = triggerMatchIndex(trigger, input, lowerText)
      if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
        bestIndex = idx
        bestTrigger = trigger
      }
    }
    if (bestIndex !== -1) {
      matched.push({ entity, matchedTrigger: bestTrigger, matchIndex: bestIndex })
    }
  }
  return matched.sort((a, b) => a.matchIndex - b.matchIndex || a.entity.slug.localeCompare(b.entity.slug))
}

export function formatEntityCardForPrompt(entity) {
  const aliasNote = entity.aliases.length > 0 ? `；别名：${entity.aliases.join(', ')}` : ''
  const header = `### 实体：${entity.name}（${entity.type}${aliasNote}）`
  const body = entity.facts.length > 0
    ? entity.facts.map(f => `- ${f.content}${f.source ? `（来源: ${f.source}）` : ''}`)
    : ['- （暂无详细事实记录）']
  return [header, ...body].join('\n')
}

export async function redactEntitiesForForget(home, { anchors = [], keyword, todayDate } = {}) {
  const anchorSet = new Set(anchors.filter(Boolean))
  const lowerKeyword = typeof keyword === 'string' && keyword.trim() !== '' ? keyword.trim().toLowerCase() : undefined
  if (anchorSet.size === 0 && lowerKeyword === undefined) return { updatedEntities: [] }

  const updatedEntities = []
  const markerText = `[已按用户要求遗忘 · ${todayDate}]`

  for (const entity of listEntities(home)) {
    let changed = false
    const nextFacts = entity.facts.map((fact) => {
      const hitAnchor = [...anchorSet].some(a => fact.rawLine.includes(a))
      const hitKeyword = lowerKeyword !== undefined && fact.content.toLowerCase().includes(lowerKeyword)
      if (!hitAnchor && !hitKeyword) return fact
      changed = true
      return {
        rawOnly: true,
        rawLine: `- ${markerText}`,
        pinned: false,
      }
    })
    if (changed) {
      const nextRaw = serializeEntityMarkdown({ ...entity, facts: nextFacts })
      await atomicWriteFile(entityPath(home, entity.slug), nextRaw)
      updatedEntities.push(entity.slug)
    }
  }

  return { updatedEntities }
}

export function searchEntities(home, { query = '', limit = 10 } = {}) {
  return searchCardRecords(listEntities(home), {
    query,
    limit,
    buildHeaderLower: entity => [entity.name, entity.slug, entity.type, ...entity.aliases].filter(Boolean).join(' ').toLowerCase(),
    buildBodyItems: entity => [
      ...entity.facts.map(fact => ({
        content: fact.content,
        entryId: fact.id || null,
        source: fact.source || '',
        added: fact.added || '',
      })),
      ...extractExtraCardLines(entity.raw, '事实记录', /^[-*]\s*(?:type|status|aliases):/i).map(line => ({
        content: line,
      })),
    ],
    formatFallbackSummary: (entity) => {
      const aliasPart = entity.aliases.length > 0 ? `; aliases: ${entity.aliases.join(', ')}` : ''
      const preview = entity.facts[0]?.content ? ` — ${entity.facts[0].content}` : ''
      return `(${entity.type}${aliasPart})${preview}`
    },
    toHit: (entity, score) => ({
      kind: 'entity',
      slug: entity.slug,
      name: entity.name,
      type: entity.type,
      ...score,
    }),
  })
}
