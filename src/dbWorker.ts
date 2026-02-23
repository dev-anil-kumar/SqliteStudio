/**
 * Web Worker: runs sql.js so DB and queries don't block the main thread.
 */

import initSqlJs from 'sql.js'

type ForeignKeyInfo = { from: string; toTable: string; toColumn: string }
type TableInfo = {
  name: string
  columns: string[]
  columnDetails: { name: string; type: string; pk: number }[]
  rowCount: number
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  createStatement: string | null
}

type InMessage =
  | { type: 'open'; baseUrl: string; bytes: ArrayBuffer; id: number }
  | { type: 'exec'; id: number; query: string }
  | { type: 'getTableNames'; id: number }
  | { type: 'getTableInfo'; id: number; name: string }
  | { type: 'export'; id: number }

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
let db: import('sql.js').Database | null = null

async function ensureSql(baseUrl: string) {
  if (SQL) return
  SQL = await initSqlJs({
    locateFile: (file: string) => `${baseUrl.replace(/\/$/, '')}/${file}`,
  })
}

function getTableInfo(name: string): TableInfo {
  if (!db) throw new Error('Database not open')
  const quoted = `"${name.replace(/"/g, '""')}"`
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
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=${quoted};`
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

  return {
    name,
    columns,
    columnDetails,
    rowCount,
    primaryKey,
    foreignKeys,
    createStatement,
  }
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
      const res = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
      const names: string[] = []
      if (res[0]) {
        const idx = res[0].columns.indexOf('name')
        if (idx !== -1) {
          res[0].values.forEach((row: unknown[]) => names.push(String(row[idx])))
        }
      }
      self.postMessage({ type: 'tableNames', id: msg.id, names })
      return
    }

    if (msg.type === 'getTableInfo') {
      const info = getTableInfo(msg.name)
      self.postMessage({ type: 'tableInfo', id: msg.id, info })
      return
    }

    if (msg.type === 'export') {
      const data = db.export()
      self.postMessage({ type: 'exported', id: msg.id, data }, { transfer: [data.buffer] })
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
