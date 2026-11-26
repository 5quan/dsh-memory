import { createHash } from 'node:crypto'
import { readProfile, parseProfileEntries } from './profile.js'

const DEFAULT_DIMENSIONS = 128

// Bilingual concept clusters so paraphrased queries with zero shared trigram still align in vector space
const SEMANTIC_GROUPS = [
  ['deploy', 'deployment', 'release', 'publish', 'rollout', 'ship', '上线', '部署', '发布', '发版'],
  ['rollback', 'revert', 'undo', 'restore', 'backout', '回滚', '撤销', '恢复', '退回'],
  ['cache', 'snapshot', 'kv', 'prefix', 'freeze', 'frozen', '缓存', '快照', '冻结', '前缀'],
  ['database', 'sqlite', 'db', 'sql', 'schema', 'migration', 'table', '数据库', '迁移', '建表'],
  ['error', 'bug', 'crash', 'failure', 'exception', 'fail', 'broken', '报错', '故障', '异常', '崩溃', '失败'],
  ['timeout', 'latency', 'slow', 'hang', 'stuck', 'perf', 'performance', '超时', '延迟', '慢查询', '卡顿', '性能'],
  ['auth', 'token', 'apikey', 'secret', 'credential', 'oauth', 'login', 'password', '鉴权', '密钥', '令牌', '密码', '凭证'],
  ['proxy', 'port', 'localhost', 'reverse', 'nginx', 'gateway', 'caddy', '代理', '端口', '网关', '反向代理'],
  ['test', 'tests', 'eval', 'benchmark', 'spec', 'assert', 'unit', '单测', '测试', '评测', '基准', '断言'],
  ['schedule', 'cron', 'timer', 'rollover', 'idle', 'daemon', '定时', '调度', '空闲', '切日', '日结'],
  ['security', 'injection', 'poisoning', 'xss', 'csrf', 'guard', 'sandbox', '安全', '注入', '投毒', '防护', '沙箱'],
  ['git', 'branch', 'commit', 'merge', 'pr', 'rebase', 'checkout', '分支', '提交', '合并'],
  ['config', 'setting', 'settings', 'volatile', 'env', 'option', '配置', '设置', '开关', '热更新', '环境变量'],
  ['entity', 'person', 'server', 'project', 'service', 'node', '实体', '人物', '服务器', '项目'],
  ['lesson', 'pitfall', 'caveat', 'rule', 'mistake', '避坑', '教训', '规矩', '经验', '红线'],
  ['style', 'format', 'concise', 'language', 'preference', 'tone', '风格', '格式', '简洁', '偏好', '语气'],
  ['chat', 'casual', 'daily', 'off', 'work', 'scene', '聊天', '闲聊', '工作模式', '场景', '静默'],
  ['search', 'query', 'retrieve', 'lookup', 'recall', 'find', 'vector', 'fts', '检索', '查询', '召回', '向量', '语义'],
  ['docker', 'container', 'image', 'k8s', 'kubernetes', 'pod', 'helm', '容器', '镜像', '编排'],
  ['memory', 'profile', 'journal', 'digest', 'dream', 'buffer', 'archive', '记忆', '画像', '日报', '日结', '做梦', '缓冲区'],
  ['delete', 'forget', 'redact', 'purge', 'clean', 'remove', '遗忘', '删除', '脱敏', '清理', '抹除'],
  ['approve', 'confirm', 'reject', 'pending', 'briefing', '批准', '确认', '驳回', '晨报', '待确认'],
  ['network', 'http', 'https', 'tls', 'ssl', 'cert', 'dns', '网络', '证书', '域名'],
  ['file', 'path', 'disk', 'directory', 'fs', 'read', 'write', '文件', '路径', '磁盘', '目录'],
]

const TERM_TO_GROUPS = new Map()
SEMANTIC_GROUPS.forEach((group, idx) => {
  const tag = `__concept_${idx}__`
  for (const raw of group) {
    const key = raw.toLowerCase()
    const list = TERM_TO_GROUPS.get(key) ?? []
    list.push(tag)
    TERM_TO_GROUPS.set(key, list)
  }
})

function fnv1a32(str) {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function addWeightedFeature(vec, feature, weight) {
  const h = fnv1a32(feature)
  const dims = vec.length
  const bucket = h % dims
  const sign = (h & 0x80000000) !== 0 ? -1 : 1
  vec[bucket] += sign * weight
}

function extractLocalFeatures(text) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[`*_#>\[\]()!?,.;:'"\\/|{}~=+\-\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return []

  const features = []
  const asciiWords = clean.match(/[a-z0-9]{2,}/g) ?? []
  for (const w of asciiWords) {
    features.push([`w:${w}`, 1.0])
    const concepts = TERM_TO_GROUPS.get(w)
    if (concepts) {
      for (const c of concepts) features.push([c, 2.2])
    }
  }

  // Extract CJK contiguous runs and build 2-grams, 3-grams, plus concept matches
  const cjkRuns = clean.match(/[\u3400-\u9FFF\uF900-\uFAFF]+/g) ?? []
  for (const run of cjkRuns) {
    const chars = [...run]
    for (let i = 0; i <= chars.length - 2; i += 1) {
      const bi = chars.slice(i, i + 2).join('')
      features.push([`c2:${bi}`, 0.9])
      const biConcepts = TERM_TO_GROUPS.get(bi)
      if (biConcepts) {
        for (const c of biConcepts) features.push([c, 2.2])
      }
      if (i <= chars.length - 3) {
        const tri = chars.slice(i, i + 3).join('')
        features.push([`c3:${tri}`, 1.1])
        const triConcepts = TERM_TO_GROUPS.get(tri)
        if (triConcepts) {
          for (const c of triConcepts) features.push([c, 2.4])
        }
      }
    }
  }

  // Also check any multi-word / compound phrase hits in SEMANTIC_GROUPS directly
  for (const [term, concepts] of TERM_TO_GROUPS.entries()) {
    if (term.length >= 4 && clean.includes(term)) {
      for (const c of concepts) features.push([c, 1.5])
    }
  }

  return features
}

export function l2Normalize(vec) {
  let normSq = 0
  for (let i = 0; i < vec.length; i += 1) {
    normSq += vec[i] * vec[i]
  }
  if (normSq <= 0) return vec
  const inv = 1 / Math.sqrt(normSq)
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] *= inv
  }
  return vec
}

export function encodeFloat32(vec) {
  const arr = vec instanceof Float32Array ? vec : new Float32Array(vec)
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
}

export function decodeFloat32(blob) {
  if (!blob) return new Float32Array(0)
  if (blob instanceof Float32Array) return blob
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  const usableBytes = bytes.byteLength - (bytes.byteLength % 4)
  const copy = new Uint8Array(usableBytes)
  copy.set(bytes.subarray(0, usableBytes))
  return new Float32Array(copy.buffer)
}

export function cosineSimilarity(a, b) {
  const len = Math.min(a?.length ?? 0, b?.length ?? 0)
  if (len === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i += 1) {
    const va = a[i]
    const vb = b[i]
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  if (normA <= 0 || normB <= 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function createLocalEmbedder({ dimensions = DEFAULT_DIMENSIONS } = {}) {
  const safeDims = Math.min(Math.max(Number.parseInt(dimensions, 10) || DEFAULT_DIMENSIONS, 32), 1024)
  return {
    dimensions: safeDims,
    embed(text) {
      const vec = new Float32Array(safeDims)
      const features = extractLocalFeatures(text)
      for (const [feature, weight] of features) {
        addWeightedFeature(vec, feature, weight)
      }
      return l2Normalize(vec)
    },
  }
}

/**
 * Reciprocal Rank Fusion over multiple ranked lists.
 * Each item in rankedLists[i] must expose a key via keyOf(item).
 */
export function rrfMerge(rankedLists, {
  k = 60,
  limit = 10,
  keyOf = item => item.key ?? item.docKey ?? item.id,
} = {}) {
  const safeK = Math.max(Number(k) || 60, 1)
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100)
  const merged = new Map()

  for (const list of rankedLists ?? []) {
    if (!Array.isArray(list)) continue
    for (let rank = 0; rank < list.length; rank += 1) {
      const item = list[rank]
      if (!item) continue
      const key = keyOf(item)
      if (!key) continue
      const delta = 1 / (safeK + rank + 1)
      const prev = merged.get(key)
      if (!prev) {
        merged.set(key, {
          ...item,
          key,
          rrfScore: delta,
          sources: item.sourceChannel ? [item.sourceChannel] : [],
        })
      } else {
        prev.rrfScore += delta
        if (item.sourceChannel && !prev.sources.includes(item.sourceChannel)) {
          prev.sources.push(item.sourceChannel)
        }
        if (item.vectorScore !== undefined && prev.vectorScore === undefined) {
          prev.vectorScore = item.vectorScore
        }
        if (item.snippet && (!prev.snippet || prev.snippet.length < item.snippet.length)) {
          prev.snippet = item.snippet
        }
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore || (b.vectorScore ?? 0) - (a.vectorScore ?? 0) || String(a.key).localeCompare(String(b.key)))
    .slice(0, safeLimit)
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32)
}

export function createVectorApi({
  config,
  store,
  journalApi,
  entityApi,
  lessonApi,
  profileApi,
  embedder,
  clock = { now: () => Date.now() },
}) {
  function activeEmbedder() {
    if (embedder && typeof embedder.embed === 'function') return embedder
    const dims = config?.retrieval?.vector?.dimensions ?? DEFAULT_DIMENSIONS
    return createLocalEmbedder({ dimensions: dims })
  }

  function collectCorpusDocuments(scope = 'default') {
    const docs = []

    if (journalApi) {
      for (const date of journalApi.listJournalDates(config.home)) {
        const raw = journalApi.readJournal(config.home, date).trim()
        if (!raw) continue
        docs.push({
          docKey: `journal:${date}`,
          kind: 'journal',
          scope,
          logicalDate: date,
          title: `${date} 日报`,
          snippet: raw.slice(0, 600),
          fullText: raw,
        })
      }
    }

    if (entityApi) {
      for (const ent of entityApi.listEntities(config.home)) {
        const body = [
          ent.name,
          ent.type,
          ...ent.aliases,
          ...ent.facts.map(f => f.content),
        ].filter(Boolean).join('\n')
        if (!body.trim()) continue
        docs.push({
          docKey: `entity:${ent.slug}`,
          kind: 'entity',
          scope,
          logicalDate: null,
          title: ent.name,
          snippet: ent.facts[0]?.content ? `${ent.name}: ${ent.facts[0].content}` : `${ent.name} (${ent.type})`,
          fullText: body,
          meta: { slug: ent.slug, name: ent.name, type: ent.type, status: ent.status ?? 'active' },
        })
      }
    }

    if (lessonApi) {
      for (const lesson of lessonApi.listLessons(config.home)) {
        const body = [
          lesson.name,
          ...lesson.tags,
          ...lesson.triggers,
          ...lesson.entries.map(e => e.content),
        ].filter(Boolean).join('\n')
        if (!body.trim()) continue
        docs.push({
          docKey: `lesson:${lesson.slug}`,
          kind: 'lesson',
          scope,
          logicalDate: null,
          title: lesson.name,
          snippet: lesson.entries[0]?.content ? `${lesson.name}: ${lesson.entries[0].content}` : lesson.name,
          fullText: body,
          meta: { slug: lesson.slug, name: lesson.name, status: lesson.status ?? 'active' },
        })
      }
    }

    const profApi = profileApi ?? { readProfile, parseProfileEntries }
    const profRaw = profApi.readProfile(config.home).trim()
    if (profRaw) {
      const entries = profApi.parseProfileEntries(profRaw)
      for (const entry of entries) {
        if (!entry.content) continue
        docs.push({
          docKey: `profile:${entry.id || sha256Hex(entry.content)}`,
          kind: 'profile',
          scope,
          logicalDate: entry.added || null,
          title: entry.section || 'PROFILE.md',
          snippet: entry.content,
          fullText: `${entry.section || ''} ${entry.content}`,
        })
      }
    }

    return docs
  }

  function syncIndex({ scope = 'default' } = {}) {
    const emb = activeEmbedder()
    const docs = collectCorpusDocuments(scope)
    const existingRows = store.listEmbeddings({ scope })
    const existingByKey = new Map(existingRows.map(r => [r.docKey, r]))
    const currentKeys = new Set()

    let updated = 0
    let removed = 0
    const now = clock.now()

    for (const doc of docs) {
      currentKeys.add(doc.docKey)
      const textHash = sha256Hex(`${emb.dimensions ?? DEFAULT_DIMENSIONS}::${doc.fullText}`)
      const prev = existingByKey.get(doc.docKey)
      if (prev && prev.textHash === textHash && prev.dims === (emb.dimensions ?? DEFAULT_DIMENSIONS)) {
        continue
      }
      const vec = emb.embed(doc.fullText)
      const arr = vec instanceof Float32Array ? vec : new Float32Array(vec)
      store.upsertEmbedding({
        docKey: doc.docKey,
        kind: doc.kind,
        scope: doc.scope,
        logicalDate: doc.logicalDate,
        title: doc.title,
        snippet: doc.snippet,
        textHash,
        dims: arr.length,
        vectorBlob: encodeFloat32(arr),
        updatedAt: now,
      })
      updated += 1
    }

    for (const row of existingRows) {
      if (!currentKeys.has(row.docKey)) {
        store.deleteEmbedding(row.docKey)
        removed += 1
      }
    }

    return { total: docs.length, updated, removed }
  }

  function reindexAll({ scope = 'default' } = {}) {
    store.clearEmbeddings()
    return syncIndex({ scope })
  }

  function search({
    query = '',
    kinds,
    scope = 'default',
    dateFrom,
    dateTo,
    limit = 10,
    minScore,
    autoSync = true,
  } = {}) {
    const clean = String(query ?? '').trim()
    if (!clean) return []

    if (autoSync) {
      syncIndex({ scope })
    }

    const emb = activeEmbedder()
    const qVecRaw = emb.embed(clean)
    const qVec = qVecRaw instanceof Float32Array ? qVecRaw : new Float32Array(qVecRaw)
    const threshold = minScore !== undefined ? minScore : (config?.retrieval?.vector?.minScore ?? 0.12)
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 50)

    const rows = store.listEmbeddings({ kinds, scope, dateFrom, dateTo })
    const hits = []
    for (const row of rows) {
      const dVec = decodeFloat32(row.vectorBlob)
      if (dVec.length !== qVec.length) continue
      const score = cosineSimilarity(qVec, dVec)
      if (score >= threshold) {
        hits.push({
          docKey: row.docKey,
          kind: row.kind,
          scope: row.scope,
          logicalDate: row.logicalDate,
          title: row.title,
          snippet: row.snippet,
          score,
        })
      }
    }

    return hits
      .sort((a, b) => b.score - a.score || a.docKey.localeCompare(b.docKey))
      .slice(0, safeLimit)
  }

  return {
    dimensions: () => activeEmbedder().dimensions ?? DEFAULT_DIMENSIONS,
    syncIndex,
    reindexAll,
    search,
  }
}
