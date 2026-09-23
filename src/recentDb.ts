const DB_NAME = 'vyb-studio-recent'
const STORE_NAME = 'recent-vyb'
const DB_VERSION = 2
const MAX_GROUPS = 15
const MAX_FILES = 300
/** Bytes above this are never copied into IndexedDB (quota guard). */
const MAX_STORED_BYTES = 400 * 1024 * 1024

export type RecentGroupKind = 'file' | 'archive' | 'folder'

/** One database that can be reopened. */
export type RecentFileMeta = {
  id: string
  groupId: string
  groupLabel: string
  groupKind: RecentGroupKind
  /** Display name of the database itself. */
  filename: string
  /** Path inside the group (equals filename for standalone files). */
  path: string
  openedAt: number
  sizeBytes: number
  /** True when bytes are stored in IndexedDB; false when it must be re-read from a folder handle. */
  hasData: boolean
  /** id of the stored directory handle (src/folderAccess.ts) when hasData is false. */
  handleId: string | null
}

export type RecentGroup = {
  id: string
  label: string
  kind: RecentGroupKind
  openedAt: number
  handleId: string | null
  files: RecentFileMeta[]
}

export type NewRecentFile = {
  groupId: string
  groupLabel: string
  groupKind: RecentGroupKind
  filename: string
  path: string
  sizeBytes: number
  /** Omit/null to store a pointer-only entry. */
  data?: ArrayBuffer | null
  handleId?: string | null
}

type StoredRecent = RecentFileMeta & { data: ArrayBuffer | null }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      // Clean break: v1 stored flat entries with no grouping, nothing worth migrating.
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME)
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      store.createIndex('openedAt', 'openedAt', { unique: false })
      store.createIndex('groupId', 'groupId', { unique: false })
    }
  })
}

function txError(tx: IDBTransaction): Error {
  return tx.error ?? new Error('Recents storage transaction failed')
}

/** Stable key for a database inside a group, so re-opening upserts. */
function makeFileId(groupId: string, path: string): string {
  return `${groupId}::${path}`
}

/** Deterministic id for the folder/archive/file a database came from. */
export function makeGroupId(kind: RecentGroupKind, label: string): string {
  return `${kind}:${label.toLowerCase()}`
}

/** Ids to delete so we keep at most MAX_GROUPS groups and MAX_FILES files. */
function idsToTrim(all: StoredRecent[]): string[] {
  const newestByGroup = new Map<string, number>()
  for (const e of all) {
    const prev = newestByGroup.get(e.groupId) ?? 0
    if (e.openedAt > prev) newestByGroup.set(e.groupId, e.openedAt)
  }
  const staleGroups = new Set(
    [...newestByGroup.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(MAX_GROUPS)
      .map(([groupId]) => groupId),
  )
  const drop = new Set<string>()
  for (const e of all) if (staleGroups.has(e.groupId)) drop.add(e.id)
  const kept = all
    .filter((e) => !drop.has(e.id))
    .sort((a, b) => b.openedAt - a.openedAt || a.path.localeCompare(b.path))
  for (const e of kept.slice(MAX_FILES)) drop.add(e.id)
  return [...drop]
}

/** Upsert a batch of recents (same groupId + path replaces), then trim. */
export async function saveRecentFiles(files: NewRecentFile[]): Promise<void> {
  if (files.length === 0) return
  const openedAt = Date.now()
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const f of files) {
      const data = f.data ?? null
      const tooBig = data !== null && (data.byteLength > MAX_STORED_BYTES || f.sizeBytes > MAX_STORED_BYTES)
      const hasData = data !== null && !tooBig
      const record: StoredRecent = {
        id: makeFileId(f.groupId, f.path),
        groupId: f.groupId,
        groupLabel: f.groupLabel,
        groupKind: f.groupKind,
        filename: f.filename,
        path: f.path,
        openedAt,
        sizeBytes: f.sizeBytes,
        hasData,
        handleId: f.handleId ?? null,
        data: hasData ? data : null,
      }
      store.put(record)
    }
    const allReq = store.getAll()
    allReq.onsuccess = () => {
      for (const id of idsToTrim(allReq.result as StoredRecent[])) store.delete(id)
    }
    allReq.onerror = () => reject(allReq.error)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(txError(tx)) }
    tx.onabort = () => { db.close(); reject(txError(tx)) }
  })
}

/** All recents grouped by origin, newest group first. */
export async function getRecentGroups(): Promise<RecentGroup[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => {
      db.close()
      const groups = new Map<string, RecentGroup>()
      for (const e of req.result as StoredRecent[]) {
        const meta: RecentFileMeta = {
          id: e.id,
          groupId: e.groupId,
          groupLabel: e.groupLabel,
          groupKind: e.groupKind,
          filename: e.filename,
          path: e.path,
          openedAt: e.openedAt,
          sizeBytes: e.sizeBytes,
          hasData: e.hasData,
          handleId: e.handleId ?? null,
        }
        let group = groups.get(e.groupId)
        if (!group) {
          group = { id: e.groupId, label: e.groupLabel, kind: e.groupKind, openedAt: 0, handleId: null, files: [] }
          groups.set(e.groupId, group)
        }
        group.files.push(meta)
        if (meta.openedAt > group.openedAt) {
          group.openedAt = meta.openedAt
          group.label = meta.groupLabel
          group.kind = meta.groupKind
        }
        if (group.handleId === null) group.handleId = meta.handleId
      }
      const list = [...groups.values()]
      for (const g of list) g.files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
      list.sort((a, b) => b.openedAt - a.openedAt)
      resolve(list)
    }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

/** Read back the stored bytes of one recent database. */
export async function loadRecentFile(id: string): Promise<{ filename: string; data: ArrayBuffer }> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(id)
    req.onsuccess = () => {
      db.close()
      const entry = req.result as StoredRecent | undefined
      if (!entry) return reject(new Error('This database is no longer in your recents.'))
      if (!entry.hasData || !entry.data) {
        if (entry.handleId) {
          return reject(new Error(`"${entry.filename}" lives in a linked folder and was not copied here — reopen it from that folder.`))
        }
        return reject(new Error(`"${entry.filename}" was too large to keep a copy of — open the file again to view it.`))
      }
      resolve({ filename: entry.filename, data: entry.data })
    }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

/** Forget a single recent database. */
export async function removeRecentFile(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(txError(tx)) }
    tx.onabort = () => { db.close(); reject(txError(tx)) }
  })
}

/** Forget every database that came from one folder/archive/file. */
export async function removeRecentGroup(groupId: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.index('groupId').getAllKeys(IDBKeyRange.only(groupId))
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key)
    }
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(txError(tx)) }
    tx.onabort = () => { db.close(); reject(txError(tx)) }
  })
}

/** Drop all recents. */
export async function clearRecents(): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(txError(tx)) }
    tx.onabort = () => { db.close(); reject(txError(tx)) }
  })
}

export function formatRecentDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}
