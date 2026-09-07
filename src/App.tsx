import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { getRecentList, loadRecentDb, saveRecentDb, formatRecentDate } from './recentDb'
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
  ACCEPTED_EXTENSIONS,
  fetchDbFromUrl,
  formatBytes,
  resolveDb,
} from './dbSource'
import './App.css'

type SqlResult = QueryExecResult | null

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const DEFAULT_PANE_WIDTH = 620
const DEFAULT_PANE_HEIGHT = 600
const PANE_OFFSET = 28
const DEFAULT_ROW_LIMIT = 20
const DEFAULT_FILTER_LIMIT = 50
const DEFAULT_EDIT_DISTANCE = 2

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

type TableTab = {
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
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

type SavedQueriesTab = {
  id: string
  type: 'saved-queries'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

type DbInfoTab = {
  id: string
  type: 'db-info'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

type Tab = TableTab | SavedQueriesTab | DbInfoTab

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

async function loadFileAsBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read file'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
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

function App() {
  const [source, setSource] = useState<SourceInfo | null>(null)
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [tableNames, setTableNamesState] = useState<string[]>([])
  const [tableInfos, setTableInfosState] = useState<TableInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [recentList, setRecentList] = useState<{ id: string; filename: string; openedAt: number }[]>([])
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

  const [recentSearch, setRecentSearch] = useState('')
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [tabOrder, setTabOrder] = useState<string[]>([])
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries())
  const [draggingTabBarId, setDraggingTabBarId] = useState<string | null>(null)
  const [openPaneMenuId, setOpenPaneMenuId] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const s = localStorage.getItem('vyb-studio-theme')
      return s === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const paneRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [canvasViewport, setCanvasViewport] = useState({ width: 0, height: 0 })
  const dragRafRef = useRef<number | null>(null)
  const dragPendingRef = useRef<{ tabId: string; x: number; y: number } | null>(null)
  const deepLinkHandledRef = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem('vyb-studio-theme', theme)
      document.documentElement.setAttribute('data-theme', theme)
    } catch {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  useEffect(() => {
    if (loadState !== 'ready') {
      getRecentList().then(setRecentList).catch(() => setRecentList([]))
    }
  }, [loadState])

  useEffect(() => {
    const entries = Object.entries(paneRefs.current)
    const observers: ResizeObserver[] = []
    entries.forEach(([id, el]) => {
      if (!el) return
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        const { width, height } = entry.contentRect
        updatePaneSize(id, Math.round(width), Math.round(height))
      })
      ro.observe(el)
      observers.push(ro)
    })
    return () => observers.forEach((ro) => ro.disconnect())
  }, [tabs.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      setCanvasViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
    })
    ro.observe(canvas)
    setCanvasViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
    return () => ro.disconnect()
  }, [loadState])

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

  const filteredRecentList = useMemo(() => {
    if (!recentSearch.trim()) return recentList
    const q = recentSearch.trim().toLowerCase()
    return recentList.filter((e) => e.filename.toLowerCase().includes(q))
  }, [recentList, recentSearch])

  const totalRows = useMemo(
    () => tableInfos.reduce((sum, info) => sum + info.rowCount, 0),
    [tableInfos]
  )

  function resetSearchState() {
    setSearchResults(null)
    setSearchError(null)
    setAppliedSearch(null)
  }

  const openDbFile = useCallback(
    async function openDbFile(buffer: ArrayBuffer, filename: string, url: string | null = null) {
      setLoadState('loading')
      setError(null)
      setTabs([])
      setTableNamesState([])
      setTableInfosState([])
      setDbInfo(null)
      setSearchResults(null)
      setSearchError(null)
      setAppliedSearch(null)

      try {
        const resolved = await resolveDb(buffer, filename)

        // openDb transfers the buffer; keep an intact copy for the recents store.
        const recentBuffer =
          resolved.bytes.buffer === buffer ? buffer.slice(0) : buffer

        await openDb(resolved.bytes)

        const names = await getTableNames()
        const infos = await Promise.all(names.map((name) => getTableInfo(name)))
        const info = await getDbInfo().catch(() => null)

        setTableNamesState(names)
        setTableInfosState(infos)
        setDbInfo(info)
        setSource({
          filename,
          dbName: resolved.dbName,
          downloadName: resolved.downloadName,
          fromArchive: resolved.fromArchive,
          sourceBytes: resolved.sourceBytes,
          url,
        })
        setLoadState('ready')
        saveRecentDb(filename, recentBuffer).catch(() => {})
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Failed to open database')
        setLoadState('error')
      }
    },
    []
  )

  const openFromUrl = useCallback(
    async function openFromUrl(rawUrl: string) {
      const url = rawUrl.trim()
      if (!url) return
      setLoadState('loading')
      setError(null)
      try {
        const { buffer, filename } = await fetchDbFromUrl(url)
        await openDbFile(buffer, filename, url)
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : 'Failed to open URL')
        setLoadState('error')
      }
    },
    [openDbFile]
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

  async function openRecentDb(id: string) {
    setLoadState('loading')
    setError(null)
    try {
      const { filename, data } = await loadRecentDb(id)
      await openDbFile(data, filename)
    } catch (err) {
      console.error(err)
      setLoadState('error')
      setError(err instanceof Error ? err.message : 'Failed to open recent database')
    }
  }

  async function handleFileUpload(file: File) {
    try {
      const buffer = await loadFileAsBuffer(file)
      await openDbFile(buffer, file.name)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Failed to read file')
      setLoadState('error')
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFileUpload(file)
  }

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

    const maxZ = tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.zIndex))
    const newTab: TableTab = {
      id: newTabId,
      type: 'table',
      tableName,
      tableData,
      query,
      queryResult: null,
      matchCount: null,
      filter: makeDefaultFilter(info),
      panel: 'filter',
      error: queryError,
      x: 20 + tabs.length * PANE_OFFSET,
      y: 20 + tabs.length * PANE_OFFSET,
      width: DEFAULT_PANE_WIDTH,
      height: DEFAULT_PANE_HEIGHT,
      zIndex: maxZ + 1,
    }

    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTabId])
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
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, zIndex: maxZ + 1 } : tab))
    )
    paneRefs.current[tabId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function nextPanePosition() {
    return { x: 20 + tabs.length * PANE_OFFSET, y: 20 + tabs.length * PANE_OFFSET }
  }

  function openSavedQueriesPane() {
    const existing = tabs.find((t) => t.type === 'saved-queries')
    if (existing) {
      focusPane(existing.id)
      return
    }
    const maxZ = tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.zIndex))
    const { x, y } = nextPanePosition()
    const newTab: SavedQueriesTab = {
      id: newId('saved-queries'),
      type: 'saved-queries',
      x,
      y,
      width: 380,
      height: 420,
      zIndex: maxZ + 1,
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTab.id])
  }

  function openDbInfoPane() {
    const existing = tabs.find((t) => t.type === 'db-info')
    if (existing) {
      focusPane(existing.id)
      return
    }
    const maxZ = tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.zIndex))
    const { x, y } = nextPanePosition()
    const newTab: DbInfoTab = {
      id: newId('db-info'),
      type: 'db-info',
      x,
      y,
      width: 460,
      height: 520,
      zIndex: maxZ + 1,
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTab.id])
  }

  function handleSaveQuery(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return
    const name = window.prompt('Name for this query')
    if (!name?.trim()) return
    const newItem: SavedQuery = { id: newId('sq'), name: name.trim(), sql: tab.query }
    persistSavedQueries([...savedQueries, newItem])
  }

  function handleUseSavedQuery(tabId: string, sql: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return
    handleQueryChange(tabId, sql)
    setPanePanel(tabId, 'sql')
    focusPane(tabId)
  }

  function handleDeleteSavedQuery(id: string) {
    persistSavedQueries(savedQueries.filter((q) => q.id !== id))
  }

  function copySavedQueryToClipboard(sql: string) {
    navigator.clipboard.writeText(sql).catch(() => {})
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

  function exportQueryResultsAsJson(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    const json = JSON.stringify(resultToRows(data), null, 2)
    downloadBlob(new Blob([json], { type: 'application/json' }), `${tab.tableName}-results.json`)
    setTimeout(() => setOpenPaneMenuId(null), 0)
  }

  function exportQueryResultsAsCsv(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    downloadBlob(new Blob([buildCsvFromResult(data)], { type: 'text/csv' }), `${tab.tableName}-results.csv`)
    setTimeout(() => setOpenPaneMenuId(null), 0)
  }

  function buildCsvFromResult(data: QueryExecResult): string {
    const escape = (v: unknown) => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = data.columns.map(escape).join(',')
    const lines = data.values.map((row) => row.map(escape).join(','))
    return [header, ...lines].join('\n')
  }

  async function copyQueryResultsAsJson(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    const json = JSON.stringify(resultToRows(data), null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = json
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
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

  function flushDragPosition() {
    if (dragRafRef.current != null || !dragPendingRef.current) return
    const { tabId, x, y } = dragPendingRef.current
    dragPendingRef.current = null
    setTabs((prev) => {
      const maxZ = Math.max(...prev.map((t) => t.zIndex))
      return prev.map((tab) =>
        tab.id === tabId ? { ...tab, x: Math.max(0, x), y: Math.max(0, y), zIndex: maxZ + 1 } : tab
      )
    })
  }

  function handlePanePointerDown(e: React.PointerEvent, tabId: string) {
    if (e.button !== 0) return
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !canvasRef.current) return
    const el = paneRefs.current[tabId]
    if (el) {
      const rect = el.getBoundingClientRect()
      dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    } else {
      dragOffsetRef.current = { x: 0, y: 0 }
    }
    setDraggingTabId(tabId)
    const captureTarget = e.currentTarget
    const pointerId = e.pointerId
    captureTarget.setPointerCapture(pointerId)

    const canvas = canvasRef.current

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left + canvas.scrollLeft - dragOffsetRef.current.x
      const y = e.clientY - rect.top + canvas.scrollTop - dragOffsetRef.current.y
      dragPendingRef.current = { tabId, x, y }
      if (dragRafRef.current == null) {
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null
          flushDragPosition()
        })
      }
    }

    const onPointerUp = () => {
      try {
        captureTarget.releasePointerCapture(pointerId)
      } catch {
        /* ignore */
      }
      if (dragRafRef.current != null) {
        cancelAnimationFrame(dragRafRef.current)
        dragRafRef.current = null
      }
      flushDragPosition()
      dragPendingRef.current = null
      setDraggingTabId(null)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  function updatePaneSize(tabId: string, width: number, height: number) {
    const w = Math.max(320, Math.round(width))
    const h = Math.max(360, Math.round(height))
    setTabs((prev) => {
      const next = prev.map((tab) => (tab.id === tabId ? { ...tab, width: w, height: h } : tab))
      const changed = prev.some((t) => t.id === tabId && (t.width !== w || t.height !== h))
      return changed ? next : prev
    })
  }

  const canvasSize = useMemo(() => {
    if (tabs.length === 0) return { width: 0, height: 0 }
    const right = Math.max(...tabs.map((t) => t.x + t.width))
    const bottom = Math.max(...tabs.map((t) => t.y + t.height))
    return { width: Math.max(right + 120, 800), height: Math.max(bottom + 120, 600) }
  }, [tabs])

  const innerSize = useMemo(
    () => ({
      minWidth: Math.max(canvasSize.width, canvasViewport.width),
      minHeight: Math.max(canvasSize.height, canvasViewport.height),
    }),
    [canvasSize.width, canvasSize.height, canvasViewport.width, canvasViewport.height]
  )

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

  function closeDatabase() {
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
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFileUpload(file)
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
                onChange={(e) =>
                  updateFilter(tab.id, () => ({ caseSensitive: e.target.checked }))
                }
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
                onChange={(e) =>
                  updateFilter(tab.id, () => ({ limit: Number(e.target.value) || 1 }))
                }
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

  const acceptAttr = ACCEPTED_EXTENSIONS.join(',')

  return (
    <div className="app-root" data-theme={theme}>
      <header className="app-header">
        <div className="app-header-inner">
          <h1>VYB SQLite Studio</h1>
          <p className="subtitle">
            Open a <code>.vyb</code>, <code>.vyp</code>, <code>.db</code>, or <code>.zip</code> —
            from your machine or a URL — to browse, search and edit the SQLite database in your
            browser.
          </p>
        </div>
        <div className="theme-toggle-wrap">
          <button
            type="button"
            className={`theme-toggle ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => setTheme('dark')}
            title="Dark theme"
            aria-pressed={theme === 'dark'}
          >
            Dark
          </button>
          <button
            type="button"
            className={`theme-toggle ${theme === 'light' ? 'active' : ''}`}
            onClick={() => setTheme('light')}
            title="Light theme"
            aria-pressed={theme === 'light'}
          >
            Light
          </button>
        </div>
      </header>

      {loadState !== 'ready' && (
        <section className="main-screen">
          <div className="main-screen-layout">
            {recentList.length > 0 && (
              <div className="recent-block">
                <div className="recent-block-header">
                  <h2 className="recent-title">Recent</h2>
                  <input
                    type="search"
                    className="recent-search-input"
                    placeholder="Search recent…"
                    value={recentSearch}
                    onChange={(e) => setRecentSearch(e.target.value)}
                    aria-label="Search recent databases"
                  />
                </div>
                <div className="recent-list">
                  {filteredRecentList.length === 0 ? (
                    <p className="recent-empty">
                      {recentSearch.trim() ? 'No matching recent files' : 'No recent files'}
                    </p>
                  ) : (
                    filteredRecentList.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="recent-card"
                        onClick={() => openRecentDb(entry.id)}
                        disabled={loadState === 'loading'}
                      >
                        <span className="recent-icon">📄</span>
                        <span className="recent-filename">{entry.filename}</span>
                        <span className="recent-date">{formatRecentDate(entry.openedAt)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            <div className="upload-block">
              <h2 className="upload-title">
                {recentList.length > 0 ? 'Open another file' : 'Open a database file'}
              </h2>
              <div
                className={`drop-zone ${isDragging ? 'dragging' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="drop-zone-content">
                  <svg
                    className="upload-icon"
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="drop-text">Drop a .vyb, .vyp, .db, or .zip file here</p>
                  <p className="drop-sub">or</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loadState === 'loading'}
                    className="browse-button"
                  >
                    {loadState === 'loading' ? 'Opening…' : 'Browse'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={acceptAttr}
                    onChange={handleFileInputChange}
                    disabled={loadState === 'loading'}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

              <div className="url-block">
                <h3 className="url-title">Open from URL</h3>
                <div className="url-row">
                  <input
                    type="url"
                    className="url-input"
                    placeholder="https://example.com/backup.vyb"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && openFromUrl(urlInput)}
                    disabled={loadState === 'loading'}
                    aria-label="Database URL"
                  />
                  <button
                    type="button"
                    className="url-button"
                    onClick={() => openFromUrl(urlInput)}
                    disabled={loadState === 'loading' || !urlInput.trim()}
                  >
                    {loadState === 'loading' ? 'Opening…' : 'Open'}
                  </button>
                </div>
                <p className="url-hint">
                  Works with <code>.vyp</code>, <code>.vyb</code> and <code>.zip</code> links. The
                  host must allow cross-origin (CORS) reads. You can also deep-link this page with{' '}
                  <code>?url=…</code>.
                </p>
              </div>
            </div>
          </div>

          {error && <div className="error-banner main-error">{error}</div>}
        </section>
      )}

      {loadState === 'ready' && (
        <main className="app-main-with-sidebar">
          <aside className="tables-sidebar">
            <div className="db-summary">
              <div className="db-summary-name" title={source?.filename ?? ''}>
                {source?.url ? '🌐' : '📄'} {source?.filename ?? 'database'}
              </div>
              <div className="db-summary-meta">
                {tableInfos.length} tables · {totalRows.toLocaleString()} rows
                {dbInfo ? ` · ${formatBytes(dbInfo.sizeBytes)}` : ''}
              </div>
              <div className="db-summary-actions">
                <button type="button" onClick={openDbInfoPane}>
                  Details
                </button>
                <button type="button" onClick={closeDatabase}>
                  Close
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
              {searchResults && searchResults.length === 0 && !searchLoading && searchValue.trim() && (
                <p className="search-empty">No tables match</p>
              )}
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
              <button type="button" onClick={openSavedQueriesPane} className="saved-queries-button">
                📌 Saved Queries
              </button>
              <button type="button" onClick={handleDownloadDatabase} className="download-button">
                💾 Download
              </button>
            </div>
          </aside>

          <div className="app-content">
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
                        : tab.tableName
                  return (
                    <div
                      key={id}
                      className={`tab-bar-tab ${draggingTabBarId === id ? 'dragging' : ''}`}
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
            <div ref={canvasRef} className="panes-canvas">
              {tabs.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">👈</div>
                  <h2>Open a table</h2>
                  <p className="muted">
                    Click a table on the left to open it in a pane, or search a value across every
                    table to find where it lives.
                  </p>
                </div>
              )}
              <div
                className="panes-canvas-inner"
                style={{ minWidth: innerSize.minWidth, minHeight: innerSize.minHeight }}
              >
                {tabs.map((tab) => {
                  const paneStyle: React.CSSProperties = {
                    position: 'absolute',
                    left: tab.x,
                    top: tab.y,
                    width: tab.width,
                    height: tab.height,
                    zIndex: tab.zIndex,
                  }

                  if (tab.type === 'saved-queries' || tab.type === 'db-info') {
                    const isSaved = tab.type === 'saved-queries'
                    return (
                      <div
                        key={tab.id}
                        ref={(el) => {
                          paneRefs.current[tab.id] = el
                        }}
                        className={`pane-card ${draggingTabId === tab.id ? 'pane-dragging' : ''}`}
                        style={paneStyle}
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
                            <span className="table-icon">{isSaved ? '📌' : 'ⓘ'}</span>
                            {isSaved ? 'Saved Queries' : 'Database'}
                          </h3>
                          <button
                            className="pane-close"
                            onClick={(e) => handleCloseTab(tab.id, e)}
                            onPointerDown={(e) => e.stopPropagation()}
                            aria-label="Close pane"
                          >
                            ✕
                          </button>
                        </div>
                        {isSaved ? (
                          <div className="saved-queries-pane-content">
                            {savedQueries.length === 0 ? (
                              <p className="muted">
                                No saved queries. Save one from a table pane's SQL panel.
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
                                        onClick={() => copySavedQueryToClipboard(sq.sql)}
                                      >
                                        Copy
                                      </button>
                                      {tabs.filter(isTableTab).length > 0 && (
                                        <button
                                          type="button"
                                          className="saved-query-use"
                                          onClick={() => {
                                            const first = tabs.find(isTableTab)
                                            if (first) handleUseSavedQuery(first.id, sq.sql)
                                          }}
                                        >
                                          Use in first table
                                        </button>
                                      )}
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
                        ) : (
                          renderDbInfoPane()
                        )}
                      </div>
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

                  return (
                    <div
                      key={tab.id}
                      ref={(el) => {
                        paneRefs.current[tab.id] = el
                      }}
                      className={`pane-card ${draggingTabId === tab.id ? 'pane-dragging' : ''}`}
                      style={paneStyle}
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
                          <span className="table-icon">📊</span>
                          {tab.tableName}
                        </h3>
                        <div className="pane-header-actions">
                          <div className="pane-menu-wrap">
                            <button
                              type="button"
                              className="pane-menu-trigger"
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenPaneMenuId(openPaneMenuId === tab.id ? null : tab.id)
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                              aria-label="Pane menu"
                              aria-expanded={openPaneMenuId === tab.id}
                            >
                              ⋯
                            </button>
                            {openPaneMenuId === tab.id && (
                              <div className="pane-menu-dropdown" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  onClick={() => exportQueryResultsAsJson(tab.id)}
                                  disabled={shownCount === 0}
                                >
                                  Export as JSON
                                </button>
                                <button
                                  type="button"
                                  onClick={() => exportQueryResultsAsCsv(tab.id)}
                                  disabled={shownCount === 0}
                                >
                                  Export as CSV
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copyQueryResultsAsJson(tab.id)}
                                  disabled={shownCount === 0}
                                >
                                  Copy as JSON (clipboard)
                                </button>
                              </div>
                            )}
                          </div>
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

                      <div className="pane-tabs">
                        <button
                          type="button"
                          className={`pane-tab ${tab.panel === 'filter' ? 'active' : ''}`}
                          onClick={() => setPanePanel(tab.id, 'filter')}
                        >
                          🔎 Filter
                        </button>
                        <button
                          type="button"
                          className={`pane-tab ${tab.panel === 'sql' ? 'active' : ''}`}
                          onClick={() => setPanePanel(tab.id, 'sql')}
                        >
                          {'</>'} SQL
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
                            value={tab.query}
                            onChange={(e) => handleQueryChange(tab.id, e.target.value)}
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
                              onClick={() => handleSaveQuery(tab.id)}
                              className="save-query-button"
                            >
                              Save query
                            </button>
                          </div>
                          <p className="query-hint">
                            REGEXP and EDITDIST(a, b) are available here too.
                          </p>
                        </div>
                      )}

                      {tab.panel === 'schema' && tableInfo && (
                        <div className="pane-section">{renderSchemaPanel(tableInfo)}</div>
                      )}

                      {tab.error && <div className="error-banner">{tab.error}</div>}

                      <div className="results-section pane-section">
                        {shown ? (
                          renderResultTable(shown)
                        ) : (
                          <p className="muted">No data</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </main>
      )}

      <footer className="app-footer">
        <p className="muted">
          All work happens in your browser. No data is uploaded to any server. Designed to be
          deployed as a static app (GitHub Pages compatible).
        </p>
      </footer>
    </div>
  )
}

export default App
