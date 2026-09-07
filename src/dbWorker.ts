/**
 * Web Worker: runs sql.js so DB and queries don't block the main thread.
 */

import initSqlJs from 'sql.js'
import {
  buildCount,
  buildGlobalWhere,
  buildJsonCriteriaWhere,
  buildWhereClause,
  quoteIdent,
  type FilterCondition,
  type FilterOptions,
  type GlobalSearchMode,
} from './filters'

type ForeignKeyInfo = { from: string; toTable: string; toColumn: string }
type TableInfo = {
  name: string
  columns: string[]
  columnDetails: { name: string; type: string; pk: number }[]
  rowCount: number
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  createStatement: string | null
  hasRowid: boolean
}

type DbInfo = {
  sqliteVersion: string
  pageSize: number
  pageCount: number
  sizeBytes: number
  encoding: string
  userVersion: number
  applicationId: number
  journalMode: string
  tableCount: number
  viewCount: number
  indexCount: number
  triggerCount: number
}

type SearchMatch = { tableName: string; matchCount: number }

type InMessage =
  | { type: 'open'; baseUrl: string; bytes: ArrayBuffer; id: number }
  | { type: 'exec'; id: number; query: string }
  | { type: 'getTableNames'; id: number }
  | { type: 'getTableInfo'; id: number; name: string }
  | { type: 'getDbInfo'; id: number }
  | { type: 'export'; id: number }
  | {
      type: 'searchAll'
      id: number
      value: string
      mode: GlobalSearchMode
      options: FilterOptions
      columnFilter?: string
    }
  | { type: 'searchJson'; id: number; criteria: Record<string, unknown> }
  | {
      type: 'searchConditions'
      id: number
      conditions: FilterCondition[]
      join: 'AND' | 'OR'
      options: FilterOptions
    }

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
let db: import('sql.js').Database | null = null

async function ensureSql(baseUrl: string) {
  if (SQL) return
  SQL = await initSqlJs({
    locateFile: (file: string) => `${baseUrl.replace(/\/$/, '')}/${file}`,
  })
}

/* ---------------------------------------------------------------- *
 * Custom SQL functions backing the regex and fuzzy filter operators.
 * ---------------------------------------------------------------- */

const MAX_EDIT_LEN = 512
const regexCache = new Map<string, RegExp | null>()

function compileRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null
  let source = pattern
  let flags = ''
  // Inline (?i) isn't valid in JS, so translate the common case to a flag.
  const inline = /^\(\?([imsu]+)\)/.exec(source)
  if (inline) {
    flags = inline[1]
    source = source.slice(inline[0].length)
  }
  let compiled: RegExp | null = null
  try {
    compiled = new RegExp(source, flags)
  } catch {
    compiled = null
  }
  if (regexCache.size > 200) regexCache.clear()
  regexCache.set(pattern, compiled)
  return compiled
}

/** Levenshtein distance, two-row variant. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  if (a.length > MAX_EDIT_LEN) a = a.slice(0, MAX_EDIT_LEN)
  if (b.length > MAX_EDIT_LEN) b = b.slice(0, MAX_EDIT_LEN)

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

function registerFunctions(database: import('sql.js').Database) {
  // SQLite rewrites `X REGEXP Y` as regexp(Y, X) — pattern first.
  database.create_function('REGEXP', (pattern: unknown, value: unknown) => {
    if (value === null || value === undefined || pattern === null) return 0
    const re = compileRegex(String(pattern))
    if (!re) return 0
    re.lastIndex = 0
    return re.test(String(value)) ? 1 : 0
  })

  database.create_function('EDITDIST', (a: unknown, b: unknown) => {
    if (a === null || a === undefined || b === null || b === undefined) {
      return MAX_EDIT_LEN + 1
    }
    return editDistance(String(a), String(b))
  })
}

/* ---------------------------------------------------------------- */

function scalar(sql: string): unknown {
  if (!db) return null
  try {
    const res = db.exec(sql)
    if (res[0] && res[0].values.length > 0) return res[0].values[0][0]
  } catch {
    /* pragma unsupported */
  }
  return null
}

function getTableInfo(name: string): TableInfo {
  if (!db) throw new Error('Database not open')
  const quoted = quoteIdent(name)
  const schemaRes = db.exec(`PRAGMA table_info(${quoted});`)
  const columns: string[] = []
  const columnDetails: { name: string; type: string; pk: number }[] = []
  let rowCount = 0
  const primaryKey: string[] = []

  if (schemaRes[0]) {
    const cols = schemaRes[0].columns
    const nameIdx = cols.indexOf('name')
    const typeIdx = cols.indexOf('type')
    const pkIdx = cols.indexOf('pk')
    if (nameIdx !== -1) {
      schemaRes[0].values.forEach((row: unknown[]) => {
        const colName = String(row[nameIdx])
        columns.push(colName)
        const type = typeIdx >= 0 ? String(row[typeIdx]) : ''
        const pk = pkIdx >= 0 ? Number(row[pkIdx]) || 0 : 0
        columnDetails.push({ name: colName, type, pk })
        if (pk > 0) primaryKey.push(colName)
      })
      primaryKey.sort((a, b) => {
        const aOrd = columnDetails.find((c) => c.name === a)?.pk ?? 0
        const bOrd = columnDetails.find((c) => c.name === b)?.pk ?? 0
        return aOrd - bOrd
      })
    }
  }

  const foreignKeys: ForeignKeyInfo[] = []
  try {
    const fkRes = db.exec(`PRAGMA foreign_key_list(${quoted});`)
    if (fkRes[0]) {
      const cols = fkRes[0].columns
      const fromIdx = cols.indexOf('from')
      const tableIdx = cols.indexOf('table')
      const toIdx = cols.indexOf('to')
      if (fromIdx >= 0 && tableIdx >= 0 && toIdx >= 0) {
        fkRes[0].values.forEach((row: unknown[]) => {
          foreignKeys.push({
            from: String(row[fromIdx]),
            toTable: String(row[tableIdx]),
            toColumn: String(row[toIdx]),
          })
        })
      }
    }
  } catch {
    /* ignore */
  }

  const countRes = db.exec(`SELECT COUNT(*) as count FROM ${quoted};`)
  if (countRes[0] && countRes[0].values.length > 0) {
    rowCount = Number(countRes[0].values[0][0]) || 0
  }

  let createStatement: string | null = null
  try {
    const sqlRes = db.exec(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=${sqlName(name)};`
    )
    if (sqlRes[0] && sqlRes[0].values.length > 0) {
      const sqlIdx = sqlRes[0].columns.indexOf('sql')
      if (sqlIdx >= 0 && sqlRes[0].values[0][sqlIdx] != null) {
        createStatement = String(sqlRes[0].values[0][sqlIdx])
      }
    }
  } catch {
    /* ignore */
  }

  // WITHOUT ROWID tables reject `ORDER BY rowid`, so callers need to know.
  const hasRowid = !(createStatement && /WITHOUT\s+ROWID/i.test(createStatement))

  return {
    name,
    columns,
    columnDetails,
    rowCount,
    primaryKey,
    foreignKeys,
    createStatement,
    hasRowid,
  }
}

function sqlName(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function getDbInfo(): DbInfo {
  const pageSize = Number(scalar('PRAGMA page_size;')) || 0
  const pageCount = Number(scalar('PRAGMA page_count;')) || 0
  const counts: Record<string, number> = {}
  if (db) {
    try {
      const res = db.exec(
        "SELECT type, COUNT(*) AS c FROM sqlite_master GROUP BY type;"
      )
      if (res[0]) {
        res[0].values.forEach((row: unknown[]) => {
          counts[String(row[0])] = Number(row[1]) || 0
        })
      }
    } catch {
      /* ignore */
    }
  }
  return {
    sqliteVersion: String(scalar('SELECT sqlite_version();') ?? '—'),
    pageSize,
    pageCount,
    sizeBytes: pageSize * pageCount,
    encoding: String(scalar('PRAGMA encoding;') ?? '—'),
    userVersion: Number(scalar('PRAGMA user_version;')) || 0,
    applicationId: Number(scalar('PRAGMA application_id;')) || 0,
    journalMode: String(scalar('PRAGMA journal_mode;') ?? '—'),
    tableCount: counts.table ?? 0,
    viewCount: counts.view ?? 0,
    indexCount: counts.index ?? 0,
    triggerCount: counts.trigger ?? 0,
  }
}

function listTableNames(): string[] {
  if (!db) return []
  const res = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  )
  const names: string[] = []
  if (res[0]) {
    const idx = res[0].columns.indexOf('name')
    if (idx !== -1) res[0].values.forEach((row: unknown[]) => names.push(String(row[idx])))
  }
  return names
}

function countMatches(tableName: string, where: string | null): number {
  if (!db || !where) return 0
  const res = db.exec(buildCount(tableName, where))
  if (res[0] && res[0].values.length > 0) return Number(res[0].values[0][0]) || 0
  return 0
}

/** Runs one WHERE-builder across every table, keeping the ones that match. */
function searchTables(
  makeWhere: (info: TableInfo) => string | null
): SearchMatch[] {
  const matches: SearchMatch[] = []
  for (const tableName of listTableNames()) {
    try {
      const info = getTableInfo(tableName)
      if (info.columns.length === 0) continue
      const where = makeWhere(info)
      if (!where) continue
      const matchCount = countMatches(tableName, where)
      if (matchCount > 0) matches.push({ tableName, matchCount })
    } catch {
      /* skip tables the filter can't apply to */
    }
  }
  return matches.sort((a, b) => b.matchCount - a.matchCount)
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data
  try {
    if (msg.type === 'open') {
      await ensureSql(msg.baseUrl)
      if (db) {
        db.close()
        db = null
      }
      db = new SQL!.Database(new Uint8Array(msg.bytes))
      registerFunctions(db)
      regexCache.clear()
      self.postMessage({ type: 'opened', id: msg.id })
      return
    }

    if (!db) {
      const id = 'id' in msg ? msg.id : 0
      self.postMessage({ type: 'error', id, message: 'Database not open' })
      return
    }

    if (msg.type === 'exec') {
      const result = db.exec(msg.query)
      let serialized = result.map((r: { columns: string[]; values: unknown[][] }) => ({ columns: r.columns, values: r.values }))
      // For DML/DDL (UPDATE, DELETE, INSERT, CREATE, etc.) there are no result rows; show changes() and last_insert_rowid()
      const first = serialized[0]
      if (!first || first.columns.length === 0) {
        const changeRes = db.exec('SELECT changes() AS changes, last_insert_rowid() AS last_insert_rowid')
        if (changeRes[0] && changeRes[0].columns.length > 0) {
          serialized = [{ columns: changeRes[0].columns, values: changeRes[0].values }]
        }
      }
      self.postMessage({ type: 'result', id: msg.id, result: serialized })
      return
    }

    if (msg.type === 'getTableNames') {
      self.postMessage({ type: 'tableNames', id: msg.id, names: listTableNames() })
      return
    }

    if (msg.type === 'getTableInfo') {
      const info = getTableInfo(msg.name)
      self.postMessage({ type: 'tableInfo', id: msg.id, info })
      return
    }

    if (msg.type === 'getDbInfo') {
      self.postMessage({ type: 'dbInfo', id: msg.id, info: getDbInfo() })
      return
    }

    if (msg.type === 'export') {
      const data = db.export()
      self.postMessage({ type: 'exported', id: msg.id, data }, { transfer: [data.buffer] })
      return
    }

    if (msg.type === 'searchAll') {
      const needle = msg.columnFilter?.trim().toLowerCase()
      const matches = searchTables((info) => {
        const columns = needle
          ? info.columns.filter((c) => c.toLowerCase().includes(needle))
          : info.columns
        return buildGlobalWhere(columns, msg.value, msg.mode, msg.options)
      })
      self.postMessage({ type: 'searchResult', id: msg.id, matches })
      return
    }

    if (msg.type === 'searchJson') {
      const matches = searchTables((info) =>
        buildJsonCriteriaWhere(info.columns, msg.criteria)
      )
      self.postMessage({ type: 'searchResult', id: msg.id, matches })
      return
    }

    if (msg.type === 'searchConditions') {
      const matches = searchTables((info) => {
        const lower = new Set(info.columns.map((c) => c.toLowerCase()))
        // Only tables that actually have every referenced column.
        if (!msg.conditions.every((c) => lower.has(c.column.toLowerCase()))) return null
        const resolved = msg.conditions.map((c) => ({
          ...c,
          column: info.columns.find((col) => col.toLowerCase() === c.column.toLowerCase())!,
        }))
        return buildWhereClause(resolved, msg.join, msg.options)
      })
      self.postMessage({ type: 'searchResult', id: msg.id, matches })
      return
    }
  } catch (err) {
    const id = 'id' in msg ? msg.id : 0
    const message = err instanceof Error ? err.message : String(err)
    if (msg.type === 'exec') {
      self.postMessage({ type: 'execError', id, message })
    } else {
      self.postMessage({ type: 'error', id, message })
    }
  }
}
