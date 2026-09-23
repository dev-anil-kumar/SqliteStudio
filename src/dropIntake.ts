/**
 * Flattening a drop: whatever lands in a DataTransfer (loose files, a folder,
 * several folders) or in an <input type="file" webkitdirectory> FileList comes
 * back as one list of files with their relative paths.
 *
 * Three strategies, best first: File System Access handles (which the caller
 * can persist), the older webkitGetAsEntry tree, then plain `dt.files`.
 */

declare global {
  interface DataTransferItem {
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
  }
}

// Matches folderAccess: deep trees and giant folders are not worth the wait.
const MAX_DEPTH = 6
const MAX_FILES = 500

export type IntakeFile = {
  /** Path relative to the dropped root ("" segments stripped), e.g. "backups/jan.vyp". */
  path: string
  name: string
  file: File
}

export type Intake = {
  files: IntakeFile[]
  /** Name of the single dropped folder, when exactly one folder was dropped. */
  folderName: string | null
  /** Directory handles obtained from the drop, when the browser supports it — the caller persists these. */
  directoryHandles: FileSystemDirectoryHandle[]
}

type DirectoryIterable = { values: () => AsyncIterable<FileSystemHandle> }

function skipName(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX'
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name
}

function dirValues(dir: FileSystemDirectoryHandle): AsyncIterable<FileSystemHandle> | null {
  const iterable = dir as unknown as Partial<DirectoryIterable>
  if (typeof iterable.values !== 'function') return null
  try {
    return iterable.values()
  } catch {
    return null
  }
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  files: IntakeFile[]
): Promise<void> {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
  const values = dirValues(dir)
  if (!values) return

  try {
    for await (const entry of values) {
      if (files.length >= MAX_FILES) break
      if (skipName(entry.name)) continue

      const path = join(prefix, entry.name)
      try {
        if (entry.kind === 'directory') {
          await walkHandle(entry as FileSystemDirectoryHandle, path, depth + 1, files)
        } else {
          const file = await (entry as FileSystemFileHandle).getFile()
          files.push({ path, name: entry.name, file })
        }
      } catch {
        // A single unreadable entry is skipped, not fatal.
      }
    }
  } catch {
    // Directory vanished or was denied mid-walk.
  }
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = []
    const next = () => {
      reader.readEntries(
        (batch) => {
          // readEntries hands back a page at a time; an empty page ends it.
          if (batch.length === 0) {
            resolve(all)
            return
          }
          all.push(...batch)
          next()
        },
        () => resolve(all)
      )
    }
    next()
  })
}

function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file(
        (file) => resolve(file),
        () => resolve(null)
      )
    } catch {
      resolve(null)
    }
  })
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  depth: number,
  files: IntakeFile[]
): Promise<void> {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
  if (skipName(entry.name)) return

  const path = join(prefix, entry.name)
  try {
    if (entry.isDirectory) {
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const child of children) {
        if (files.length >= MAX_FILES) break
        await walkEntry(child, path, depth + 1, files)
      }
      return
    }
    const file = await entryToFile(entry as FileSystemFileEntry)
    if (file) files.push({ path, name: entry.name, file })
  } catch {
    // Skip whatever went wrong and keep the rest of the drop.
  }
}

/** Flattens a drop, walking any folders it contains. */
export async function readDataTransfer(dt: DataTransfer): Promise<Intake> {
  // The DataTransfer is neutered as soon as the event handler returns, so every
  // item is snapshotted — and every handle requested — before the first await.
  const items: DataTransferItem[] = dt.items ? Array.from(dt.items) : []
  const dropped: File[] = dt.files ? Array.from(dt.files) : []
  const fileItems = items.filter((item) => item.kind === 'file')

  const handlePromises = fileItems
    .filter((item) => typeof item.getAsFileSystemHandle === 'function')
    .map((item) =>
      (item.getAsFileSystemHandle as () => Promise<FileSystemHandle | null>)
        .call(item)
        .catch(() => null)
    )

  const entries =
    handlePromises.length > 0
      ? []
      : fileItems
          .filter((item) => typeof item.webkitGetAsEntry === 'function')
          .map((item) => {
            try {
              return item.webkitGetAsEntry()
            } catch {
              return null
            }
          })
          .filter((entry): entry is FileSystemEntry => entry !== null)

  const files: IntakeFile[] = []
  const directoryHandles: FileSystemDirectoryHandle[] = []
  let topLevel = 0
  let topDirName: string | null = null

  if (handlePromises.length > 0) {
    const handles = (await Promise.all(handlePromises)).filter(
      (handle): handle is FileSystemHandle => handle !== null
    )
    for (const handle of handles) {
      if (skipName(handle.name)) continue
      topLevel++
      if (handle.kind === 'directory') {
        const dir = handle as FileSystemDirectoryHandle
        directoryHandles.push(dir)
        topDirName = dir.name
        await walkHandle(dir, dir.name, 0, files)
        continue
      }
      try {
        const file = await (handle as FileSystemFileHandle).getFile()
        files.push({ path: handle.name, name: handle.name, file })
      } catch {
        // Unreadable file handle: skip it.
      }
    }
  } else if (entries.length > 0) {
    for (const entry of entries) {
      if (skipName(entry.name)) continue
      topLevel++
      if (entry.isDirectory) topDirName = entry.name
      await walkEntry(entry, '', 0, files)
    }
  } else {
    for (const file of dropped) {
      if (skipName(file.name)) continue
      topLevel++
      files.push({ path: file.webkitRelativePath || file.name, name: file.name, file })
    }
  }

  return {
    files,
    folderName: topLevel === 1 && topDirName ? topDirName : null,
    directoryHandles,
  }
}

/** Flattens an <input type="file" webkitdirectory> selection. */
export function readFileList(list: FileList): Intake {
  const files: IntakeFile[] = []
  const roots = new Set<string>()
  let nested = 0

  for (const file of list ? Array.from(list) : []) {
    const path = file.webkitRelativePath || file.name
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0 || segments.some(skipName)) continue

    files.push({ path: segments.join('/'), name: file.name, file })
    if (segments.length > 1) {
      nested++
      roots.add(segments[0])
    }
  }

  // One shared first segment across every file means one picked folder.
  const folderName = files.length > 0 && nested === files.length && roots.size === 1
    ? [...roots][0]
    : null

  return { files, folderName, directoryHandles: [] }
}
