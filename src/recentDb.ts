const DB_NAME = 'vyb-studio-recent'
const STORE_NAME = 'recent-vyb'
const MAX_RECENT = 10

export type RecentEntry = {
  id: string
  filename: string
  openedAt: number
  data: ArrayBuffer
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('openedAt', 'openedAt', { unique: false })
      }
    }
  })
}

/** Save or update recent (LRU: same filename moves to first) */
export async function saveRecentDb(filename: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb()
  const all = await new Promise<RecentEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as RecentEntry[])
    req.onerror = () => reject(req.error)
  })
  const now = Date.now()
  const id = `${now}-${filename}`
  const entry: RecentEntry = { id, filename, openedAt: now, data }
  const sameFilenameIds = all.filter((e) => e.filename === filename).map((e) => e.id)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    sameFilenameIds.forEach((oldId) => store.delete(oldId))
    store.put(entry)
    tx.oncomplete = () => {
      db.close()
      trimRecent().then(resolve).catch(reject)
    }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function trimRecent(): Promise<void> {
  const db = await openDb()
  const all = await new Promise<RecentEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as RecentEntry[])
    req.onerror = () => reject(req.error)
  })
  db.close()
  if (all.length <= MAX_RECENT) return
  const sorted = all.sort((a, b) => b.openedAt - a.openedAt)
  const toRemove = sorted.slice(MAX_RECENT).map((e) => e.id)
  const db2 = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db2.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    toRemove.forEach((id) => store.delete(id))
    tx.oncomplete = () => { db2.close(); resolve() }
    tx.onerror = () => { db2.close(); reject(tx.error) }
  })
}

export async function getRecentList(): Promise<Omit<RecentEntry, 'data'>[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const idx = store.index('openedAt')
    const req = idx.getAll()
    req.onsuccess = () => {
      db.close()
      const all = (req.result as RecentEntry[])
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, MAX_RECENT)
      resolve(all.map(({ id, filename, openedAt }) => ({ id, filename, openedAt })))
    }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export async function loadRecentDb(id: string): Promise<{ filename: string; data: ArrayBuffer }> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(id)
    req.onsuccess = () => {
      db.close()
      const entry = req.result as RecentEntry | undefined
      if (!entry) return reject(new Error('Not found'))
      resolve({ filename: entry.filename, data: entry.data })
    }
    req.onerror = () => { db.close(); reject(req.error) }
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
