import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseAnchor } from './util.js'

const SCHEMA_VERSION = 4

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  logical_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  anchor TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(logical_date, scope, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_anchor ON messages(anchor);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  logical_date UNINDEXED,
  scope UNINDEXED,
  anchor UNINDEXED,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, logical_date, scope, anchor)
  VALUES (new.id, new.text, new.logical_date, new.scope, new.anchor);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, logical_date, scope, anchor)
  VALUES ('delete', old.id, old.text, old.logical_date, old.scope, old.anchor);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, logical_date, scope, anchor)
  VALUES ('delete', old.id, old.text, old.logical_date, old.scope, old.anchor);
  INSERT INTO messages_fts(rowid, text, logical_date, scope, anchor)
  VALUES (new.id, new.text, new.logical_date, new.scope, new.anchor);
END;

CREATE TABLE IF NOT EXISTS session_state (
  session_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  parent_session_id TEXT,
  memory_mode TEXT NOT NULL DEFAULT 'full',
  scene_mode TEXT,
  last_seq INTEGER NOT NULL DEFAULT -1,
  replace_generation INTEGER NOT NULL DEFAULT 0,
  buffer_cursor TEXT,
  injected_entities TEXT NOT NULL DEFAULT '[]',
  injected_lessons TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  doc_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  logical_date TEXT,
  title TEXT,
  snippet TEXT,
  text_hash TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_kind_date ON embeddings(kind, logical_date);

CREATE TABLE IF NOT EXISTS rollover_state (
  logical_date TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  completed_at INTEGER,
  PRIMARY KEY (logical_date, scope)
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

const likeEscape = term => `%${String(term).replace(/[\\%_]/g, char => `\\${char}`)}%`

function parseJsonStringArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeSessionRow(row) {
  if (!row) return undefined
  return {
    sessionId: row.session_id,
    scope: row.scope,
    parentSessionId: row.parent_session_id,
    memoryMode: row.memory_mode,
    sceneMode: row.scene_mode ?? null,
    lastSeq: row.last_seq,
    replaceGeneration: row.replace_generation,
    bufferCursor: row.buffer_cursor ?? null,
    injectedEntities: parseJsonStringArray(row.injected_entities),
    injectedLessons: parseJsonStringArray(row.injected_lessons),
    updatedAt: row.updated_at,
  }
}

export function createMemoryStore(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')

  const currentVersion = db.prepare('PRAGMA user_version').get().user_version
  if (currentVersion < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL)
    const sessionCols = new Set(db.prepare("PRAGMA table_info('session_state')").all().map(col => col.name))
    if (!sessionCols.has('injected_lessons')) {
      db.exec("ALTER TABLE session_state ADD COLUMN injected_lessons TEXT NOT NULL DEFAULT '[]';")
    }
    if (!sessionCols.has('scene_mode')) {
      db.exec('ALTER TABLE session_state ADD COLUMN scene_mode TEXT;')
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  }

  const stmtInsertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (scope, session_id, parent_session_id, is_subagent, logical_date, seq, role, text, timestamp, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const stmtGetByAnchor = db.prepare('SELECT * FROM messages WHERE anchor = ? LIMIT 1')
  const stmtGetBySessionSeq = db.prepare('SELECT * FROM messages WHERE session_id = ? AND seq = ? LIMIT 1')
  const stmtBeforeRows = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND scope = ? AND seq < ?
    ORDER BY seq DESC, id DESC
    LIMIT ?
  `)
  const stmtAfterRows = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND scope = ? AND seq > ?
    ORDER BY seq ASC, id ASC
    LIMIT ?
  `)
  const stmtHasAnchorForDate = db.prepare('SELECT 1 AS ok FROM messages WHERE anchor = ? AND logical_date = ? LIMIT 1')
  const stmtMessagesForDate = db.prepare(`
    SELECT * FROM messages
    WHERE logical_date = ? AND scope = ?
    ORDER BY timestamp ASC, seq ASC, id ASC
  `)
  const stmtLatestUserMsg = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY seq DESC, id DESC
    LIMIT 1
  `)
  const stmtLatestUserOrCardMsg = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND role IN ('user', 'card')
    ORDER BY seq DESC, id DESC
    LIMIT 1
  `)
  const stmtGetMeta = db.prepare('SELECT value, updated_at FROM memory_meta WHERE key = ?')
  const stmtSetMeta = db.prepare(`
    INSERT INTO memory_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `)
  const stmtDeleteMeta = db.prepare('DELETE FROM memory_meta WHERE key = ?')
  const stmtDeleteMetaPrefix = db.prepare("DELETE FROM memory_meta WHERE key LIKE ? ESCAPE '\\'")
  const stmtListDates = db.prepare(`
    SELECT DISTINCT logical_date FROM messages
    WHERE scope = ?
    ORDER BY logical_date ASC
  `)
  const stmtGetSession = db.prepare('SELECT * FROM session_state WHERE session_id = ?')
  const stmtUpsertSession = db.prepare(`
    INSERT INTO session_state
      (session_id, scope, parent_session_id, memory_mode, scene_mode, last_seq, replace_generation, buffer_cursor, injected_entities, injected_lessons, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      scope = excluded.scope,
      parent_session_id = excluded.parent_session_id,
      memory_mode = excluded.memory_mode,
      scene_mode = excluded.scene_mode,
      last_seq = excluded.last_seq,
      replace_generation = excluded.replace_generation,
      buffer_cursor = excluded.buffer_cursor,
      injected_entities = excluded.injected_entities,
      injected_lessons = excluded.injected_lessons,
      updated_at = excluded.updated_at
  `)
  const stmtUpsertEmbedding = db.prepare(`
    INSERT INTO embeddings (doc_key, kind, scope, logical_date, title, snippet, text_hash, dims, vector, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_key) DO UPDATE SET
      kind = excluded.kind,
      scope = excluded.scope,
      logical_date = excluded.logical_date,
      title = excluded.title,
      snippet = excluded.snippet,
      text_hash = excluded.text_hash,
      dims = excluded.dims,
      vector = excluded.vector,
      updated_at = excluded.updated_at
  `)
  const stmtDeleteEmbedding = db.prepare('DELETE FROM embeddings WHERE doc_key = ?')
  const stmtClearEmbeddings = db.prepare('DELETE FROM embeddings')
  const stmtGetRollover = db.prepare('SELECT * FROM rollover_state WHERE logical_date = ? AND scope = ?')
  const stmtUpsertRollover = db.prepare(`
    INSERT INTO rollover_state (logical_date, scope, status, attempts, error, completed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(logical_date, scope) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      error = excluded.error,
      completed_at = excluded.completed_at
  `)
  const stmtPendingDates = db.prepare(`
    SELECT DISTINCT m.logical_date
    FROM messages m
    LEFT JOIN rollover_state r
      ON r.logical_date = m.logical_date AND r.scope = m.scope
    WHERE m.scope = ?
      AND m.logical_date < ?
      AND (r.status IS NULL OR r.status != 'done')
    ORDER BY m.logical_date ASC
  `)

  let closed = false

  function insertMessage(row) {
    const res = stmtInsertMessage.run(
      row.scope ?? 'default',
      row.sessionId,
      row.parentSessionId ?? null,
      row.isSubagent ? 1 : 0,
      row.logicalDate,
      row.seq,
      row.role,
      row.text,
      row.timestamp,
      row.anchor,
    )
    return { inserted: res.changes > 0, lastInsertRowid: Number(res.lastInsertRowid ?? 0) }
  }

  function getMessageByAnchor(anchor) {
    return stmtGetByAnchor.get(anchor)
  }

  function getMessageContext({ anchor, before = 2, after = 2, scope } = {}) {
    const cleanAnchor = String(anchor ?? '').trim()
    if (!cleanAnchor) return null

    let target = stmtGetByAnchor.get(cleanAnchor)
    if (!target) {
      const parsed = parseAnchor(cleanAnchor)
      if (parsed) {
        target = stmtGetBySessionSeq.get(parsed.sessionId, parsed.seq)
      }
    }
    if (!target) return null
    if (scope && target.scope !== scope) return null

    const clampWindow = (val, fallback) => {
      if (val === undefined || val === null) return fallback
      const n = Number.parseInt(val, 10)
      if (Number.isNaN(n)) return fallback
      return Math.min(Math.max(n, 0), 20)
    }
    const beforeLimit = clampWindow(before, 2)
    const afterLimit = clampWindow(after, 2)

    const beforeRows = beforeLimit > 0
      ? stmtBeforeRows.all(target.session_id, target.scope, target.seq, beforeLimit).reverse()
      : []
    const afterRows = afterLimit > 0
      ? stmtAfterRows.all(target.session_id, target.scope, target.seq, afterLimit)
      : []

    return {
      target,
      before: beforeRows,
      after: afterRows,
      messages: [...beforeRows, target, ...afterRows],
    }
  }

  function hasAnchorForDate(anchor, logicalDate) {
    return stmtHasAnchorForDate.get(anchor, logicalDate) !== undefined
  }

  function getMessagesForDate(logicalDate, scope = 'default') {
    return stmtMessagesForDate.all(logicalDate, scope)
  }

  function getLatestUserMessage(sessionId) {
    if (!sessionId) return undefined
    return stmtLatestUserMsg.get(sessionId)
  }

  function getLatestUserOrCardMessage(sessionId) {
    if (!sessionId) return undefined
    return stmtLatestUserOrCardMsg.get(sessionId)
  }

  function getMeta(key) {
    const row = stmtGetMeta.get(String(key))
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  function setMeta(key, value, updatedAt = Date.now()) {
    stmtSetMeta.run(String(key), JSON.stringify(value ?? null), updatedAt)
    return value
  }

  function deleteMeta(key) {
    return stmtDeleteMeta.run(String(key)).changes > 0
  }

  function deleteMetaByPrefix(prefix) {
    const escaped = `${String(prefix).replace(/[\\%_]/g, char => `\\${char}`)}%`
    return stmtDeleteMetaPrefix.run(escaped).changes
  }

  function listDatesWithMessages(scope = 'default') {
    return stmtListDates.all(scope).map(row => row.logical_date)
  }

  function dedupSearchTerms(query) {
    const seen = new Set()
    const terms = []
    for (const raw of String(query ?? '').trim().split(/\s+/)) {
      if (!raw) continue
      const lower = raw.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      terms.push(raw)
    }
    return terms
  }

  function searchMessages({ query = '', dateFrom, dateTo, scope = 'default', limit = 20 } = {}) {
    const terms = dedupSearchTerms(query)
    const longTerms = terms.filter(term => [...term].length >= 3)
    const shortTerms = terms.filter(term => [...term].length < 3)
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100)

    const baseWhere = ['m.scope = ?']
    const baseArgs = [scope]
    if (dateFrom) {
      baseWhere.push('m.logical_date >= ?')
      baseArgs.push(dateFrom)
    }
    if (dateTo) {
      baseWhere.push('m.logical_date <= ?')
      baseArgs.push(dateTo)
    }

    if (terms.length === 0) {
      if (!dateFrom && !dateTo) return []
      const browseSql = `
        SELECT m.*
        FROM messages m
        WHERE ${baseWhere.join(' AND ')}
        ORDER BY m.timestamp DESC, m.seq DESC
        LIMIT ?
      `
      return db.prepare(browseSql).all(...baseArgs, safeLimit)
    }

    // Phase 1: Strict AND matching across all terms
    const andWhere = [...baseWhere]
    const andArgs = [...baseArgs]
    for (const term of shortTerms) {
      andWhere.push("m.text LIKE ? ESCAPE '\\'")
      andArgs.push(likeEscape(term))
    }

    let andRows
    if (longTerms.length > 0) {
      const ftsMatch = longTerms.map(term => `"${term.replace(/"/g, '""')}"`).join(' ')
      const sql = `
        SELECT m.*
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ? AND ${andWhere.join(' AND ')}
        ORDER BY bm25(messages_fts), m.timestamp DESC
        LIMIT ?
      `
      andRows = db.prepare(sql).all(ftsMatch, ...andArgs, safeLimit)
    } else {
      const sql = `
        SELECT m.*
        FROM messages m
        WHERE ${andWhere.join(' AND ')}
        ORDER BY m.timestamp DESC, m.seq DESC
        LIMIT ?
      `
      andRows = db.prepare(sql).all(...andArgs, safeLimit)
    }

    if (andRows.length > 0 || terms.length <= 1) return andRows

    // Phase 2: Multi-term OR fallback ranked by matched term coverage
    const candidateLimit = Math.min(Math.max(safeLimit * 5, 50), 200)
    const byId = new Map()
    const baseClause = baseWhere.join(' AND ')

    if (longTerms.length > 0) {
      const ftsOr = longTerms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      const sql = `
        SELECT m.*
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ? AND ${baseClause}
        ORDER BY bm25(messages_fts), m.timestamp DESC
        LIMIT ?
      `
      for (const row of db.prepare(sql).all(ftsOr, ...baseArgs, candidateLimit)) {
        byId.set(row.id, row)
      }
    }

    if (shortTerms.length > 0) {
      const shortOr = shortTerms.map(() => "m.text LIKE ? ESCAPE '\\'").join(' OR ')
      const sql = `
        SELECT m.*
        FROM messages m
        WHERE ${baseClause} AND (${shortOr})
        ORDER BY m.timestamp DESC, m.seq DESC
        LIMIT ?
      `
      for (const row of db.prepare(sql).all(...baseArgs, ...shortTerms.map(likeEscape), candidateLimit)) {
        if (!byId.has(row.id)) byId.set(row.id, row)
      }
    }

    const lowerTerms = terms.map(term => ({ lower: term.toLowerCase(), len: [...term].length }))
    const scored = []
    for (const row of byId.values()) {
      const textLower = String(row.text ?? '').toLowerCase()
      let matchedCount = 0
      let matchedChars = 0
      for (const item of lowerTerms) {
        if (textLower.includes(item.lower)) {
          matchedCount += 1
          matchedChars += item.len
        }
      }
      if (matchedCount > 0) {
        scored.push({ row, matchedCount, matchedChars })
      }
    }

    scored.sort((a, b) =>
      b.matchedCount - a.matchedCount ||
      b.matchedChars - a.matchedChars ||
      b.row.timestamp - a.row.timestamp ||
      b.row.seq - a.row.seq)

    return scored.slice(0, safeLimit).map(item => item.row)
  }

  function getSessionState(sessionId) {
    return normalizeSessionRow(stmtGetSession.get(sessionId))
  }

  function upsertSessionState(sessionId, patch = {}) {
    const prev = getSessionState(sessionId)
    const next = {
      scope: patch.scope ?? prev?.scope ?? 'default',
      parentSessionId: patch.parentSessionId !== undefined ? patch.parentSessionId : (prev?.parentSessionId ?? null),
      memoryMode: patch.memoryMode ?? prev?.memoryMode ?? 'full',
      sceneMode: patch.sceneMode !== undefined ? patch.sceneMode : (prev?.sceneMode ?? null),
      lastSeq: patch.lastSeq !== undefined ? patch.lastSeq : (prev?.lastSeq ?? -1),
      replaceGeneration: patch.replaceGeneration !== undefined ? patch.replaceGeneration : (prev?.replaceGeneration ?? 0),
      bufferCursor: patch.bufferCursor !== undefined ? patch.bufferCursor : (prev?.bufferCursor ?? null),
      injectedEntities: patch.injectedEntities !== undefined
        ? patch.injectedEntities
        : (prev?.injectedEntities ?? []),
      injectedLessons: patch.injectedLessons !== undefined
        ? patch.injectedLessons
        : (prev?.injectedLessons ?? []),
      updatedAt: patch.updatedAt ?? Date.now(),
    }
    stmtUpsertSession.run(
      sessionId,
      next.scope,
      next.parentSessionId,
      next.memoryMode,
      next.sceneMode,
      next.lastSeq,
      next.replaceGeneration,
      next.bufferCursor,
      JSON.stringify(next.injectedEntities),
      JSON.stringify(next.injectedLessons),
      next.updatedAt,
    )
    return { sessionId, ...next }
  }

  function setSessionMode(sessionId, memoryMode, updatedAt = Date.now()) {
    return upsertSessionState(sessionId, { memoryMode, updatedAt })
  }

  function setSessionScene(sessionId, sceneMode, updatedAt = Date.now()) {
    if (sceneMode !== null && sceneMode !== 'work' && sceneMode !== 'chat') {
      throw new Error(`Invalid scene mode: ${sceneMode}`)
    }
    return upsertSessionState(sessionId, { sceneMode, updatedAt })
  }

  function getEffectiveScene(sessionId, defaultScene = 'work') {
    if (!sessionId) return defaultScene || 'work'
    return getSessionState(sessionId)?.sceneMode || defaultScene || 'work'
  }

  function upsertEmbedding({
    docKey,
    kind,
    scope = 'default',
    logicalDate = null,
    title = '',
    snippet = '',
    textHash,
    dims,
    vectorBlob,
    updatedAt = Date.now(),
  }) {
    stmtUpsertEmbedding.run(
      String(docKey),
      String(kind),
      String(scope),
      logicalDate ?? null,
      String(title ?? ''),
      String(snippet ?? ''),
      String(textHash),
      Number(dims),
      vectorBlob,
      updatedAt,
    )
  }

  function listEmbeddings({ kinds, scope, dateFrom, dateTo } = {}) {
    const where = []
    const args = []
    if (scope) {
      where.push('scope = ?')
      args.push(scope)
    }
    if (Array.isArray(kinds) && kinds.length > 0) {
      where.push(`kind IN (${kinds.map(() => '?').join(', ')})`)
      args.push(...kinds)
    }
    if (dateFrom) {
      where.push('(logical_date IS NULL OR logical_date >= ?)')
      args.push(dateFrom)
    }
    if (dateTo) {
      where.push('(logical_date IS NULL OR logical_date <= ?)')
      args.push(dateTo)
    }
    const sql = `SELECT * FROM embeddings${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY doc_key ASC`
    return db.prepare(sql).all(...args).map(row => ({
      docKey: row.doc_key,
      kind: row.kind,
      scope: row.scope,
      logicalDate: row.logical_date,
      title: row.title,
      snippet: row.snippet,
      textHash: row.text_hash,
      dims: row.dims,
      vectorBlob: row.vector,
      updatedAt: row.updated_at,
    }))
  }

  function deleteEmbedding(docKey) {
    return stmtDeleteEmbedding.run(String(docKey)).changes > 0
  }

  function clearEmbeddings() {
    return stmtClearEmbeddings.run().changes
  }

  function resetSessionDeltaCursor(sessionId, replaceGeneration, updatedAt = Date.now(), memoryMode) {
    return upsertSessionState(sessionId, {
      ...(memoryMode ? { memoryMode } : {}),
      replaceGeneration,
      bufferCursor: null,
      injectedEntities: [],
      injectedLessons: [],
      updatedAt,
    })
  }

  function getRolloverState(logicalDate, scope = 'default') {
    return stmtGetRollover.get(logicalDate, scope)
  }

  function setRolloverState(logicalDate, scope = 'default', patch = {}) {
    const prev = getRolloverState(logicalDate, scope)
    const status = patch.status ?? prev?.status ?? 'pending'
    const attempts = patch.attempts !== undefined ? patch.attempts : (prev?.attempts ?? 0)
    const error = patch.error !== undefined ? patch.error : (prev?.error ?? null)
    const completedAt = patch.completedAt !== undefined ? patch.completedAt : (prev?.completed_at ?? null)
    stmtUpsertRollover.run(logicalDate, scope, status, attempts, error, completedAt)
    return getRolloverState(logicalDate, scope)
  }

  function listPendingRolloverDates(currentLogicalDate, scope = 'default') {
    return stmtPendingDates.all(scope, currentLogicalDate).map(row => row.logical_date)
  }

  function deleteMessages({ anchor, date, keyword, sessionId, scope } = {}) {
    if (!anchor && !date && !keyword && !sessionId) {
      throw new Error('deleteMessages requires at least one filter (anchor, date, keyword, or sessionId)')
    }
    const where = []
    const args = []
    if (scope) {
      where.push('scope = ?')
      args.push(scope)
    }
    if (anchor) {
      where.push('anchor = ?')
      args.push(anchor)
    }
    if (date) {
      where.push('logical_date = ?')
      args.push(date)
    }
    if (sessionId) {
      where.push('session_id = ?')
      args.push(sessionId)
    }
    if (keyword) {
      where.push("text LIKE ? ESCAPE '\\'")
      args.push(likeEscape(keyword))
    }

    const filterSql = where.join(' AND ')
    db.exec('BEGIN IMMEDIATE')
    try {
      const matched = db.prepare(`SELECT id, anchor, logical_date FROM messages WHERE ${filterSql}`).all(...args)
      if (date) {
        db.prepare('DELETE FROM embeddings WHERE logical_date = ?').run(date)
      }
      if (keyword) {
        const pat = likeEscape(keyword)
        db.prepare("DELETE FROM embeddings WHERE snippet LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'").run(pat, pat)
      }
      if (matched.length === 0) {
        db.exec('COMMIT')
        return { deletedCount: 0, deletedAnchors: [], affectedDates: [] }
      }
      db.prepare(`DELETE FROM messages WHERE ${filterSql}`).run(...args)
      db.exec('COMMIT')
      return {
        deletedCount: matched.length,
        deletedAnchors: matched.map(row => row.anchor),
        affectedDates: [...new Set(matched.map(row => row.logical_date))].sort(),
      }
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  function rebuildFts() {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
  }

  function close() {
    if (closed) return
    closed = true
    db.close()
  }

  return {
    db,
    insertMessage,
    getMessageByAnchor,
    getMessageContext,
    hasAnchorForDate,
    getMessagesForDate,
    getLatestUserMessage,
    getLatestUserOrCardMessage,
    getMeta,
    setMeta,
    deleteMeta,
    deleteMetaByPrefix,
    listDatesWithMessages,
    searchMessages,
    getSessionState,
    upsertSessionState,
    setSessionMode,
    setSessionScene,
    getEffectiveScene,
    upsertEmbedding,
    listEmbeddings,
    deleteEmbedding,
    clearEmbeddings,
    resetSessionDeltaCursor,
    getRolloverState,
    setRolloverState,
    listPendingRolloverDates,
    deleteMessages,
    rebuildFts,
    close,
  }
}
