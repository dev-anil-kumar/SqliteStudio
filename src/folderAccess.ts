/**
 * Linked folders: File System Access API directory handles parked in IndexedDB
 * so a folder can be picked once and re-read — with whatever it contains that
 * day — on every later visit.
 *
 * Handles are stored by structured clone, which is what makes them survive a
 * reload. Browsers without the API (or without clonable handles) must degrade
 * quietly: every function here either returns an empty/false result or throws a
 * message worth showing to a human.
 */

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite'
      id?: string
      startIn?: string
    }) => Promise<FileSystemDirectoryHandle>
  }

  interface FileSystemHandle {
    queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  }

  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>
  }
}

const DB_NAME = 'vyb-studio-folders'
const STORE_NAME = 'folders'
// Deep trees and huge folders would block the picker for seconds; cap both.
const MAX_DEPTH = 6
const MAX_ENTRIES = 500
const SKIP_DIRS = ['node_modules', '.git', '__MACOSX']
// Same list dbSource accepts, plus extension-less files (zip-probed by the caller).
const SCAN_EXTENSIONS = ['.vyp', '.db', '.sqlite', '.sqlite3', '.sqlitedb', '.vyb', '.zip']

export type LinkedFolder = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemDirectoryHandle
}

/** A database-ish file found while scanning a linked folder. */
export type FolderEntry = {
  /** Path relative to the folder root, e.g. "backups/jan.vyp". */
  path: string
  name: string
  sizeBytes: number
  lastModified: number
}

/** Whether this browser can link a folder at all. */
export function supportsFolderAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
  })
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return cleaned.slice(0, 32) || 'folder'
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

async function putFolder(folder: LinkedFolder): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(folder)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error)
    }
  })
}

/** Linked folders, most recently added first. Never throws — returns [] instead. */
export async function listFolders(): Promise<LinkedFolder[]> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return []
  }
  try {
    const all = await new Promise<LinkedFolder[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => resolve(req.result as LinkedFolder[])
      req.onerror = () => reject(req.error)
    })
    return all
      .filter((entry) => Boolean(entry && entry.handle))
      .sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  } finally {
    db.close()
  }
}

/**
 * Stores a handle, or refreshes the existing row when the same directory is
 * already linked (`isSameEntry`), so re-picking a folder never duplicates it.
 */
export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<LinkedFolder> {
  const existing = await listFolders()
  for (const entry of existing) {
    let same = false
    try {
      same = await entry.handle.isSameEntry(handle)
    } catch {
      same = false
    }
    if (same) {
      const refreshed: LinkedFolder = { ...entry, label: handle.name, addedAt: Date.now(), handle }
      try {
        await putFolder(refreshed)
      } catch {
        // Unwritable storage still leaves a usable handle for this session.
      }
      return refreshed
    }
  }

  const folder: LinkedFolder = {
    id: `${slug(handle.name)}-${randomSuffix()}`,
    label: handle.name,
    addedAt: Date.now(),
    handle,
  }
  try {
    await putFolder(folder)
  } catch {
    // Same here: a browser that cannot clone handles just loses them on reload.
  }
  return folder
}

/** Asks for a folder. Resolves to null when the user dismisses the picker. */
export async function pickFolder(): Promise<LinkedFolder | null> {
  const picker = typeof window !== 'undefined' ? window.showDirectoryPicker : undefined
  if (!picker) {
    throw new Error(
      'This browser cannot link folders — try Chrome, Edge or another Chromium-based browser'
    )
  }

  let handle: FileSystemDirectoryHandle
  try {
    handle = await picker.call(window, { mode: 'read', id: 'vyb-db-folder' })
  } catch (err) {
    if (isAbort(err)) return null
    throw new Error(errorMessage(err, 'Could not open that folder'))
  }

  return rememberFolder(handle)
}

export async function removeFolder(id: string): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      resolve()
    }
  })
}

export async function clearFolders(): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      resolve()
    }
  })
}

/**
 * Read permission for a stored handle. Permission lapses between visits, so
 * this has to run (interactively, from a user gesture) before any re-read.
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  interactive = true
): Promise<boolean> {
  try {
    // Browsers without the permission methods hand back readable handles already.
    if (typeof handle.queryPermission !== 'function') return true

    const current = await handle.queryPermission({ mode: 'read' })
    if (current === 'granted') return true
    if (!interactive) return false
    if (typeof handle.requestPermission !== 'function') return false

    const asked = await handle.requestPermission({ mode: 'read' })
    return asked === 'granted'
  } catch {
    return false
  }
}

function isScannable(name: string): boolean {
  const lower = name.toLowerCase()
  if (SCAN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true
  // No extension at all: could be a bare SQLite file or a renamed archive.
  return lower.lastIndexOf('.') <= 0
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  found: FolderEntry[]
): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_ENTRIES) return
  if (typeof dir.values !== 'function') return

  try {
    for await (const entry of dir.values()) {
      if (found.length >= MAX_ENTRIES) break
      if (entry.name.startsWith('.') || SKIP_DIRS.includes(entry.name)) continue

      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      try {
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle, path, depth + 1, found)
        } else if (isScannable(entry.name)) {
          const file = await (entry as FileSystemFileHandle).getFile()
          found.push({
            path,
            name: entry.name,
            sizeBytes: file.size,
            lastModified: file.lastModified,
          })
        }
      } catch {
        // One unreadable entry must not abandon the rest of the scan.
      }
    }
  } catch {
    // The directory itself went away or lost permission mid-walk.
  }
}

/** Recursively lists database-ish files in a linked folder. */
export async function scanFolder(handle: FileSystemDirectoryHandle): Promise<FolderEntry[]> {
  const found: FolderEntry[] = []
  await walk(handle, '', 0, found)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/** Reads one scanned entry back out by its folder-relative path. */
export async function readFolderEntry(
  handle: FileSystemDirectoryHandle,
  path: string
): Promise<{ name: string; buffer: ArrayBuffer }> {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) throw new Error('No file path to read')

  const filename = segments[segments.length - 1]
  try {
    let dir = handle
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i])
    }
    const fileHandle = await dir.getFileHandle(filename)
    const file = await fileHandle.getFile()
    return { name: file.name || filename, buffer: await file.arrayBuffer() }
  } catch {
    throw new Error(`Could not read "${path}" — the file may have been moved, renamed or deleted`)
  }
}
