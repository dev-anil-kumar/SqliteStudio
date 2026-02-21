/**
 * Main-thread bridge to dbWorker. Runs all DB operations off the main thread.
 */

export type QueryExecResult = { columns: string[]; values: unknown[][] }

export type TableInfo = {
  name: string
  columns: string[]
  columnDetails: { name: string; type: string; pk: number }[]
  rowCount: number
  primaryKey: string[]
  foreignKeys: { from: string; toTable: string; toColumn: string }[]
  createStatement: string | null
}

export type AdvancedSearchMatch = { tableName: string; matchCount: number }

type WorkerOut =
  | { type: 'opened'; id: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'result'; id: number; result: { columns: string[]; values: unknown[][] }[] }
  | { type: 'execError'; id: number; message: string }
  | { type: 'tableNames'; id: number; names: string[] }
  | { type: 'tableInfo'; id: number; info: TableInfo }
  | { type: 'exported'; id: number; data: Uint8Array }
  | { type: 'advancedSearchResult'; id: number; matches: AdvancedSearchMatch[] }

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
    if (msg.type === 'tableInfo') {
      p.resolve(msg.info)
      return
    }
    if (msg.type === 'exported') {
      p.resolve(msg.data)
      return
    }
    if (msg.type === 'advancedSearchResult') {
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

export function openDb(bytes: Uint8Array): Promise<void> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage(
      { type: 'open', baseUrl, bytes: bytes.buffer, id },
      [bytes.buffer]
    )
  })
}

export function execQuery(query: string): Promise<QueryExecResult | null> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'exec', id, query })
  })
}

export function getTableNames(): Promise<string[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'getTableNames', id })
  })
}

export function getTableInfo(name: string): Promise<TableInfo> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'getTableInfo', id, name })
  })
}

export function exportDb(): Promise<Uint8Array> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'export', id })
  })
}

export function advancedSearchRaw(value: string): Promise<AdvancedSearchMatch[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'advancedSearchRaw', id, value })
  })
}

export function advancedSearchJson(criteria: Record<string, unknown>): Promise<AdvancedSearchMatch[]> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ type: 'advancedSearchJson', id, criteria })
  })
}
