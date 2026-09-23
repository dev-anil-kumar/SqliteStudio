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
/** Extensions we treat as a bare SQLite database. */
export const DB_EXTENSIONS = ['.vyp', '.db', '.sqlite', '.sqlite3', '.sqlitedb']
/** Extensions we treat as a container that may hold databases. */
export const ARCHIVE_EXTENSIONS = ['.vyb', '.zip']

// Guard rail: a pathological archive must not lock the tab up while we sniff it.
const ZIP_SCAN_LIMIT = 200

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

/** One SQLite database found inside whatever the user handed us. */
export type DbCandidate = {
  /** Display name of the database. */
  name: string
  /** Path inside the container ("" for a bare file — then it equals name). */
  path: string
  bytes: Uint8Array
  sizeBytes: number
}

export type ResolvedContainer = {
  kind: 'db' | 'archive'
  /** Every SQLite database found. Never empty — the function throws instead. */
  dbs: DbCandidate[]
  /** Name of the container the user handed over. */
  containerName: string
  sourceBytes: number
}

export function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** True when the name ends in a known SQLite-ish extension. */
export function looksLikeDbName(filename: string): boolean {
  const lower = filename.toLowerCase()
  return DB_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** True when the name ends in a known archive extension. */
export function looksLikeArchiveName(filename: string): boolean {
  const lower = filename.toLowerCase()
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))
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

/** Every SQLite entry inside a zip, in a stable order. */
export async function extractDbsFromZip(buffer: ArrayBuffer): Promise<DbCandidate[]> {
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
  // Ties fall back to the entry name so the listing is stable across runs.
  const ranked = [...entries].sort(
    (a, b) => scoreEntry(b.name) - scoreEntry(a.name) || a.name.localeCompare(b.name)
  )
  // Nested archives are deliberately not recursed into.
  const scanned = ranked.slice(0, ZIP_SCAN_LIMIT)

  const found: DbCandidate[] = []
  for (const entry of scanned) {
    const arrayBuffer = await entry.async('arraybuffer')
    const bytes = new Uint8Array(arrayBuffer)
    if (!isSqliteBytes(bytes)) continue
    found.push({
      name: entry.name.split('/').filter(Boolean).pop() || entry.name,
      path: entry.name,
      bytes,
      sizeBytes: bytes.byteLength,
    })
  }

  if (found.length === 0) {
    throw new Error(
      `No SQLite database found inside the archive (checked ${scanned.length} entr${scanned.length === 1 ? 'y' : 'ies'})`
    )
  }
  return found
}

async function extractDbFromZip(
  buffer: ArrayBuffer
): Promise<{ bytes: Uint8Array; entryName: string }> {
  const [first] = await extractDbsFromZip(buffer)
  return { bytes: first.bytes, entryName: first.path }
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

/**
 * Resolves whatever bytes we were handed into the databases they contain.
 * A bare SQLite file yields one; a zip yields every SQLite entry inside it.
 * An unrecognised extension is probed as a zip before giving up.
 */
export async function resolveDbs(buffer: ArrayBuffer, filename: string): Promise<ResolvedContainer> {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16))
  const sourceBytes = buffer.byteLength
  const name = filename || 'database'

  if (isSqliteBytes(head)) {
    return {
      kind: 'db',
      dbs: [
        { name: filename, path: filename, bytes: new Uint8Array(buffer), sizeBytes: sourceBytes },
      ],
      containerName: filename,
      sourceBytes,
    }
  }

  // Magic bytes first; failing that, anything without a known DB extension is
  // worth a speculative unzip — a .vyp that is really a zip still opens.
  const looksZippy = isZipBytes(head)
  if (looksZippy || !looksLikeDbName(filename)) {
    try {
      return {
        kind: 'archive',
        dbs: await extractDbsFromZip(buffer),
        containerName: filename,
        sourceBytes,
      }
    } catch (err) {
      if (looksZippy || looksLikeArchiveName(filename)) throw err
      throw new Error(
        `No SQLite database found in "${name}" — it is not a database and not a readable archive`
      )
    }
  }

  throw new Error(
    `"${name}" is not a SQLite database — expected a .vyp/.db file or a .vyb/.zip containing one`
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
