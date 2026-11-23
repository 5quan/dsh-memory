import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

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
  last_seq INTEGER NOT NULL DEFAULT -1,
  replace_generation INTEGER NOT NULL DEFAULT 0,
  buffer_cursor TEXT,
  injected_entities TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rollover_state (
  logical_date TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  completed_at INTEGER,
  PRIMARY KEY (logical_date, scope)
);

PRAGMA user_version = ${SCHEMA_VERSION};
`

const likeEscape = term => `%${String(term).replace(/[\\%_]/g, char => `\\${char}`)}%`

function normalizeSessionRow(row) {
  if (!row) return undefined
  let injectedEntities = []
  try {
    const parsed = JSON.parse(row.injected_entities || '[]')
    if (Array.isArray(parsed)) injectedEntities = parsed
  } catch {
    injectedEntities = []
  }
  return {
    sessionId: row.session_id,
    scope: row.scope,
    parentSessionId: row.parent_session_id,
    memoryMode: row.memory_mode,
    lastSeq: row.last_seq,
    replaceGeneration: row.replace_generation,
    bufferCursor: row.buffer_cursor ?? null,
    injectedEntities,
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
  if (currentVersion !== SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL)
  }

  const stmtInsertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (scope, session_id, parent_session_id, is_subagent, logical_date, seq, role, text, timestamp, anchor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const stmtGetByAnchor = db.prepare('SELECT * FROM messages WHERE anchor = ? LIMIT 1')
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
  const stmtListDates = db.prepare(`
    SELECT DISTINCT logical_date FROM messages
    WHERE scope = ?
    ORDER BY logical_date ASC
  `)
  const stmtGetSession = db.prepare('SELECT * FROM session_state WHERE session_id = ?')
  const stmtUpsertSession = db.prepare(`
    INSERT INTO session_state
      (session_id, scope, parent_session_id, memory_mode, last_seq, replace_generation, buffer_cursor, injected_entities, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      scope = excluded.scope,
      parent_session_id = excluded.parent_session_id,
      memory_mode = excluded.memory_mode,
      last_seq = excluded.last_seq,
      replace_generation = excluded.replace_generation,
      buffer_cursor = excluded.buffer_cursor,
      injected_entities = excluded.injected_entities,
      updated_at = excluded.updated_at
  `)
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

  function listDatesWithMessages(scope = 'default') {
    return stmtListDates.all(scope).map(row => row.logical_date)
  }

  function searchMessages({ query = '', dateFrom, dateTo, scope = 'default', limit = 20 } = {}) {
    const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean)
    const longTerms = terms.filter(term => [...term].length >= 3)
    const shortTerms = terms.filter(term => [...term].length < 3)
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100)

    if (terms.length === 0 && !dateFrom && !dateTo) return []

    const where = ['m.scope = ?']
    const args = [scope]
    if (dateFrom) {
      where.push('m.logical_date >= ?')
      args.push(dateFrom)
    }
    if (dateTo) {
      where.push('m.logical_date <= ?')
      args.push(dateTo)
    }
    for (const term of shortTerms) {
      where.push("m.text LIKE ? ESCAPE '\\'")
      args.push(likeEscape(term))
    }

    if (longTerms.length > 0) {
      const ftsMatch = longTerms.map(term => `"${term.replace(/"/g, '""')}"`).join(' ')
      const sql = `
        SELECT m.*
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY bm25(messages_fts), m.timestamp DESC
        LIMIT ?
      `
      return db.prepare(sql).all(ftsMatch, ...args, safeLimit)
    }

    const sql = `
      SELECT m.*
      FROM messages m
      WHERE ${where.join(' AND ')}
      ORDER BY m.timestamp DESC, m.seq DESC
      LIMIT ?
    `
    return db.prepare(sql).all(...args, safeLimit)
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
      lastSeq: patch.lastSeq !== undefined ? patch.lastSeq : (prev?.lastSeq ?? -1),
      replaceGeneration: patch.replaceGeneration !== undefined ? patch.replaceGeneration : (prev?.replaceGeneration ?? 0),
      bufferCursor: patch.bufferCursor !== undefined ? patch.bufferCursor : (prev?.bufferCursor ?? null),
      injectedEntities: patch.injectedEntities !== undefined
        ? patch.injectedEntities
        : (prev?.injectedEntities ?? []),
      updatedAt: patch.updatedAt ?? Date.now(),
    }
    stmtUpsertSession.run(
      sessionId,
      next.scope,
      next.parentSessionId,
      next.memoryMode,
      next.lastSeq,
      next.replaceGeneration,
      next.bufferCursor,
      JSON.stringify(next.injectedEntities),
      next.updatedAt,
    )
    return { sessionId, ...next }
  }

  function setSessionMode(sessionId, memoryMode, updatedAt = Date.now()) {
    return upsertSessionState(sessionId, { memoryMode, updatedAt })
  }

  function resetSessionDeltaCursor(sessionId, replaceGeneration, updatedAt = Date.now(), memoryMode) {
    return upsertSessionState(sessionId, {
      ...(memoryMode ? { memoryMode } : {}),
      replaceGeneration,
      bufferCursor: null,
      injectedEntities: [],
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
    hasAnchorForDate,
    getMessagesForDate,
    getLatestUserMessage,
    listDatesWithMessages,
    searchMessages,
    getSessionState,
    upsertSessionState,
    setSessionMode,
    resetSessionDeltaCursor,
    getRolloverState,
    setRolloverState,
    listPendingRolloverDates,
    deleteMessages,
    rebuildFts,
    close,
  }
}
