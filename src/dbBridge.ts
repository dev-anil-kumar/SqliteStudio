/**
 * Main-thread bridge to dbWorker. Runs all DB operations off the main thread.
 */

import type { FilterCondition, FilterOptions, GlobalSearchMode } from './filters'

export type QueryExecResult = { columns: string[]; values: unknown[][] }

export type TableInfo = {
  name: string
  columns: string[]
  columnDetails: { name: string; type: string; pk: number }[]
  rowCount: number
  primaryKey: string[]
  foreignKeys: { from: string; toTable: string; toColumn: string }[]
  createStatement: string | null
  hasRowid: boolean
}

export type DbInfo = {
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

export type SearchMatch = { tableName: string; matchCount: number }

type WorkerOut =
  | { type: 'opened'; id: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'result'; id: number; result: { columns: string[]; values: unknown[][] }[] }
  | { type: 'execError'; id: number; message: string }
  | { type: 'tableNames'; id: number; names: string[] }
  | { type: 'tableInfo'; id: number; info: TableInfo }
  | { type: 'dbInfo'; id: number; info: DbInfo }
  | { type: 'exported'; id: number; data: Uint8Array<ArrayBuffer> }
  | { type: 'searchResult'; id: number; matches: SearchMatch[] }

let worker: Worker | null = null
let nextId = 1
type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
const pending = new Map<number, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./dbWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const msg = e.data
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.type === 'opened') {
      p.resolve(undefined)
      return
    }
    if (msg.type === 'error' || msg.type === 'execError') {
      p.reject(new Error(msg.message))
      return
    }
    if (msg.type === 'result') {
      const first = msg.result[0]
      p.resolve(first ? { columns: first.columns, values: first.values } as QueryExecResult : null)
      return
    }
    if (msg.type === 'tableNames') {
      p.resolve(msg.names)
      return
    }
    if (msg.type === 'tableInfo' || msg.type === 'dbInfo') {
      p.resolve(msg.info)
      return
    }
    if (msg.type === 'exported') {
      p.resolve(msg.data)
      return
    }
    if (msg.type === 'searchResult') {
      p.resolve(msg.matches)
      return
    }
  }
  worker.onerror = (err) => {
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  }
  return worker
}

const baseUrl = (import.meta.env.BASE_URL as string) || '/'

/** Posts a message with a fresh id and resolves when the worker answers it. */
function request<T>(payload: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    if (transfer) {
      getWorker().postMessage({ ...payload, id }, transfer)
    } else {
      getWorker().postMessage({ ...payload, id })
    }
  })
}

export function openDb(bytes: Uint8Array): Promise<void> {
  return request<void>({ type: 'open', baseUrl, bytes: bytes.buffer }, [bytes.buffer])
}

export function execQuery(query: string): Promise<QueryExecResult | null> {
  return request<QueryExecResult | null>({ type: 'exec', query })
}

export function getTableNames(): Promise<string[]> {
  return request<string[]>({ type: 'getTableNames' })
}

export function getTableInfo(name: string): Promise<TableInfo> {
  return request<TableInfo>({ type: 'getTableInfo', name })
}

export function getDbInfo(): Promise<DbInfo> {
  return request<DbInfo>({ type: 'getDbInfo' })
}

export function exportDb(): Promise<Uint8Array<ArrayBuffer>> {
  return request<Uint8Array<ArrayBuffer>>({ type: 'export' })
}

/** Finds every table holding `value`, using the given match mode. */
export function searchAllTables(
  value: string,
  mode: GlobalSearchMode,
  options: FilterOptions,
  columnFilter?: string
): Promise<SearchMatch[]> {
  return request<SearchMatch[]>({ type: 'searchAll', value, mode, options, columnFilter })
}

/** Finds tables where every key in the JSON object matches a column value. */
export function searchJsonCriteria(
  criteria: Record<string, unknown>
): Promise<SearchMatch[]> {
  return request<SearchMatch[]>({ type: 'searchJson', criteria })
}

/** Finds tables that carry all referenced columns and match the conditions. */
export function searchConditions(
  conditions: FilterCondition[],
  join: 'AND' | 'OR',
  options: FilterOptions
): Promise<SearchMatch[]> {
  return request<SearchMatch[]>({ type: 'searchConditions', conditions, join, options })
}
