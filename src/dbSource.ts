/**
 * Resolving a database out of whatever the user hands us: a raw .vyp/.db file,
 * a .vyb/.zip archive containing one, or a URL pointing at either.
 *
 * Detection is by magic bytes rather than extension, so a mislabelled file
 * (.vyb that is really a bare DB, .zip renamed to .vyp) still opens.
 */

import JSZip from 'jszip'

// The 16-byte header every SQLite file starts with, NUL terminator included.
const SQLITE_MAGIC = 'SQLite format 3\u0000'
const DB_EXTENSIONS = ['.vyp', '.db', '.sqlite', '.sqlite3', '.sqlitedb']
const ARCHIVE_EXTENSIONS = ['.vyb', '.zip']

export const ACCEPTED_EXTENSIONS = [...ARCHIVE_EXTENSIONS, ...DB_EXTENSIONS]

export type ResolvedDb = {
  /** The SQLite bytes themselves. */
  bytes: Uint8Array
  /** Name of the database — the inner entry name when it came from an archive. */
  dbName: string
  /** Name to use when downloading the whole thing back out. */
  downloadName: string
  /** Whether the original container was a zip archive. */
  fromArchive: boolean
  /** Byte size of the original container. */
  sourceBytes: number
}

export function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false
  }
  return true
}

export function isSqliteBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, SQLITE_MAGIC)
}

export function isZipBytes(bytes: Uint8Array): boolean {
  // "PK" followed by 03 04 (normal), 05 06 (empty) or 07 08 (spanned).
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
}

function scoreEntry(name: string): number {
  const lower = name.toLowerCase()
  if (lower.endsWith('.vyp')) return 3
  if (DB_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 2
  return 1
}

async function extractDbFromZip(
  buffer: ArrayBuffer
): Promise<{ bytes: Uint8Array; entryName: string }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new Error('File looks like a zip archive but could not be opened')
  }

  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && !f.name.startsWith('__MACOSX/') && !f.name.split('/').pop()?.startsWith('.')
  )
  if (entries.length === 0) throw new Error('Archive is empty')

  // Prefer .vyp, then other DB extensions, then anything with a SQLite header.
  const ranked = [...entries].sort((a, b) => scoreEntry(b.name) - scoreEntry(a.name))

  for (const entry of ranked) {
    const arrayBuffer = await entry.async('arraybuffer')
    const bytes = new Uint8Array(arrayBuffer)
    if (isSqliteBytes(bytes)) return { bytes, entryName: entry.name }
  }

  throw new Error(
    `No SQLite database found inside the archive (checked ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`
  )
}

/** Turns a downloaded/opened container into the DB bytes inside it. */
export async function resolveDb(buffer: ArrayBuffer, filename: string): Promise<ResolvedDb> {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16))
  const sourceBytes = buffer.byteLength

  if (isSqliteBytes(head)) {
    return {
      bytes: new Uint8Array(buffer),
      dbName: filename,
      downloadName: hasAcceptedExtension(filename) ? filename : `${filename || 'database'}.vyp`,
      fromArchive: false,
      sourceBytes,
    }
  }

  if (isZipBytes(head)) {
    const { bytes, entryName } = await extractDbFromZip(buffer)
    const lower = filename.toLowerCase()
    const base =
      lower.endsWith('.vyb') || lower.endsWith('.zip')
        ? filename.slice(0, filename.lastIndexOf('.'))
        : filename.replace(/\.[^/.]+$/, '')
    return {
      bytes,
      dbName: entryName,
      downloadName: `${base || 'database'}.vyb`,
      fromArchive: true,
      sourceBytes,
    }
  }

  throw new Error(
    'Not a SQLite database or zip archive — expected a .vyp/.db file or a .vyb/.zip containing one'
  )
}

export function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
    return parsed.hostname || 'database'
  } catch {
    const clean = url.split('?')[0].split('#')[0]
    return clean.split('/').filter(Boolean).pop() || 'database'
  }
}

/** Fetches a remote .vyp/.vyb/.zip. Cross-origin hosts must send CORS headers. */
export async function fetchDbFromUrl(
  url: string
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('Enter a URL')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported')
  }

  let response: Response
  try {
    response = await fetch(parsed.toString())
  } catch {
    throw new Error(
      'Could not fetch the URL. The host must allow cross-origin requests (CORS) for this app to read it.'
    )
  }
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength === 0) throw new Error('Downloaded file is empty')

  // Content-Disposition wins over the URL path when present.
  const disposition = response.headers.get('content-disposition') || ''
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  const filename = match ? decodeURIComponent(match[1]) : filenameFromUrl(parsed.toString())

  return { buffer, filename }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}
