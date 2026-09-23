import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  clearRecents,
  getRecentGroups,
  loadRecentFile,
  makeGroupId,
  removeRecentGroup,
  saveRecentFiles,
  formatRecentDate,
  type NewRecentFile,
  type RecentFileMeta,
  type RecentGroup,
  type RecentGroupKind,
} from './recentDb'
import {
  clearFolders,
  ensurePermission,
  listFolders,
  pickFolder,
  readFolderEntry,
  rememberFolder,
  removeFolder,
  scanFolder,
  supportsFolderAccess,
  type LinkedFolder,
} from './folderAccess'
import { readDataTransfer, readFileList, type IntakeFile } from './dropIntake'
import {
  openDb,
  execQuery,
  getTableNames,
  getTableInfo,
  getDbInfo,
  exportDb,
  searchAllTables,
  searchJsonCriteria,
  type TableInfo,
  type DbInfo,
  type QueryExecResult,
  type SearchMatch,
} from './dbBridge'
import {
  FILTER_OPS,
  OP_META,
  buildCount,
  buildGlobalWhere,
  buildJsonCriteriaWhere,
  buildSelect,
  buildWhereClause,
  opTakesValue,
  type FilterCondition,
  type FilterOp,
  type FilterOptions,
  type GlobalSearchMode,
} from './filters'
import {
  fetchDbFromUrl,
  formatBytes,
  hasAcceptedExtension,
  resolveDbs,
  type DbCandidate,
} from './dbSource'
import GraphView from './GraphView'
import './App.css'

type SqlResult = QueryExecResult | null

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

type Theme = 'dark' | 'light' | 'neon'

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'neon', label: 'Neon' },
]

const DEFAULT_PANE_WIDTH = 620
const DEFAULT_PANE_HEIGHT = 600
const PANE_OFFSET = 28
const DEFAULT_ROW_LIMIT = 20
const DEFAULT_FILTER_LIMIT = 50
const DEFAULT_EDIT_DISTANCE = 2

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 560
const SIDEBAR_DEFAULT = 280
const SIDEBAR_KEY = 'vyb-sidebar-width'
const SIDEBAR_COLLAPSED_KEY = 'vyb-sidebar-collapsed'
const THEME_KEY = 'vyb-studio-theme'

/** Kept in step with .pane-card's min-width / min-height in App.css. */
const PANE_MIN_WIDTH = 320
const PANE_MIN_HEIGHT = 420

const ZOOM_MIN = 0.25
const ZOOM_MAX = 2.5
const GRID = 24
/** Mirrors the recents store's own cap, so we never copy bytes it will drop. */
const MAX_CACHED_BYTES = 400 * 1024 * 1024

/** Which secondary panel is expanded in a table pane; null keeps the pane compact. */
type PanePanel = 'filter' | 'sql' | 'schema' | null

type FilterRow = FilterCondition & { id: string }

type TableFilter = {
  rows: FilterRow[]
  join: 'AND' | 'OR'
  caseSensitive: boolean
  distance: number
  limit: number
  advanced: boolean
}

type PaneBox = {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

type TableTab = PaneBox & {
  id: string
  type: 'table'
  tableName: string
  tableData: SqlResult
  query: string
  queryResult: SqlResult
  /** Total rows matching the last applied filter, independent of the row limit. */
  matchCount: number | null
  filter: TableFilter
  panel: PanePanel
  error: string | null
}

type SavedQueriesTab = PaneBox & { id: string; type: 'saved-queries' }

type DbInfoTab = PaneBox & { id: string; type: 'db-info' }

/** The free-floating scratchpad: any SQL, against the whole database. */
type ConsoleTab = PaneBox & {
  id: string
  type: 'console'
  sql: string
  result: SqlResult
  error: string | null
  elapsedMs: number | null
  running: boolean
}

type Tab = TableTab | SavedQueriesTab | DbInfoTab | ConsoleTab

function isTableTab(tab: Tab): tab is TableTab {
  return tab.type === 'table'
}

type SourceInfo = {
  /** Name of the container the user opened (file, archive or URL basename). */
  filename: string
  /** Name of the SQLite file itself — the inner entry for archives. */
  dbName: string
  downloadName: string
  fromArchive: boolean
  sourceBytes: number
  url: string | null
}

type SavedQuery = { id: string; name: string; sql: string }
const SAVED_QUERIES_KEY = 'vyb-saved-queries'

/* ---------- drop / open intake ---------- */

/** Where the bytes for a pending open come from. */
type PendingSource =
  | { kind: 'bytes'; bytes: Uint8Array; fromArchive: boolean; containerName: string; sourceBytes: number }
  | { kind: 'folder'; folderId: string; path: string }
  | { kind: 'file'; file: File }

type PendingItem = {
  id: string
  name: string
  detail: string
  sizeBytes: number
  source: PendingSource
}

/** The confirm-and-pick sheet shown after a drop or a folder link. */
type PendingOpen = {
  title: string
  subtitle: string
  items: PendingItem[]
}

type ConfirmBox = {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(SAVED_QUERIES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as SavedQuery[]) : []
  } catch {
    return []
  }
}

function readStoredTheme(): Theme {
  try {
    const s = localStorage.getItem(THEME_KEY)
    if (s === 'light' || s === 'neon' || s === 'dark') return s
  } catch {
    /* ignore */
  }
  return 'dark'
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

async function loadFileAsBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer()
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function makeFilterRow(column: string, op: FilterOp = 'contains'): FilterRow {
  return { id: newId('cond'), column, op, value: '' }
}

function makeDefaultFilter(info: TableInfo | undefined): TableFilter {
  return {
    rows: [makeFilterRow(info?.columns[0] ?? '')],
    join: 'AND',
    caseSensitive: false,
    distance: DEFAULT_EDIT_DISTANCE,
    limit: DEFAULT_FILTER_LIMIT,
    advanced: false,
  }
}

const BASIC_OPS = FILTER_OPS.filter((o) => !o.advanced)
const ADVANCED_OPS = FILTER_OPS.filter((o) => o.advanced)

const SEARCH_MODES: { value: GlobalSearchMode; label: string; advanced: boolean }[] = [
  { value: 'contains', label: 'contains', advanced: false },
  { value: 'exact', label: 'exact', advanced: false },
  { value: 'regex', label: 'regex', advanced: true },
  { value: 'fuzzy', label: 'fuzzy', advanced: true },
]

/** What the last global search ran, so a result click can rebuild its WHERE. */
type AppliedSearch =
  | { kind: 'value'; value: string; mode: GlobalSearchMode; options: FilterOptions; column: string }
  | { kind: 'json'; criteria: Record<string, unknown> }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const groupIcon = (kind: RecentGroupKind) =>
  kind === 'folder' ? '🗂️' : kind === 'archive' ? '🗜️' : '📄'

function App() {
  const [source, setSource] = useState<SourceInfo | null>(null)
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [tableNames, setTableNamesState] = useState<string[]>([])
  const [tableInfos, setTableInfosState] = useState<TableInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [urlInput, setUrlInput] = useState('')

  const [searchValue, setSearchValue] = useState('')
  const [searchMode, setSearchMode] = useState<GlobalSearchMode>('contains')
  const [searchColumn, setSearchColumn] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchDistance, setSearchDistance] = useState(DEFAULT_EDIT_DISTANCE)
  const [searchAdvanced, setSearchAdvanced] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [appliedSearch, setAppliedSearch] = useState<AppliedSearch | null>(null)

  /* recents + linked folders */
  const [recentGroups, setRecentGroups] = useState<RecentGroup[]>([])
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [linkedFolders, setLinkedFolders] = useState<LinkedFolder[]>([])
  const [recentSearch, setRecentSearch] = useState('')
  const [busyNote, setBusyNote] = useState<string | null>(null)

  /* page-wide drag and drop, plus modals */
  const [dropActive, setDropActive] = useState(false)
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null)
  const [confirmBox, setConfirmBox] = useState<ConfirmBox | null>(null)

  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries())
  const [draggingTabBarId, setDraggingTabBarId] = useState<string | null>(null)
  const [openPaneMenuId, setOpenPaneMenuId] = useState<string | null>(null)
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)

  /* chrome */
  const [theme, setTheme] = useState<Theme>(readStoredTheme)
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(readStoredNumber(SIDEBAR_KEY, SIDEBAR_DEFAULT), SIDEBAR_MIN, SIDEBAR_MAX)
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)

  // The graph lives at its own address, so it survives a reload and the
  // browser's back button behaves the way people expect it to.
  const [hashRoute, setHashRoute] = useState(() => window.location.hash)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const canvasRef = useRef<HTMLDivElement>(null)
  const canvasInnerRef = useRef<HTMLDivElement>(null)
  const zoomLabelRef = useRef<HTMLButtonElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const deepLinkHandledRef = useRef(false)
  const dragDepthRef = useRef(0)

  /** Live canvas view. Written imperatively during gestures, mirrored to state on release. */
  const viewRef = useRef({ x: 0, y: 0, zoom: 1 })
  const frameRef = useRef(0)
  const panesRef = useRef<Tab[]>([])

  useEffect(() => {
    panesRef.current = tabs
  }, [tabs])

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [sidebarWidth, sidebarCollapsed])

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizingSidebar)
    return () => document.body.classList.remove('is-resizing')
  }, [resizingSidebar])

  const refreshRecents = useCallback(() => {
    getRecentGroups()
      .then(setRecentGroups)
      .catch(() => setRecentGroups([]))
  }, [])

  const refreshFolders = useCallback(() => {
    if (!supportsFolderAccess()) return
    listFolders()
      .then(setLinkedFolders)
      .catch(() => setLinkedFolders([]))
  }, [])

  useEffect(() => {
    refreshRecents()
    refreshFolders()
  }, [refreshRecents, refreshFolders, loadState])

  useEffect(() => {
    const sync = () => setHashRoute(window.location.hash)
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  useEffect(() => {
    const entries = Object.entries(paneRefs.current)
    const observers: ResizeObserver[] = []
    entries.forEach(([id, el]) => {
      if (!el) return
      const ro = new ResizeObserver((obs) => {
        const entry = obs[0]
        if (!entry) return
        // Must be the BORDER box: that is what the inline width/height we write
        // back mean under `box-sizing: border-box`. Reading the content box
        // instead feeds back 2px smaller every frame (the pane's border) and
        // walks every pane down to its minimum size. It is also immune to the
        // canvas' scale transform, which getBoundingClientRect is not.
        const box = entry.borderBoxSize?.[0]
        updatePaneSize(
          id,
          Math.round(box ? box.inlineSize : el.offsetWidth),
          Math.round(box ? box.blockSize : el.offsetHeight)
        )
      })
      ro.observe(el)
      observers.push(ro)
    })
    return () => observers.forEach((ro) => ro.disconnect())
  }, [tabs.length])

  useEffect(() => {
    if (loadState !== 'ready') return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [loadState])

  useEffect(() => {
    const tabIds = new Set(tabs.map((t) => t.id))
    setTabOrder((prev) => {
      const kept = prev.filter((id) => tabIds.has(id))
      const added = tabs.map((t) => t.id).filter((id) => !prev.includes(id))
      return added.length > 0 || kept.length !== prev.length ? [...kept, ...added] : prev
    })
  }, [tabs])

  useEffect(() => {
    if (!openPaneMenuId) return
    const close = () => setOpenPaneMenuId(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openPaneMenuId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pendingOpen) setPendingOpen(null)
      else if (confirmBox) setConfirmBox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingOpen, confirmBox])

  const { filteredTableInfos, tablesByColumnMatch } = useMemo(() => {
    if (!tableSearch.trim()) {
      return { filteredTableInfos: tableInfos, tablesByColumnMatch: [] as TableInfo[] }
    }
    const q = tableSearch.trim().toLowerCase()
    const byColumn = tableInfos.filter((info) =>
      info.columns.some((col) => col.toLowerCase().includes(q))
    )
    const byName = tableInfos.filter((info) => info.name.toLowerCase().includes(q))
    const combined = [...new Map([...byColumn, ...byName].map((info) => [info.name, info])).values()]
    return { filteredTableInfos: combined, tablesByColumnMatch: byColumn }
  }, [tableInfos, tableSearch])

  /** Recents split into loose files and real folder/archive groups, search applied. */
  const { looseFiles, groupedRecents } = useMemo(() => {
    const q = recentSearch.trim().toLowerCase()
    const match = (g: RecentGroup) =>
      !q ||
      g.label.toLowerCase().includes(q) ||
      g.files.some((f) => f.path.toLowerCase().includes(q))
    const filtered = recentGroups
      .filter(match)
      .map((g) =>
        q
          ? {
              ...g,
              files: g.label.toLowerCase().includes(q)
                ? g.files
                : g.files.filter((f) => f.path.toLowerCase().includes(q)),
            }
          : g
      )
      .filter((g) => g.files.length > 0)
    return {
      looseFiles: filtered
        .filter((g) => g.kind === 'file')
        .flatMap((g) => g.files)
        .sort((a, b) => b.openedAt - a.openedAt),
      groupedRecents: filtered.filter((g) => g.kind !== 'file'),
    }
  }, [recentGroups, recentSearch])

  const hasRecents = looseFiles.length > 0 || groupedRecents.length > 0
  const graphOpen = hashRoute.startsWith('#/graph')

  const totalRows = useMemo(
    () => tableInfos.reduce((sum, info) => sum + info.rowCount, 0),
    [tableInfos]
  )

  function resetSearchState() {
    setSearchResults(null)
    setSearchError(null)
    setAppliedSearch(null)
  }

  /* ---------- canvas view ---------- */

  const applyView = useCallback(() => {
    const inner = canvasInnerRef.current
    const canvas = canvasRef.current
    const v = viewRef.current
    if (inner) inner.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
    if (canvas) {
      const step = GRID * v.zoom
      canvas.style.backgroundSize = `${step}px ${step}px`
      canvas.style.backgroundPosition = `${v.x}px ${v.y}px`
    }
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(v.zoom * 100)}%`
    }
  }, [])

  const scheduleView = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      applyView()
    })
  }, [applyView])

  // React never wrote these styles, so it never clears them — but a fresh mount
  // (opening a database, leaving the graph) needs them put back.
  useEffect(() => {
    if (loadState === 'ready' && !graphOpen) applyView()
  }, [loadState, graphOpen, tabs.length, applyView])

  /** Canvas client point → scene coordinates. */
  const toScene = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const v = viewRef.current
    if (!canvas) return { x: 0, y: 0 }
    const r = canvas.getBoundingClientRect()
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }, [])

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      const px = clientX ?? r.left + r.width / 2
      const py = clientY ?? r.top + r.height / 2
      const v = viewRef.current
      const next = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX)
      if (next === v.zoom) return
      // Keep the point under the cursor pinned while the scale changes.
      const sx = (px - r.left - v.x) / v.zoom
      const sy = (py - r.top - v.y) / v.zoom
      v.x = px - r.left - sx * next
      v.y = py - r.top - sy * next
      v.zoom = next
      scheduleView()
    },
    [scheduleView]
  )

  const resetView = useCallback(() => {
    viewRef.current = { x: 0, y: 0, zoom: 1 }
    applyView()
  }, [applyView])

  /** Frames every open pane into the viewport. */
  const fitView = useCallback(() => {
    const canvas = canvasRef.current
    const list = panesRef.current
    if (!canvas || list.length === 0) return resetView()
    const r = canvas.getBoundingClientRect()
    const left = Math.min(...list.map((t) => t.x))
    const top = Math.min(...list.map((t) => t.y))
    const right = Math.max(...list.map((t) => t.x + t.width))
    const bottom = Math.max(...list.map((t) => t.y + t.height))
    const pad = 48
    const zoom = clamp(
      Math.min((r.width - pad * 2) / (right - left), (r.height - pad * 2) / (bottom - top)),
      ZOOM_MIN,
      1
    )
    viewRef.current = {
      zoom,
      x: (r.width - (right - left) * zoom) / 2 - left * zoom,
      y: (r.height - (bottom - top) * zoom) / 2 - top * zoom,
    }
    applyView()
  }, [applyView, resetView])

  /** Pans so a pane sits comfortably inside the viewport. */
  const bringIntoView = useCallback(
    (tabId: string) => {
      const canvas = canvasRef.current
      const tab = panesRef.current.find((t) => t.id === tabId)
      if (!canvas || !tab) return
      const r = canvas.getBoundingClientRect()
      const v = viewRef.current
      const pad = 24
      const sx = tab.x * v.zoom + v.x
      const sy = tab.y * v.zoom + v.y
      const sw = tab.width * v.zoom
      const sh = tab.height * v.zoom
      if (sx < pad) v.x += pad - sx
      else if (sx + sw > r.width - pad) v.x -= Math.min(sx - pad, sx + sw - (r.width - pad))
      if (sy < pad) v.y += pad - sy
      else if (sy + sh > r.height - pad) v.y -= Math.min(sy - pad, sy + sh - (r.height - pad))
      applyView()
    },
    [applyView]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // A trackpad pinch arrives as ctrl+wheel; everything else pans.
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY)
        return
      }
      const v = viewRef.current
      if (e.shiftKey && e.deltaX === 0) v.x -= e.deltaY
      else {
        v.x -= e.deltaX
        v.y -= e.deltaY
      }
      scheduleView()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt, scheduleView, loadState, graphOpen])

  /** Drag the empty canvas (or middle-drag anywhere) to pan. */
  function handleCanvasPointerDown(e: React.PointerEvent) {
    const isBackground = e.target === canvasRef.current || e.target === canvasInnerRef.current
    if (e.button !== 1 && !(e.button === 0 && isBackground)) return
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.classList.add('panning')
    const start = { x: e.clientX, y: e.clientY }
    const origin = { ...viewRef.current }
    setFocusedPaneId(null)

    const onMove = (ev: PointerEvent) => {
      viewRef.current.x = origin.x + (ev.clientX - start.x)
      viewRef.current.y = origin.y + (ev.clientY - start.y)
      scheduleView()
    }
    const onUp = () => {
      canvas.classList.remove('panning')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /* ---------- opening databases ---------- */

  const openCandidate = useCallback(
    async function openCandidate(opts: {
      bytes: Uint8Array
      dbName: string
      containerName: string
      downloadName: string
      fromArchive: boolean
      sourceBytes: number
      url?: string | null
    }) {
      setLoadState('loading')
      setError(null)
      setTabs([])
      setTableNamesState([])
      setTableInfosState([])
      setDbInfo(null)
      resetSearchState()
      resetView()

      try {
        await openDb(opts.bytes)
        const names = await getTableNames()
        const infos = await Promise.all(names.map((name) => getTableInfo(name)))
        const info = await getDbInfo().catch(() => null)

        setTableNamesState(names)
        setTableInfosState(infos)
        setDbInfo(info)
        setSource({
          filename: opts.containerName,
          dbName: opts.dbName,
          downloadName: opts.downloadName,
          fromArchive: opts.fromArchive,
          sourceBytes: opts.sourceBytes,
          url: opts.url ?? null,
        })
        setLoadState('ready')
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Failed to open database')
        setLoadState('error')
      }
    },
    [resetView]
  )

  /** Persists a batch of discovered databases so they show up under Recent. */
  const remember = useCallback(
    (files: NewRecentFile[]) => {
      if (files.length === 0) return
      saveRecentFiles(files)
        .then(refreshRecents)
        .catch((err) => console.error('Could not save recents', err))
    },
    [refreshRecents]
  )

  const candidateToRecent = useCallback(
    (
      c: DbCandidate,
      group: { id: string; label: string; kind: RecentGroupKind },
      keepBytes: boolean
    ): NewRecentFile => ({
      groupId: group.id,
      groupLabel: group.label,
      groupKind: group.kind,
      filename: c.name,
      path: c.path || c.name,
      sizeBytes: c.sizeBytes,
      // openDb transfers the buffer it is given, so recents always get a copy —
      // but only when the store would actually hold on to it.
      data: keepBytes && c.sizeBytes <= MAX_CACHED_BYTES ? c.bytes.slice().buffer : null,
      handleId: null,
    }),
    []
  )

  /**
   * Opens one raw container. A single database inside opens straight away;
   * several (an archive holding many) put up the picker.
   */
  const openBuffer = useCallback(
    async function openBuffer(
      buffer: ArrayBuffer,
      filename: string,
      opts: { url?: string | null; groupLabel?: string; groupKind?: RecentGroupKind } = {}
    ) {
      setError(null)
      setBusyNote('Looking inside…')
      try {
        const resolved = await resolveDbs(buffer, filename)
        const fromArchive = resolved.kind === 'archive'
        const group = {
          kind: opts.groupKind ?? (fromArchive ? ('archive' as const) : ('file' as const)),
          label: opts.groupLabel ?? (fromArchive ? filename : 'Files'),
        }
        const groupId = makeGroupId(group.kind, group.label)
        const base = hasAcceptedExtension(filename)
          ? filename.slice(0, filename.lastIndexOf('.'))
          : filename
        const downloadName = fromArchive
          ? `${base || 'database'}.vyb`
          : hasAcceptedExtension(filename)
            ? filename
            : `${filename || 'database'}.vyp`

        remember(
          resolved.dbs.map((c) =>
            candidateToRecent(c, { id: groupId, label: group.label, kind: group.kind }, true)
          )
        )

        if (resolved.dbs.length === 1) {
          const only = resolved.dbs[0]
          await openCandidate({
            bytes: only.bytes,
            dbName: only.path || only.name,
            containerName: filename,
            downloadName,
            fromArchive,
            sourceBytes: resolved.sourceBytes,
            url: opts.url ?? null,
          })
          return
        }

        // Callers that flipped us to 'loading' (a recent, a URL) must land back
        // on a usable screen behind the picker rather than a stuck spinner.
        setLoadState((prev) => (prev === 'loading' ? 'idle' : prev))
        setPendingOpen({
          title: `${resolved.dbs.length} databases in ${filename}`,
          subtitle: 'Pick the one to open — the rest stay listed under Recent.',
          items: resolved.dbs.map((c) => ({
            id: `${groupId}::${c.path}`,
            name: c.name,
            detail: c.path !== c.name ? c.path : filename,
            sizeBytes: c.sizeBytes,
            source: {
              kind: 'bytes',
              bytes: c.bytes,
              fromArchive: true,
              containerName: filename,
              sourceBytes: resolved.sourceBytes,
            },
          })),
        })
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Failed to open database')
        // A bad file must not close the database the user already has open.
        setLoadState((prev) => (prev === 'ready' ? prev : 'error'))
      } finally {
        setBusyNote(null)
      }
    },
    [candidateToRecent, openCandidate, remember]
  )

  const openFromUrl = useCallback(
    async function openFromUrl(rawUrl: string) {
      const url = rawUrl.trim()
      if (!url) return
      setLoadState('loading')
      setError(null)
      try {
        const { buffer, filename } = await fetchDbFromUrl(url)
        await openBuffer(buffer, filename, { url })
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Failed to open URL')
        setLoadState('error')
      }
    },
    [openBuffer]
  )

  // ?url=… (or ?db=…) opens a remote database straight away.
  useEffect(() => {
    if (deepLinkHandledRef.current) return
    deepLinkHandledRef.current = true
    const params = new URLSearchParams(window.location.search)
    const deepLink = params.get('url') ?? params.get('db')
    if (deepLink) {
      setUrlInput(deepLink)
      openFromUrl(deepLink)
    }
  }, [openFromUrl])

  /* ---------- folders ---------- */

  /** Scans a linked folder, lists what it holds and files it all under Recent. */
  const ingestFolder = useCallback(
    async function ingestFolder(folder: LinkedFolder, announce: boolean) {
      setBusyNote(`Scanning ${folder.label}…`)
      try {
        const ok = await ensurePermission(folder.handle, true)
        if (!ok) throw new Error(`Permission to read "${folder.label}" was denied`)
        const entries = await scanFolder(folder.handle)
        const groupId = makeGroupId('folder', folder.label)
        remember(
          entries.map((e) => ({
            groupId,
            groupLabel: folder.label,
            groupKind: 'folder' as const,
            filename: e.name,
            path: e.path,
            sizeBytes: e.sizeBytes,
            data: null,
            handleId: folder.id,
          }))
        )
        setOpenGroups((prev) => new Set(prev).add(groupId))
        if (entries.length === 0) {
          setError(`No database files found in "${folder.label}"`)
          return
        }
        if (announce) {
          setPendingOpen({
            title: `${entries.length} file${entries.length === 1 ? '' : 's'} in ${folder.label}`,
            subtitle:
              'This folder stays linked — add files to it and they will show up here next time.',
            items: entries.map((e) => ({
              id: `${folder.id}::${e.path}`,
              name: e.name,
              detail: e.path,
              sizeBytes: e.sizeBytes,
              source: { kind: 'folder', folderId: folder.id, path: e.path },
            })),
          })
        }
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Could not read that folder')
      } finally {
        setBusyNote(null)
        refreshFolders()
      }
    },
    [refreshFolders, remember]
  )

  async function linkNewFolder() {
    try {
      const folder = await pickFolder()
      if (!folder) return
      await ingestFolder(folder, true)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Could not open that folder')
    }
  }

  async function openFolderEntry(folderId: string, path: string, displayName: string) {
    const folder = (await listFolders()).find((f) => f.id === folderId)
    if (!folder) {
      setError('That folder is no longer linked. Link it again to reopen its files.')
      return
    }
    const ok = await ensurePermission(folder.handle, true)
    if (!ok) {
      setError(`Permission to read "${folder.label}" was denied`)
      return
    }
    try {
      const { name, buffer } = await readFolderEntry(folder.handle, path)
      await openBuffer(buffer, name || displayName, {
        groupKind: 'folder',
        groupLabel: folder.label,
      })
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Could not read that file')
      setLoadState('error')
    }
  }

  /* ---------- drag & drop, anywhere on the page ---------- */

  /** Turns dropped files into a pick list, folders included. */
  const ingestFiles = useCallback(
    async function ingestFiles(files: IntakeFile[], folderName: string | null) {
      if (files.length === 0) {
        setError('Nothing openable was dropped')
        return
      }
      const groupKind: RecentGroupKind = folderName ? 'folder' : 'file'
      const groupLabel = folderName ?? 'Files'
      const groupId = makeGroupId(groupKind, groupLabel)
      // Dropped paths lead with the folder name, which is already the group
      // label — strip it so they read the same as a linked folder's scan.
      const rel = (p: string) =>
        folderName && p.startsWith(`${folderName}/`) ? p.slice(folderName.length + 1) : p

      // Folder drops can be large, so bytes are read only when one is chosen.
      remember(
        files.map((f) => ({
          groupId,
          groupLabel,
          groupKind,
          filename: f.name,
          path: rel(f.path || f.name),
          sizeBytes: f.file.size,
          data: null,
          handleId: null,
        }))
      )

      if (files.length === 1) {
        const only = files[0]
        setPendingOpen({
          title: `Open ${only.name}?`,
          subtitle: folderName
            ? `From the folder "${folderName}".`
            : 'This replaces whatever is open right now.',
          items: [
            {
              id: rel(only.path || only.name),
              name: only.name,
              detail: rel(only.path || only.name),
              sizeBytes: only.file.size,
              source: { kind: 'file', file: only.file },
            },
          ],
        })
        return
      }

      setPendingOpen({
        title: folderName
          ? `${files.length} files in ${folderName}`
          : `${files.length} files dropped`,
        subtitle: 'Pick one to open — they are all listed under Recent.',
        items: files.map((f) => ({
          id: rel(f.path || f.name),
          name: f.name,
          detail: rel(f.path || f.name),
          sizeBytes: f.file.size,
          source: { kind: 'file', file: f.file },
        })),
      })
    },
    [remember]
  )

  const handleGlobalDrop = useCallback(
    async function handleGlobalDrop(dt: DataTransfer) {
      setBusyNote('Reading what you dropped…')
      try {
        const intake = await readDataTransfer(dt)
        // A real directory handle is worth keeping: the folder stays readable
        // later, so files added to it afterwards show up without a re-drop.
        if (intake.directoryHandles.length > 0 && supportsFolderAccess()) {
          const folders: LinkedFolder[] = []
          for (const handle of intake.directoryHandles) {
            try {
              folders.push(await rememberFolder(handle))
            } catch (err) {
              console.error('Could not remember folder', err)
            }
          }
          if (folders.length > 0) {
            setBusyNote(null)
            await ingestFolder(folders[0], true)
            for (const extra of folders.slice(1)) await ingestFolder(extra, false)
            return
          }
        }
        await ingestFiles(intake.files, intake.folderName)
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Could not read the dropped items')
      } finally {
        setBusyNote(null)
      }
    },
    [ingestFiles, ingestFolder]
  )

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current += 1
      setDropActive(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDropActive(false)
    }
    const onDrop = (e: DragEvent) => {
      // Tab-bar reordering is a drag too, and it carries no files.
      if (!e.dataTransfer || !hasFiles(e)) return
      e.preventDefault()
      dragDepthRef.current = 0
      setDropActive(false)
      handleGlobalDrop(e.dataTransfer)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleGlobalDrop])

  async function runPendingItem(item: PendingItem) {
    setPendingOpen(null)
    const src = item.source
    if (src.kind === 'bytes') {
      await openCandidate({
        bytes: src.bytes,
        dbName: item.detail,
        containerName: src.containerName,
        downloadName: src.containerName,
        fromArchive: src.fromArchive,
        sourceBytes: src.sourceBytes,
      })
      return
    }
    if (src.kind === 'folder') {
      await openFolderEntry(src.folderId, src.path, item.name)
      return
    }
    try {
      const buffer = await loadFileAsBuffer(src.file)
      await openBuffer(buffer, item.name)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Failed to read file')
      setLoadState('error')
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files
    if (!list || list.length === 0) return
    const intake = readFileList(list)
    e.target.value = ''
    if (intake.files.length === 1 && !intake.folderName) {
      const only = intake.files[0]
      loadFileAsBuffer(only.file)
        .then((buffer) => openBuffer(buffer, only.name))
        .catch((err) => {
          console.error(err)
          setError(err instanceof Error ? err.message : 'Failed to read file')
          setLoadState('error')
        })
      return
    }
    ingestFiles(intake.files, intake.folderName)
  }

  /* ---------- recents ---------- */

  async function openRecentFile(meta: RecentFileMeta) {
    setError(null)
    if (!meta.hasData && meta.handleId) {
      await openFolderEntry(meta.handleId, meta.path, meta.filename)
      return
    }
    setLoadState('loading')
    try {
      const { filename, data } = await loadRecentFile(meta.id)
      await openBuffer(data, filename, {
        groupKind: meta.groupKind,
        groupLabel: meta.groupLabel,
      })
    } catch (err) {
      console.error(err)
      setLoadState('error')
      setError(err instanceof Error ? err.message : 'Failed to open recent database')
    }
  }

  function askClearRecents() {
    setConfirmBox({
      title: 'Clear recent files?',
      body: 'Every database cached in this browser is deleted, and linked folders are forgotten. The original files on your machine are untouched.',
      confirmLabel: 'Clear everything',
      danger: true,
      onConfirm: () => {
        Promise.all([clearRecents(), clearFolders().catch(() => {})])
          .then(() => {
            setRecentGroups([])
            setLinkedFolders([])
            setOpenGroups(new Set())
          })
          .catch((err) => setError(err instanceof Error ? err.message : 'Could not clear recents'))
      },
    })
  }

  function forgetGroup(group: RecentGroup) {
    removeRecentGroup(group.id)
      .then(() => {
        if (group.handleId) return removeFolder(group.handleId).catch(() => {})
      })
      .then(() => {
        refreshRecents()
        refreshFolders()
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not remove that group'))
  }

  function toggleGroup(id: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* ---------- panes ---------- */

  function persistSavedQueries(next: SavedQuery[]) {
    setSavedQueries(next)
    try {
      localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  function infoFor(tableName: string): TableInfo | undefined {
    return tableInfos.find((i) => i.name === tableName)
  }

  function defaultQueryFor(tableName: string): string {
    const info = infoFor(tableName)
    return buildSelect(tableName, null, DEFAULT_ROW_LIMIT, info?.hasRowid ?? true)
  }

  /** Rebuilds the WHERE the last global search used, for one specific table. */
  function whereForAppliedSearch(tableName: string): string | null {
    if (!appliedSearch) return null
    const info = infoFor(tableName)
    if (!info) return null
    if (appliedSearch.kind === 'json') {
      return buildJsonCriteriaWhere(info.columns, appliedSearch.criteria)
    }
    const needle = appliedSearch.column.trim().toLowerCase()
    const columns = needle
      ? info.columns.filter((c) => c.toLowerCase().includes(needle))
      : info.columns
    return buildGlobalWhere(columns, appliedSearch.value, appliedSearch.mode, appliedSearch.options)
  }

  /** Top-left of the visible canvas in scene coordinates, so new panes land on screen. */
  function nextPanePosition(size = { width: DEFAULT_PANE_WIDTH, height: DEFAULT_PANE_HEIGHT }) {
    const v = viewRef.current
    const originX = (-v.x + 24) / v.zoom
    const originY = (-v.y + 24) / v.zoom
    const step = (tabs.length % 8) * PANE_OFFSET
    return { x: Math.round(originX + step), y: Math.round(originY + step), ...size }
  }

  function nextZ(): number {
    return tabs.length === 0 ? 1 : Math.max(...tabs.map((t) => t.zIndex)) + 1
  }

  async function handleTableSelect(tableName: string, options?: { initialQuery?: string }) {
    if (loadState !== 'ready') return

    const existingTab = tabs.find((t): t is TableTab => isTableTab(t) && t.tableName === tableName)
    if (existingTab && !options?.initialQuery) {
      focusPane(existingTab.id)
      return
    }

    const info = infoFor(tableName)
    const query = options?.initialQuery ?? defaultQueryFor(tableName)

    const newTabId = newId('tab')
    let tableData: SqlResult = null
    let queryError: string | null = null
    try {
      tableData = await execQuery(query)
    } catch (err) {
      console.error(err)
      queryError = err instanceof Error ? err.message : 'Failed to run query'
    }

    const newTab: TableTab = {
      id: newTabId,
      type: 'table',
      tableName,
      tableData,
      query,
      queryResult: null,
      matchCount: null,
      filter: makeDefaultFilter(info),
      // SQL is where people spend their time, so it opens first.
      panel: 'sql',
      error: queryError,
      ...nextPanePosition(),
      zIndex: nextZ(),
    }

    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTabId])
    setFocusedPaneId(newTabId)
  }

  function openTableFromSearch(tableName: string) {
    const where = whereForAppliedSearch(tableName)
    const info = infoFor(tableName)
    const query = where
      ? buildSelect(tableName, where, DEFAULT_FILTER_LIMIT, info?.hasRowid ?? true)
      : defaultQueryFor(tableName)
    handleTableSelect(tableName, { initialQuery: query })
  }

  async function runGlobalSearch() {
    const raw = searchValue.trim()
    if (!raw) {
      resetSearchState()
      return
    }
    setSearchError(null)
    setSearchLoading(true)
    setSearchResults(null)
    setAppliedSearch(null)
    try {
      // A JSON object means "match these columns exactly".
      if (raw.startsWith('{')) {
        let parsed: Record<string, unknown> | null = null
        try {
          const candidate = JSON.parse(raw) as unknown
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            parsed = candidate as Record<string, unknown>
          }
        } catch {
          /* not JSON — fall through to a plain value search */
        }
        if (parsed) {
          const matches = await searchJsonCriteria(parsed)
          setSearchResults(matches)
          setAppliedSearch({ kind: 'json', criteria: parsed })
          return
        }
      }

      const options: FilterOptions = {
        caseSensitive: searchCaseSensitive,
        distance: searchDistance,
      }
      const matches = await searchAllTables(raw, searchMode, options, searchColumn)
      setSearchResults(matches)
      setAppliedSearch({
        kind: 'value',
        value: raw,
        mode: searchMode,
        options,
        column: searchColumn,
      })
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed')
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }

  function focusPane(tabId: string) {
    const maxZ = Math.max(...tabs.map((t) => t.zIndex))
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, zIndex: maxZ + 1 } : tab)))
    setFocusedPaneId(tabId)
    requestAnimationFrame(() => bringIntoView(tabId))
  }

  function openSavedQueriesPane() {
    const existing = tabs.find((t) => t.type === 'saved-queries')
    if (existing) return focusPane(existing.id)
    const newTab: SavedQueriesTab = {
      id: newId('saved-queries'),
      type: 'saved-queries',
      ...nextPanePosition({ width: 400, height: 440 }),
      zIndex: nextZ(),
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTab.id])
  }

  function openDbInfoPane() {
    const existing = tabs.find((t) => t.type === 'db-info')
    if (existing) return focusPane(existing.id)
    const newTab: DbInfoTab = {
      id: newId('db-info'),
      type: 'db-info',
      ...nextPanePosition({ width: 480, height: 540 }),
      zIndex: nextZ(),
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTab.id])
  }

  function openConsolePane() {
    const existing = tabs.find((t) => t.type === 'console')
    if (existing) return focusPane(existing.id)
    const newTab: ConsoleTab = {
      id: newId('console'),
      type: 'console',
      sql: tableNames[0] ? `SELECT * FROM "${tableNames[0]}" LIMIT 50;` : 'SELECT 1;',
      result: null,
      error: null,
      elapsedMs: null,
      running: false,
      ...nextPanePosition({ width: 720, height: 520 }),
      zIndex: nextZ(),
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTab.id])
    setFocusedPaneId(newTab.id)
  }

  function updateConsole(tabId: string, patch: Partial<ConsoleTab>) {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId && t.type === 'console' ? { ...t, ...patch } : t))
    )
  }

  async function runConsole(tabId: string) {
    const tab = tabs.find((t): t is ConsoleTab => t.id === tabId && t.type === 'console')
    if (!tab || loadState !== 'ready' || !tab.sql.trim()) return
    updateConsole(tabId, { running: true, error: null })
    const started = performance.now()
    try {
      const res = await execQuery(tab.sql)
      updateConsole(tabId, {
        result: res ?? null,
        error: null,
        elapsedMs: Math.round(performance.now() - started),
        running: false,
      })
    } catch (err) {
      console.error(err)
      updateConsole(tabId, {
        error: err instanceof Error ? err.message : 'Query failed',
        result: null,
        elapsedMs: Math.round(performance.now() - started),
        running: false,
      })
    }
  }

  function handleSaveQuery(sql: string) {
    const name = window.prompt('Name for this query')
    if (!name?.trim()) return
    persistSavedQueries([...savedQueries, { id: newId('sq'), name: name.trim(), sql }])
  }

  function handleUseSavedQuery(tabId: string, sql: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (tab.type === 'console') {
      updateConsole(tabId, { sql })
    } else if (isTableTab(tab)) {
      handleQueryChange(tabId, sql)
      setPanePanel(tabId, 'sql')
    }
    focusPane(tabId)
  }

  function handleDeleteSavedQuery(id: string) {
    persistSavedQueries(savedQueries.filter((q) => q.id !== id))
  }

  function copyToClipboard(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {})
    setOpenPaneMenuId(null)
  }

  function getTabResultData(tab: TableTab): SqlResult {
    return tab.queryResult ?? tab.tableData
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function resultToRows(data: QueryExecResult): Record<string, unknown>[] {
    return data.values.map((row) => {
      const obj: Record<string, unknown> = {}
      data.columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    })
  }

  function buildCsvFromResult(data: QueryExecResult): string {
    const escape = (v: unknown) => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s
    }
    const header = data.columns.map(escape).join(',')
    const lines = data.values.map((row) => row.map(escape).join(','))
    return [header, ...lines].join('\n')
  }

  function exportResult(data: SqlResult, basename: string, format: 'json' | 'csv') {
    if (!data || data.values.length === 0) return
    if (format === 'json') {
      const json = JSON.stringify(resultToRows(data), null, 2)
      downloadBlob(new Blob([json], { type: 'application/json' }), `${basename}-results.json`)
    } else {
      downloadBlob(
        new Blob([buildCsvFromResult(data)], { type: 'text/csv' }),
        `${basename}-results.csv`
      )
    }
    setTimeout(() => setOpenPaneMenuId(null), 0)
  }

  async function copyResultAsJson(data: SqlResult) {
    if (!data || data.values.length === 0) return
    const json = JSON.stringify(resultToRows(data), null, 2)
    try {
      await navigator.clipboard.writeText(json)
    } catch (err) {
      console.error('Failed to copy results', err)
    } finally {
      setTimeout(() => setOpenPaneMenuId(null), 0)
    }
  }

  function handleCloseTab(tabId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
    setTabOrder((prev) => prev.filter((id) => id !== tabId))
    delete paneRefs.current[tabId]
  }

  function reorderTabBar(dragId: string, dropIndex: number) {
    setTabOrder((prev) => {
      const idx = prev.indexOf(dragId)
      if (idx === -1 || idx === dropIndex) return prev
      const next = prev.filter((id) => id !== dragId)
      next.splice(dropIndex, 0, dragId)
      return next
    })
  }

  /** Drags a pane by its header, in scene coordinates so zoom feels natural. */
  function handlePanePointerDown(e: React.PointerEvent, tabId: string) {
    if (e.button !== 0) return
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !canvasRef.current) return
    e.preventDefault()

    const start = toScene(e.clientX, e.clientY)
    const grab = { dx: start.x - tab.x, dy: start.y - tab.y }
    const el = paneRefs.current[tabId]
    const live = { x: tab.x, y: tab.y }
    let frame = 0

    setDraggingTabId(tabId)
    focusPane(tabId)

    const onMove = (ev: PointerEvent) => {
      const p = toScene(ev.clientX, ev.clientY)
      live.x = Math.round(p.x - grab.dx)
      live.y = Math.round(p.y - grab.dy)
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (el) {
          el.style.left = `${live.x}px`
          el.style.top = `${live.y}px`
        }
      })
    }

    const onUp = () => {
      if (frame) cancelAnimationFrame(frame)
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, x: live.x, y: live.y } : t)))
      setDraggingTabId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function updatePaneSize(tabId: string, width: number, height: number) {
    // Floors match .pane-card's CSS min-width/min-height, so state and layout
    // never disagree about how small a pane is allowed to get.
    const w = Math.max(PANE_MIN_WIDTH, Math.round(width))
    const h = Math.max(PANE_MIN_HEIGHT, Math.round(height))
    setTabs((prev) => {
      // Sub-pixel rounding must never round-trip into a resize loop.
      const changed = prev.some(
        (t) => t.id === tabId && (Math.abs(t.width - w) > 1 || Math.abs(t.height - h) > 1)
      )
      return changed ? prev.map((tab) => (tab.id === tabId ? { ...tab, width: w, height: h } : tab)) : prev
    })
  }

  /* ---------- sidebar resize ---------- */

  function handleSidebarResize(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    setResizingSidebar(true)
    const host = workspaceRef.current
    const left = host ? host.getBoundingClientRect().left : 0

    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(clamp(Math.round(ev.clientX - left), SIDEBAR_MIN, SIDEBAR_MAX))
    }
    const onUp = () => {
      setResizingSidebar(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /* ---------- table pane: panels + filter builder ---------- */

  function updateTableTab(tabId: string, patch: (tab: TableTab) => Partial<TableTab>) {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId && isTableTab(t) ? { ...t, ...patch(t) } : t))
    )
  }

  function setPanePanel(tabId: string, panel: PanePanel) {
    updateTableTab(tabId, (tab) => ({ panel: tab.panel === panel ? null : panel }))
  }

  function updateFilter(tabId: string, patch: (filter: TableFilter) => Partial<TableFilter>) {
    updateTableTab(tabId, (tab) => ({ filter: { ...tab.filter, ...patch(tab.filter) } }))
  }

  function updateFilterRow(tabId: string, rowId: string, patch: Partial<FilterRow>) {
    updateFilter(tabId, (filter) => ({
      rows: filter.rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
    }))
  }

  function addFilterRow(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const info = infoFor(tab.tableName)
    updateFilter(tabId, (filter) => ({
      rows: [...filter.rows, makeFilterRow(info?.columns[0] ?? '')],
    }))
  }

  function removeFilterRow(tabId: string, rowId: string) {
    updateFilter(tabId, (filter) => ({
      rows: filter.rows.length <= 1 ? filter.rows : filter.rows.filter((r) => r.id !== rowId),
    }))
  }

  function filterOptionsOf(filter: TableFilter): FilterOptions {
    return { caseSensitive: filter.caseSensitive, distance: filter.distance }
  }

  async function applyFilter(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab || loadState !== 'ready') return
    const info = infoFor(tab.tableName)
    const opts = filterOptionsOf(tab.filter)
    const where = buildWhereClause(tab.filter.rows, tab.filter.join, opts)
    const query = buildSelect(tab.tableName, where, tab.filter.limit, info?.hasRowid ?? true)

    updateTableTab(tabId, () => ({ query, error: null }))

    try {
      const rows = await execQuery(query)
      let matchCount: number | null = null
      if (where) {
        const countRes = await execQuery(buildCount(tab.tableName, where))
        const raw = countRes?.values?.[0]?.[0]
        matchCount = raw != null ? Number(raw) : null
      }
      updateTableTab(tabId, () => ({
        tableData: rows,
        queryResult: null,
        matchCount,
        error: null,
      }))
    } catch (err) {
      console.error(err)
      updateTableTab(tabId, () => ({
        error: err instanceof Error ? err.message : 'Filter failed',
        queryResult: null,
      }))
    }
  }

  async function resetFilter(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const info = infoFor(tab.tableName)
    const query = defaultQueryFor(tab.tableName)
    updateTableTab(tabId, () => ({
      filter: makeDefaultFilter(info),
      query,
      matchCount: null,
      error: null,
    }))
    try {
      const rows = await execQuery(query)
      updateTableTab(tabId, () => ({ tableData: rows, queryResult: null }))
    } catch (err) {
      console.error(err)
    }
  }

  function handleQueryChange(tabId: string, query: string) {
    updateTableTab(tabId, () => ({ query, error: null }))
  }

  async function handleExecuteQuery(tabId: string) {
    if (loadState !== 'ready') return
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return

    updateTableTab(tabId, () => ({ error: null, queryResult: null }))

    try {
      const res = await execQuery(tab.query)
      updateTableTab(tabId, () => ({ queryResult: res ?? null, error: null, matchCount: null }))
    } catch (err) {
      console.error(err)
      updateTableTab(tabId, () => ({
        error: err instanceof Error ? err.message : 'Failed to execute SQL query',
        queryResult: null,
      }))
    }
  }

  async function handleDownloadDatabase() {
    if (loadState !== 'ready' || !source) return
    try {
      const data = await exportDb()
      const name = source.downloadName || 'database.vyp'
      if (source.fromArchive) {
        const zip = new JSZip()
        zip.file(source.dbName || 'database.vyp', data)
        const blob = await zip.generateAsync({ type: 'blob' })
        downloadBlob(blob, name)
      } else {
        downloadBlob(new Blob([data], { type: 'application/octet-stream' }), name)
      }
    } catch (err) {
      console.error(err)
    }
  }

  const baseHref = () => window.location.pathname + window.location.search

  function openGraph() {
    window.history.pushState(null, '', baseHref() + '#/graph')
    setHashRoute('#/graph')
  }

  function closeGraph() {
    window.history.replaceState(null, '', baseHref())
    setHashRoute('')
  }

  function openTableFromGraph(name: string) {
    closeGraph()
    handleTableSelect(name)
  }

  function closeDatabase() {
    closeGraph()
    setLoadState('idle')
    setTabs([])
    setTabOrder([])
    setTableNamesState([])
    setTableInfosState([])
    setDbInfo(null)
    setSource(null)
    setTableSearch('')
    setSearchValue('')
    resetSearchState()
    resetView()
  }

  /* ---------- render helpers ---------- */

  function renderResultTable(data: QueryExecResult) {
    return (
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              {data.columns.map((col: string) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.values.length === 0 ? (
              <tr>
                <td colSpan={Math.max(1, data.columns.length)} className="empty-cell">
                  No rows match
                </td>
              </tr>
            ) : (
              data.values.map((row: unknown[], i: number) => (
                <tr key={i}>
                  {row.map((cell: unknown, j: number) => (
                    <td key={j} title={cell != null ? String(cell) : undefined}>
                      {cell != null ? String(cell) : <em>null</em>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )
  }

  function renderFilterPanel(tab: TableTab, info: TableInfo | undefined) {
    const columns = info?.columns ?? []
    return (
      <div className="filter-panel">
        <div className="filter-rows">
          {tab.filter.rows.map((row, idx) => {
            const meta = OP_META[row.op]
            return (
              <div className="filter-row" key={row.id}>
                {idx === 0 ? (
                  <span className="filter-join filter-join-static">Where</span>
                ) : (
                  <button
                    type="button"
                    className="filter-join"
                    onClick={() =>
                      updateFilter(tab.id, (f) => ({ join: f.join === 'AND' ? 'OR' : 'AND' }))
                    }
                    title="Toggle AND / OR"
                  >
                    {tab.filter.join}
                  </button>
                )}
                <select
                  className="filter-col"
                  value={row.column}
                  onChange={(e) => updateFilterRow(tab.id, row.id, { column: e.target.value })}
                  aria-label="Column"
                >
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className="filter-op"
                  value={row.op}
                  onChange={(e) =>
                    updateFilterRow(tab.id, row.id, { op: e.target.value as FilterOp })
                  }
                  aria-label="Operator"
                >
                  <optgroup label="Basic">
                    {BASIC_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                  {(tab.filter.advanced || OP_META[row.op]?.advanced) && (
                    <optgroup label="Advanced">
                      {ADVANCED_OPS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {opTakesValue(row.op) ? (
                  <input
                    className="filter-value"
                    value={row.value}
                    placeholder={meta?.hint ?? 'Value'}
                    title={meta?.hint}
                    onChange={(e) => updateFilterRow(tab.id, row.id, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && applyFilter(tab.id)}
                    aria-label="Value"
                  />
                ) : (
                  <span className="filter-value filter-value-none">—</span>
                )}
                <button
                  type="button"
                  className="filter-remove"
                  onClick={() => removeFilterRow(tab.id, row.id)}
                  disabled={tab.filter.rows.length <= 1}
                  aria-label="Remove condition"
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>

        <div className="filter-actions">
          <button type="button" className="filter-add" onClick={() => addFilterRow(tab.id)}>
            + Condition
          </button>
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={tab.filter.advanced}
              onChange={(e) => updateFilter(tab.id, () => ({ advanced: e.target.checked }))}
            />
            Advanced
          </label>
          <span className="filter-actions-spacer" />
          <button type="button" className="filter-reset" onClick={() => resetFilter(tab.id)}>
            Reset
          </button>
          <button type="button" className="filter-apply" onClick={() => applyFilter(tab.id)}>
            Search
          </button>
        </div>

        {tab.filter.advanced && (
          <div className="filter-advanced">
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={tab.filter.caseSensitive}
                onChange={(e) => updateFilter(tab.id, () => ({ caseSensitive: e.target.checked }))}
              />
              Case sensitive
            </label>
            <label className="filter-number">
              Max edit distance
              <input
                type="number"
                min={0}
                max={10}
                value={tab.filter.distance}
                onChange={(e) =>
                  updateFilter(tab.id, () => ({ distance: Number(e.target.value) || 0 }))
                }
              />
            </label>
            <label className="filter-number">
              Row limit
              <input
                type="number"
                min={1}
                max={5000}
                value={tab.filter.limit}
                onChange={(e) => updateFilter(tab.id, () => ({ limit: Number(e.target.value) || 1 }))}
              />
            </label>
            <p className="filter-hint">
              Advanced unlocks LIKE patterns, regex and fuzzy (edit-distance) matching in the
              operator list.
            </p>
          </div>
        )}
      </div>
    )
  }

  function renderSchemaPanel(info: TableInfo) {
    return (
      <div className="schema-panel">
        {(info.primaryKey.length > 0 || info.foreignKeys.length > 0) && (
          <div className="keys-content">
            {info.primaryKey.length > 0 && (
              <div className="keys-block">
                <span className="keys-label">Primary key</span>
                <div className="keys-list">
                  {info.primaryKey.map((col, idx) => (
                    <span key={idx} className="key-badge key-pk">
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {info.foreignKeys.length > 0 && (
              <div className="keys-block">
                <span className="keys-label">Foreign keys</span>
                <ul className="fk-list">
                  {info.foreignKeys.map((fk, idx) => (
                    <li key={idx} className="fk-item">
                      <span className="key-badge key-fk-from">{fk.from}</span>
                      <span className="fk-arrow">→</span>
                      <span className="key-badge key-fk-to">
                        {fk.toTable}({fk.toColumn})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <div className="keys-block">
          <span className="keys-label">Columns</span>
          <div className="column-grid">
            {info.columnDetails.map((c) => (
              <div key={c.name} className="column-chip">
                <span className="column-chip-name">{c.name}</span>
                <span className="column-chip-type">{c.type || 'ANY'}</span>
              </div>
            ))}
          </div>
        </div>
        {info.createStatement && (
          <div className="keys-block">
            <span className="keys-label">CREATE statement</span>
            <pre className="create-statement">{info.createStatement}</pre>
          </div>
        )}
      </div>
    )
  }

  function renderDbInfoPane() {
    const rows: [string, string][] = [
      ['File', source?.filename ?? '—'],
      ...(source?.fromArchive ? ([['Database inside', source.dbName]] as [string, string][]) : []),
      ['Source', source?.url ? source.url : 'Local file'],
      ['Container size', source ? formatBytes(source.sourceBytes) : '—'],
      ['Database size', dbInfo ? formatBytes(dbInfo.sizeBytes) : '—'],
      ['SQLite version', dbInfo?.sqliteVersion ?? '—'],
      ['Encoding', dbInfo?.encoding ?? '—'],
      ['Page size', dbInfo ? `${dbInfo.pageSize} B × ${dbInfo.pageCount.toLocaleString()} pages` : '—'],
      ['Journal mode', dbInfo?.journalMode ?? '—'],
      ['User version', dbInfo ? String(dbInfo.userVersion) : '—'],
      ['Tables', String(tableInfos.length)],
      ['Views', dbInfo ? String(dbInfo.viewCount) : '—'],
      ['Indexes', dbInfo ? String(dbInfo.indexCount) : '—'],
      ['Triggers', dbInfo ? String(dbInfo.triggerCount) : '—'],
      ['Total rows', totalRows.toLocaleString()],
    ]
    const biggest = [...tableInfos].sort((a, b) => b.rowCount - a.rowCount).slice(0, 8)
    return (
      <div className="db-info-pane">
        <dl className="db-info-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="db-info-row">
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        {biggest.length > 0 && (
          <div className="db-info-tables">
            <h4>Largest tables</h4>
            <ul>
              {biggest.map((t) => (
                <li key={t.name}>
                  <button type="button" onClick={() => handleTableSelect(t.name)}>
                    <span className="db-info-table-name">{t.name}</span>
                    <span className="db-info-table-rows">{t.rowCount.toLocaleString()} rows</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  function renderPaneShell(
    tab: Tab,
    opts: { icon: string; title: string; className?: string; menu?: React.ReactNode },
    body: React.ReactNode
  ) {
    return (
      <div
        key={tab.id}
        ref={(el) => {
          paneRefs.current[tab.id] = el
        }}
        className={`pane-card ${opts.className ?? ''} ${draggingTabId === tab.id ? 'pane-dragging' : ''} ${
          focusedPaneId === tab.id ? 'pane-focused' : ''
        }`}
        style={{
          position: 'absolute',
          left: tab.x,
          top: tab.y,
          width: tab.width,
          height: tab.height,
          zIndex: tab.zIndex,
        }}
        onPointerDownCapture={() => setFocusedPaneId(tab.id)}
      >
        <div
          className="pane-header pane-drag-handle"
          onPointerDown={(e) => handlePanePointerDown(e, tab.id)}
          title="Drag to move"
        >
          <span className="pane-drag-grip" aria-hidden>
            ⋮⋮
          </span>
          <h3 className="pane-title">
            <span className="table-icon">{opts.icon}</span>
            {opts.title}
          </h3>
          <div className="pane-header-actions">
            {opts.menu}
            <button
              className="pane-close"
              onClick={(e) => handleCloseTab(tab.id, e)}
              onPointerDown={(e) => e.stopPropagation()}
              aria-label="Close pane"
            >
              ✕
            </button>
          </div>
        </div>
        {body}
      </div>
    )
  }

  function renderResultMenu(tabId: string, data: SqlResult, basename: string) {
    const count = data?.values.length ?? 0
    return (
      <div className="pane-menu-wrap">
        <button
          type="button"
          className="pane-menu-trigger"
          onClick={(e) => {
            e.stopPropagation()
            setOpenPaneMenuId(openPaneMenuId === tabId ? null : tabId)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Pane menu"
          aria-expanded={openPaneMenuId === tabId}
        >
          ⋯
        </button>
        {openPaneMenuId === tabId && (
          <div className="pane-menu-dropdown" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => exportResult(data, basename, 'json')} disabled={count === 0}>
              Export as JSON
            </button>
            <button type="button" onClick={() => exportResult(data, basename, 'csv')} disabled={count === 0}>
              Export as CSV
            </button>
            <button type="button" onClick={() => copyResultAsJson(data)} disabled={count === 0}>
              Copy as JSON (clipboard)
            </button>
          </div>
        )}
      </div>
    )
  }

  /* ---------- home screen pieces ---------- */

  function renderRecentFileRow(meta: RecentFileMeta) {
    return (
      <button
        key={meta.id}
        type="button"
        className="recent-file"
        onClick={() => openRecentFile(meta)}
        disabled={loadState === 'loading'}
        title={meta.path}
      >
        <span className="recent-file-name">{meta.filename}</span>
        <span className="recent-file-meta">
          {meta.sizeBytes ? formatBytes(meta.sizeBytes) : ''}
          {meta.sizeBytes ? ' · ' : ''}
          {formatRecentDate(meta.openedAt)}
        </span>
      </button>
    )
  }

  return (
    <div className="app-root" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          <span className="brand-name">VYB SQLite Studio</span>
        </div>

        {loadState === 'ready' && source && (
          <div className="topbar-db" title={source.filename}>
            <span aria-hidden>{source.url ? '🌐' : source.fromArchive ? '🗜️' : '📄'}</span>
            <span className="topbar-db-name">{source.filename}</span>
          </div>
        )}

        <div className="topbar-spacer" />

        {loadState === 'ready' && !graphOpen && (
          <div className="topbar-actions">
            <button type="button" className="topbar-btn" onClick={openConsolePane}>
              {'</>'} SQL console
            </button>
            <button type="button" className="topbar-btn" onClick={openGraph}>
              Schema graph
            </button>
            <button type="button" className="topbar-btn" onClick={handleDownloadDatabase}>
              Download
            </button>
            <button type="button" className="topbar-btn" onClick={closeDatabase}>
              Close
            </button>
          </div>
        )}

        <div className="theme-switch" role="group" aria-label="Colour theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`theme-switch-btn ${theme === t.value ? 'active' : ''}`}
              onClick={() => setTheme(t.value)}
              aria-pressed={theme === t.value}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* Drag anywhere on the page, on any screen. */}
      {dropActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <div className="drop-overlay-title">Drop to open</div>
            <div className="drop-overlay-sub">
              A database, an archive, or a whole folder — we will work out what is inside.
            </div>
          </div>
        </div>
      )}

      {loadState !== 'ready' && (
        <section className="home">
          <div className="home-hero">
            <h1 className="home-title">Open a SQLite database</h1>
            <p className="home-sub">
              Drop a <code>.vyp</code>, <code>.db</code>, <code>.vyb</code>, <code>.zip</code> — or a
              whole folder — anywhere on this page. Everything stays in your browser.
            </p>
          </div>

          <div className="home-grid">
            <div className="home-col home-col-main">
              <div className={`dropzone drop-zone ${dropActive ? 'dragging' : ''}`}>
                <div className="drop-zone-content">
                  <svg
                    className="dropzone-icon upload-icon"
                    width="44"
                    height="44"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="dropzone-title drop-text">Drag a file or folder here</p>
                  <p className="dropzone-hint drop-sub">
                    Unknown extensions are probed as archives, so mislabelled backups still open.
                  </p>
                  <div className="dropzone-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={loadState === 'loading'}
                    >
                      {loadState === 'loading' ? 'Opening…' : 'Choose files'}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => folderInputRef.current?.click()}
                      disabled={loadState === 'loading'}
                    >
                      Choose folder
                    </button>
                    {supportsFolderAccess() && (
                      <button
                        type="button"
                        className="btn"
                        onClick={linkNewFolder}
                        disabled={loadState === 'loading'}
                        title="Keep access to this folder so new files in it show up later"
                      >
                        Link a folder
                      </button>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleFileInputChange}
                    disabled={loadState === 'loading'}
                    style={{ display: 'none' }}
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    /* @ts-expect-error non-standard but universally supported */
                    webkitdirectory=""
                    directory=""
                    onChange={handleFileInputChange}
                    disabled={loadState === 'loading'}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              <div className="panel-card url-block">
                <div className="panel-card-head">
                  <h3 className="panel-card-title url-title">Open from URL</h3>
                </div>
                <div className="url-row">
                  <input
                    type="url"
                    className="input url-input"
                    placeholder="https://example.com/backup.vyb"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && openFromUrl(urlInput)}
                    disabled={loadState === 'loading'}
                    aria-label="Database URL"
                  />
                  <button
                    type="button"
                    className="btn btn-primary url-button"
                    onClick={() => openFromUrl(urlInput)}
                    disabled={loadState === 'loading' || !urlInput.trim()}
                  >
                    {loadState === 'loading' ? 'Opening…' : 'Open'}
                  </button>
                </div>
                <p className="url-hint">
                  The host must allow cross-origin (CORS) reads. You can deep-link this page with{' '}
                  <code>?url=…</code>.
                </p>
              </div>
            </div>

            <div className="home-col home-col-side">
              {linkedFolders.length > 0 && (
                <div className="panel-card">
                  <div className="panel-card-head">
                    <h2 className="panel-card-title">Linked folders</h2>
                    <span className="panel-card-spacer" />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={linkNewFolder}>
                      + Link
                    </button>
                  </div>
                  {linkedFolders.map((folder) => (
                    <div key={folder.id} className="linked-folder">
                      <span className="linked-folder-name" title={folder.label}>
                        🗂️ {folder.label}
                      </span>
                      <span className="linked-folder-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => ingestFolder(folder, true)}
                        >
                          Rescan
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-danger"
                          onClick={() =>
                            removeFolder(folder.id).then(() => {
                              refreshFolders()
                              refreshRecents()
                            })
                          }
                        >
                          Forget
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel-card recents">
                <div className="panel-card-head">
                  <h2 className="panel-card-title">Recent</h2>
                  <span className="panel-card-spacer" />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-danger"
                    onClick={askClearRecents}
                    disabled={!hasRecents && linkedFolders.length === 0}
                  >
                    Clear all
                  </button>
                </div>
                <input
                  type="search"
                  className="input input-sm recent-search-input"
                  placeholder="Search recent…"
                  value={recentSearch}
                  onChange={(e) => setRecentSearch(e.target.value)}
                  aria-label="Search recent databases"
                />

                {!hasRecents ? (
                  <p className="recent-empty">
                    {recentSearch.trim() ? 'Nothing matches that' : 'Nothing opened yet'}
                  </p>
                ) : (
                  <div className="recent-groups">
                    {groupedRecents.map((group) => {
                      const open = openGroups.has(group.id) || Boolean(recentSearch.trim())
                      return (
                        <div className="recent-group" key={group.id}>
                          <div className="recent-group-head" data-open={open}>
                            <button
                              type="button"
                              className="recent-group-toggle"
                              onClick={() => toggleGroup(group.id)}
                              aria-expanded={open}
                            >
                              <span className="recent-group-chev" data-open={open} aria-hidden>
                                ›
                              </span>
                              <span aria-hidden>{groupIcon(group.kind)}</span>
                              <span className="recent-group-label" title={group.label}>
                                {group.label}
                              </span>
                              <span className="recent-group-count">{group.files.length}</span>
                              {group.handleId && (
                                <span className="recent-group-live" title="Linked folder — re-read live">
                                  live
                                </span>
                              )}
                            </button>
                            <button
                              type="button"
                              className="recent-group-remove"
                              onClick={() => forgetGroup(group)}
                              aria-label={`Forget ${group.label}`}
                            >
                              ✕
                            </button>
                          </div>
                          {open && (
                            <div className="recent-group-body">
                              {group.files.map(renderRecentFileRow)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {looseFiles.length > 0 && (
                      <div className="recent-group recent-group-loose">
                        <div className="recent-group-body">{looseFiles.map(renderRecentFileRow)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {busyNote && <div className="busy-note">{busyNote}</div>}
          {error && <div className="error-banner main-error">{error}</div>}
        </section>
      )}

      {loadState === 'ready' && graphOpen && (
        <GraphView
          key={source?.filename ?? 'db'}
          tables={tableInfos}
          onBack={closeGraph}
          onOpenTable={openTableFromGraph}
          title={source?.filename}
        />
      )}

      {loadState === 'ready' && !graphOpen && (
        <main className="workspace app-main-with-sidebar" ref={workspaceRef}>
          <aside
            className="sidebar tables-sidebar"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
            data-collapsed={sidebarCollapsed}
          >
            {!sidebarCollapsed && (
              <>
                <div className="db-summary">
                  <div className="db-summary-name" title={source?.filename ?? ''}>
                    {source?.url ? '🌐' : '📄'} {source?.filename ?? 'database'}
                  </div>
                  <div className="db-summary-meta">
                    {tableInfos.length} tables · {totalRows.toLocaleString()} rows
                    {dbInfo ? ` · ${formatBytes(dbInfo.sizeBytes)}` : ''}
                  </div>
                  <div className="db-summary-actions">
                    <button type="button" className="db-summary-graph" onClick={openGraph}>
                      Schema graph
                    </button>
                    <button type="button" onClick={openDbInfoPane}>
                      Details
                    </button>
                    <button
                      type="button"
                      onClick={() => setSidebarCollapsed(true)}
                      title="Hide sidebar"
                    >
                      Hide ‹
                    </button>
                  </div>
                </div>

                <div className="search-block">
                  <div className="search-block-head">
                    <label className="search-label" htmlFor="global-search">
                      Search all tables
                    </label>
                    <button
                      type="button"
                      className={`search-advanced-toggle ${searchAdvanced ? 'active' : ''}`}
                      onClick={() => setSearchAdvanced((v) => !v)}
                      aria-expanded={searchAdvanced}
                    >
                      Advanced
                    </button>
                  </div>
                  <div className="search-row">
                    <input
                      id="global-search"
                      type="text"
                      className="tables-search-input search-input"
                      placeholder={'Value, or JSON {"col":"val"}'}
                      value={searchValue}
                      onChange={(e) => {
                        setSearchValue(e.target.value)
                        setSearchError(null)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && runGlobalSearch()}
                      aria-label="Search value across all tables"
                    />
                    <button
                      type="button"
                      className="search-button"
                      onClick={runGlobalSearch}
                      disabled={searchLoading || loadState !== 'ready'}
                    >
                      {searchLoading ? '…' : 'Search'}
                    </button>
                  </div>
                  <div className="search-modes">
                    {SEARCH_MODES.filter((m) => !m.advanced || searchAdvanced).map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        className={`search-mode ${searchMode === m.value ? 'active' : ''}`}
                        onClick={() => setSearchMode(m.value)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {searchAdvanced && (
                    <div className="search-advanced">
                      <input
                        type="text"
                        className="search-column-input"
                        placeholder="Only columns named like…"
                        value={searchColumn}
                        onChange={(e) => setSearchColumn(e.target.value)}
                        aria-label="Restrict to columns whose name contains"
                      />
                      <label className="filter-toggle">
                        <input
                          type="checkbox"
                          checked={searchCaseSensitive}
                          onChange={(e) => setSearchCaseSensitive(e.target.checked)}
                        />
                        Case sensitive
                      </label>
                      {searchMode === 'fuzzy' && (
                        <label className="filter-number">
                          Max edit distance
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={searchDistance}
                            onChange={(e) => setSearchDistance(Number(e.target.value) || 0)}
                          />
                        </label>
                      )}
                    </div>
                  )}
                  {searchError && <p className="search-error">{searchError}</p>}
                  {searchResults && searchResults.length > 0 && (
                    <div className="search-results">
                      <p className="search-results-label">Click a table to open it filtered</p>
                      <ul className="search-list">
                        {searchResults.map((m) => (
                          <li key={m.tableName}>
                            <button
                              type="button"
                              className="search-result-item"
                              onClick={() => openTableFromSearch(m.tableName)}
                            >
                              <span className="search-table-name">{m.tableName}</span>
                              <span className="search-count">
                                {m.matchCount.toLocaleString()} row{m.matchCount !== 1 ? 's' : ''}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {searchResults &&
                    searchResults.length === 0 &&
                    !searchLoading &&
                    searchValue.trim() && <p className="search-empty">No tables match</p>}
                </div>

                <div className="panel-header">
                  <h2>Tables</h2>
                  <span className="table-count">{tableNames.length}</span>
                </div>
                <input
                  type="search"
                  className="tables-search-input"
                  placeholder="Filter tables or columns…"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  aria-label="Filter tables or columns"
                />
                {tableSearch.trim() && tablesByColumnMatch.length > 0 && (
                  <p className="tables-column-hint">
                    Tables with a column matching &quot;{tableSearch.trim()}&quot;
                  </p>
                )}
                <div className="tables-list">
                  {filteredTableInfos.length === 0 ? (
                    <p className="tables-empty">
                      {tableSearch.trim() ? 'No matching tables or columns' : 'No tables'}
                    </p>
                  ) : (
                    filteredTableInfos.map((info) => {
                      const isOpen = tabs.some((t) => isTableTab(t) && t.tableName === info.name)
                      return (
                        <button
                          key={info.name}
                          className={`table-item ${isOpen ? 'open' : ''}`}
                          onClick={() => handleTableSelect(info.name)}
                        >
                          <div className="table-item-header">
                            <span className="table-icon">📊</span>
                            <span className="table-name">{info.name}</span>
                            {isOpen && <span className="tab-indicator">●</span>}
                          </div>
                          <div className="table-item-meta">
                            <span className="table-rows">{info.rowCount.toLocaleString()} rows</span>
                            <span className="table-cols">{info.columns.length} cols</span>
                          </div>
                        </button>
                      )
                    })
                  )}
                </div>
                <div className="panel-footer">
                  <button
                    type="button"
                    onClick={openSavedQueriesPane}
                    className="saved-queries-button"
                  >
                    📌 Saved Queries
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadDatabase}
                    className="download-button"
                  >
                    💾 Download
                  </button>
                </div>
                <div
                  className={`sidebar-resizer ${resizingSidebar ? 'dragging' : ''}`}
                  onPointerDown={handleSidebarResize}
                  onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sidebar"
                />
              </>
            )}
          </aside>

          {sidebarCollapsed && (
            <button
              type="button"
              className="sidebar-reveal"
              onClick={() => setSidebarCollapsed(false)}
              title="Show sidebar"
            >
              ›
            </button>
          )}

          <div className="workspace-main app-content">
            {tabOrder.length > 0 && (
              <div className="tab-bar">
                {tabOrder.map((id) => {
                  const tab = tabs.find((t) => t.id === id)
                  if (!tab) return null
                  const label =
                    tab.type === 'saved-queries'
                      ? 'Saved Queries'
                      : tab.type === 'db-info'
                        ? 'Database'
                        : tab.type === 'console'
                          ? 'SQL console'
                          : tab.tableName
                  return (
                    <div
                      key={id}
                      className={`tab-bar-tab ${draggingTabBarId === id ? 'dragging' : ''} ${
                        focusedPaneId === id ? 'active' : ''
                      }`}
                      draggable
                      onDragStart={(e) => {
                        setDraggingTabBarId(id)
                        e.dataTransfer.setData('text/plain', id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => setDraggingTabBarId(null)}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const dragId = e.dataTransfer.getData('text/plain')
                        if (!dragId || dragId === id) return
                        reorderTabBar(dragId, tabOrder.indexOf(id))
                        setDraggingTabBarId(null)
                      }}
                      onClick={() => focusPane(id)}
                    >
                      <span className="tab-bar-label">{label}</span>
                      <button
                        type="button"
                        className="tab-bar-close"
                        onClick={(e) => handleCloseTab(id, e)}
                        onPointerDown={(e) => e.stopPropagation()}
                        aria-label="Close"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="canvas-shell">
              <div
                ref={canvasRef}
                className="panes-canvas"
                onPointerDown={handleCanvasPointerDown}
              >
                {tabs.length === 0 && (
                  <div className="empty-state">
                    <div className="empty-icon">👈</div>
                    <h2>Open a table</h2>
                    <p className="muted">
                      Pick a table on the left, or open the SQL console to query the whole database.
                      Drag the canvas to pan, scroll to move, ⌘/Ctrl+scroll to zoom.
                    </p>
                    <button type="button" className="empty-graph-button" onClick={openConsolePane}>
                      Open the SQL console →
                    </button>
                  </div>
                )}
                <div ref={canvasInnerRef} className="panes-canvas-inner">
                  {tabs.map((tab) => {
                    if (tab.type === 'saved-queries') {
                      return renderPaneShell(
                        tab,
                        { icon: '📌', title: 'Saved Queries' },
                        <div className="saved-queries-pane-content results-section">
                          {savedQueries.length === 0 ? (
                            <p className="muted">
                              No saved queries. Save one from a SQL panel or the console.
                            </p>
                          ) : (
                            <ul className="saved-queries-list">
                              {savedQueries.map((sq) => (
                                <li key={sq.id} className="saved-query-item">
                                  <div className="saved-query-name">{sq.name}</div>
                                  <pre className="saved-query-sql">
                                    {sq.sql.length > 120 ? sq.sql.slice(0, 120) + '…' : sq.sql}
                                  </pre>
                                  <div className="saved-query-actions">
                                    <button
                                      type="button"
                                      className="saved-query-copy"
                                      onClick={() => copyToClipboard(sq.sql)}
                                    >
                                      Copy
                                    </button>
                                    <button
                                      type="button"
                                      className="saved-query-use"
                                      onClick={() => {
                                        const target =
                                          tabs.find((t) => t.type === 'console') ??
                                          tabs.find(isTableTab)
                                        if (target) handleUseSavedQuery(target.id, sq.sql)
                                        else openConsolePane()
                                      }}
                                    >
                                      Use
                                    </button>
                                    <button
                                      type="button"
                                      className="saved-query-delete"
                                      onClick={() => handleDeleteSavedQuery(sq.id)}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    }

                    if (tab.type === 'db-info') {
                      return renderPaneShell(
                        tab,
                        { icon: 'ⓘ', title: 'Database' },
                        <div className="results-section">{renderDbInfoPane()}</div>
                      )
                    }

                    if (tab.type === 'console') {
                      const rows = tab.result?.values.length ?? 0
                      return renderPaneShell(
                        tab,
                        {
                          icon: '</>',
                          title: 'SQL console',
                          className: 'console-pane',
                          menu: renderResultMenu(tab.id, tab.result, 'console'),
                        },
                        <>
                          <div className="pane-section">
                            <textarea
                              className="console-editor query-editor"
                              value={tab.sql}
                              spellCheck={false}
                              onChange={(e) => updateConsole(tab.id, { sql: e.target.value })}
                              onKeyDown={(e) => {
                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                  e.preventDefault()
                                  runConsole(tab.id)
                                }
                              }}
                              placeholder="SELECT * FROM … — ⌘/Ctrl+Enter to run"
                            />
                            <div className="console-toolbar">
                              <button
                                type="button"
                                className="btn btn-primary btn-sm execute-button"
                                onClick={() => runConsole(tab.id)}
                                disabled={tab.running}
                              >
                                {tab.running ? 'Running…' : '▶ Run'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm save-query-button"
                                onClick={() => handleSaveQuery(tab.sql)}
                              >
                                Save
                              </button>
                              <span className="console-status">
                                {tab.error
                                  ? 'failed'
                                  : tab.result
                                    ? `${rows.toLocaleString()} row${rows === 1 ? '' : 's'}${
                                        tab.elapsedMs != null ? ` · ${tab.elapsedMs} ms` : ''
                                      }`
                                    : 'REGEXP and EDITDIST(a, b) are available'}
                              </span>
                            </div>
                            {tableNames.length > 0 && (
                              <div className="console-tables">
                                {tableNames.slice(0, 40).map((name) => (
                                  <button
                                    key={name}
                                    type="button"
                                    className="console-table-chip"
                                    onClick={() =>
                                      updateConsole(tab.id, { sql: `${tab.sql}"${name}"` })
                                    }
                                    title={`Append "${name}" to the query`}
                                  >
                                    {name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          {tab.error && <div className="console-error error-banner">{tab.error}</div>}
                          <div className="results-section pane-section">
                            {tab.result ? (
                              renderResultTable(tab.result)
                            ) : (
                              <p className="muted">Run a query to see rows here.</p>
                            )}
                          </div>
                        </>
                      )
                    }

                    const tableInfo = infoFor(tab.tableName)
                    const shown = getTabResultData(tab)
                    const shownCount = shown?.values.length ?? 0
                    const totalLabel =
                      tab.matchCount != null
                        ? `${shownCount} of ${tab.matchCount.toLocaleString()} matching`
                        : tableInfo
                          ? `${shownCount} of ${tableInfo.rowCount.toLocaleString()} rows`
                          : `${shownCount} rows`

                    return renderPaneShell(
                      tab,
                      {
                        icon: '📊',
                        title: tab.tableName,
                        menu: renderResultMenu(tab.id, shown, tab.tableName),
                      },
                      <>
                        <div className="pane-tabs">
                          <button
                            type="button"
                            className={`pane-tab ${tab.panel === 'sql' ? 'active' : ''}`}
                            onClick={() => setPanePanel(tab.id, 'sql')}
                          >
                            {'</>'} SQL
                          </button>
                          <button
                            type="button"
                            className={`pane-tab ${tab.panel === 'filter' ? 'active' : ''}`}
                            onClick={() => setPanePanel(tab.id, 'filter')}
                          >
                            🔎 Filter
                          </button>
                          <button
                            type="button"
                            className={`pane-tab ${tab.panel === 'schema' ? 'active' : ''}`}
                            onClick={() => setPanePanel(tab.id, 'schema')}
                            disabled={!tableInfo}
                          >
                            ⓘ Schema
                          </button>
                          <span className="pane-tabs-meta">{totalLabel}</span>
                        </div>

                        {tab.panel === 'filter' && (
                          <div className="pane-section">{renderFilterPanel(tab, tableInfo)}</div>
                        )}

                        {tab.panel === 'sql' && (
                          <div className="query-section pane-section">
                            <textarea
                              className="query-editor"
                              rows={4}
                              spellCheck={false}
                              value={tab.query}
                              onChange={(e) => handleQueryChange(tab.id, e.target.value)}
                              onKeyDown={(e) => {
                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                  e.preventDefault()
                                  handleExecuteQuery(tab.id)
                                }
                              }}
                              placeholder="SQL query..."
                            />
                            <div className="query-actions">
                              <button
                                type="button"
                                onClick={() => handleExecuteQuery(tab.id)}
                                className="execute-button"
                              >
                                ▶ Execute
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveQuery(tab.query)}
                                className="save-query-button"
                              >
                                Save query
                              </button>
                            </div>
                            <p className="query-hint">
                              ⌘/Ctrl+Enter runs. REGEXP and EDITDIST(a, b) are available here too.
                            </p>
                          </div>
                        )}

                        {tab.panel === 'schema' && tableInfo && (
                          <div className="pane-section">{renderSchemaPanel(tableInfo)}</div>
                        )}

                        {tab.error && <div className="error-banner">{tab.error}</div>}

                        <div className="results-section pane-section">
                          {shown ? renderResultTable(shown) : <p className="muted">No data</p>}
                        </div>
                      </>
                    )
                  })}
                </div>
              </div>

              <div className="canvas-toolbar">
                <button
                  type="button"
                  className="canvas-tool"
                  onClick={() => zoomAt(1 / 1.2)}
                  title="Zoom out"
                >
                  −
                </button>
                <button
                  type="button"
                  className="canvas-tool canvas-zoom-label"
                  ref={zoomLabelRef}
                  onClick={resetView}
                  title="Reset to 100%"
                >
                  100%
                </button>
                <button
                  type="button"
                  className="canvas-tool"
                  onClick={() => zoomAt(1.2)}
                  title="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  className="canvas-tool"
                  onClick={fitView}
                  title="Fit every pane"
                  disabled={tabs.length === 0}
                >
                  ⤢
                </button>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* Pick-what-to-open sheet, shared by drops, folders and archives. */}
      {pendingOpen && (
        <div className="modal-backdrop" onClick={() => setPendingOpen(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{pendingOpen.title}</h3>
            <p className="modal-sub">{pendingOpen.subtitle}</p>
            <div className="modal-list">
              {pendingOpen.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="modal-list-item"
                  onClick={() => runPendingItem(item)}
                >
                  <span className="modal-list-name">{item.name}</span>
                  <span className="modal-list-meta">
                    {item.detail !== item.name ? `${item.detail} · ` : ''}
                    {formatBytes(item.sizeBytes)}
                  </span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setPendingOpen(null)}>
                Cancel
              </button>
              {pendingOpen.items.length === 1 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => runPendingItem(pendingOpen.items[0])}
                >
                  Open
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmBox && (
        <div className="modal-backdrop" onClick={() => setConfirmBox(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{confirmBox.title}</h3>
            <p className="modal-sub">{confirmBox.body}</p>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirmBox(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${confirmBox.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => {
                  confirmBox.onConfirm()
                  setConfirmBox(null)
                }}
              >
                {confirmBox.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {loadState !== 'ready' && (
        <footer className="app-footer">
          <p className="muted">
            Everything runs in your browser — nothing is uploaded anywhere.
          </p>
        </footer>
      )}
    </div>
  )
}

export default App
