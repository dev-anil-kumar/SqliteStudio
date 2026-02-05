import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { getRecentList, loadRecentDb, saveRecentDb, formatRecentDate } from './recentDb'
import { openDb, execQuery, getTableNames, getTableInfo, exportDb, type TableInfo, type QueryExecResult } from './dbBridge'
import './App.css'

type SqlResult = QueryExecResult | null

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const DEFAULT_PANE_WIDTH = 560
const DEFAULT_PANE_HEIGHT = 560
const PANE_OFFSET = 28
const DEFAULT_ROW_LIMIT = 20

type TableTab = {
  id: string
  type: 'table'
  tableName: string
  tableData: SqlResult
  query: string
  queryResult: SqlResult
  error: string | null
  schemaCollapsed: boolean
  keysCollapsed: boolean
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

type Tab = TableTab | SavedQueriesTab

function isTableTab(tab: Tab): tab is TableTab {
  return tab.type === 'table'
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

async function extractVypFromZip(buffer: ArrayBuffer): Promise<{
  vypBytes: Uint8Array
  vypName: string
}> {
  const zip = await JSZip.loadAsync(buffer)

  const entries = Object.values(zip.files)
  const vypEntry = entries.find((f) => f.name.toLowerCase().endsWith('.vyp'))

  if (!vypEntry) {
    throw new Error('No .vyp file found inside .vyb (zip) archive')
  }

  const arrayBuffer = await vypEntry.async('arraybuffer')
  return { vypBytes: new Uint8Array(arrayBuffer), vypName: vypEntry.name }
}

function App() {
  const [dbFilename, setDbFilename] = useState<string | null>(null)
  const [vybFilename, setVybFilename] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [tableNames, setTableNamesState] = useState<string[]>([])
  const [tableInfos, setTableInfosState] = useState<TableInfo[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [recentList, setRecentList] = useState<{ id: string; filename: string; openedAt: number }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
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

  /* tableNames and tableInfos are set by processVybBuffer after worker opens DB */

  const filteredTableInfos = useMemo(() => {
    if (!tableSearch.trim()) return tableInfos
    const q = tableSearch.trim().toLowerCase()
    return tableInfos.filter((info) => info.name.toLowerCase().includes(q))
  }, [tableInfos, tableSearch])

  const filteredRecentList = useMemo(() => {
    if (!recentSearch.trim()) return recentList
    const q = recentSearch.trim().toLowerCase()
    return recentList.filter((e) => e.filename.toLowerCase().includes(q))
  }, [recentList, recentSearch])

  async function processVybBuffer(buffer: ArrayBuffer, filename: string) {
    setLoadState('loading')
    setError(null)
    setTabs([])
    setTableNamesState([])
    setTableInfosState([])

    try {
      const baseName = filename.toLowerCase().endsWith('.vyb')
        ? filename.slice(0, -4)
        : filename.replace(/\.[^/.]+$/, '')

      const { vypBytes, vypName } = await extractVypFromZip(buffer)
      await openDb(vypBytes)

      const names = await getTableNames()
      const infos = await Promise.all(names.map((name) => getTableInfo(name)))

      setTableNamesState(names)
      setTableInfosState(infos)
      setDbFilename(vypName)
      setVybFilename(`${baseName}.vyb`)
      setLoadState('ready')
      saveRecentDb(filename, buffer).catch(() => {})
    } catch (err) {
      console.error(err)
      setLoadState('error')
    }
  }

  async function openRecentDb(id: string) {
    setLoadState('loading')
    setError(null)
    try {
      const { filename, data } = await loadRecentDb(id)
      await processVybBuffer(data, filename)
    } catch (err) {
      console.error(err)
      setLoadState('error')
      setError(err instanceof Error ? err.message : 'Failed to open recent database')
    }
  }

  async function handleFileUpload(file: File) {
    try {
      const buffer = await loadFileAsBuffer(file)
      await processVybBuffer(buffer, file.name)
    } catch (err) {
      console.error(err)
      setLoadState('error')
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      handleFileUpload(file)
    }
  }

  function persistSavedQueries(next: SavedQuery[]) {
    setSavedQueries(next)
    try {
      localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  async function handleTableSelect(tableName: string) {
    if (loadState !== 'ready') return

    const existingTab = tabs.find((t): t is TableTab => isTableTab(t) && t.tableName === tableName)
    if (existingTab) {
      focusPane(existingTab.id)
      return
    }

    const quotedTable = `"${tableName.replace(/"/g, '""')}"`
    const newTabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    let tableData: SqlResult = null
    const defaultQuery = `SELECT * FROM ${quotedTable} ORDER BY rowid DESC LIMIT ${DEFAULT_ROW_LIMIT};`
    try {
      tableData = await execQuery(`SELECT * FROM ${quotedTable} ORDER BY rowid DESC LIMIT ${DEFAULT_ROW_LIMIT};`)
    } catch (err) {
      console.error(err)
    }

    const maxZ = tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.zIndex))
    const newTab: TableTab = {
      id: newTabId,
      type: 'table',
      tableName,
      tableData,
      query: defaultQuery,
      queryResult: null,
      error: null,
      schemaCollapsed: true,
      keysCollapsed: true,
      x: 20 + tabs.length * PANE_OFFSET,
      y: 20 + tabs.length * PANE_OFFSET,
      width: DEFAULT_PANE_WIDTH,
      height: DEFAULT_PANE_HEIGHT,
      zIndex: maxZ + 1,
    }

    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTabId])
  }

  function focusPane(tabId: string) {
    const maxZ = Math.max(...tabs.map((t) => t.zIndex))
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, zIndex: maxZ + 1 } : tab
      )
    )
    paneRefs.current[tabId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function openSavedQueriesPane() {
    const existing = tabs.find((t) => t.type === 'saved-queries')
    if (existing) {
      focusPane(existing.id)
      return
    }
    const newTabId = `saved-queries-${Date.now()}`
    const maxZ = tabs.length === 0 ? 0 : Math.max(...tabs.map((t) => t.zIndex))
    const newTab: SavedQueriesTab = {
      id: newTabId,
      type: 'saved-queries',
      x: 20 + tabs.length * PANE_OFFSET,
      y: 20 + tabs.length * PANE_OFFSET,
      width: 380,
      height: 420,
      zIndex: maxZ + 1,
    }
    setTabs((prev) => [...prev, newTab])
    setTabOrder((prev) => [...prev, newTabId])
  }

  function handleSaveQuery(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return
    const name = window.prompt('Name for this query')
    if (!name?.trim()) return
    const newItem: SavedQuery = {
      id: `sq-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: name.trim(),
      sql: tab.query,
    }
    persistSavedQueries([...savedQueries, newItem])
  }

  function handleUseSavedQuery(tabId: string, sql: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return
    handleQueryChange(tabId, sql)
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
    // Defer click so it runs after current event; ensures download in all browsers when triggered from menu
    setTimeout(() => {
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 0)
  }

  function exportQueryResultsAsJson(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    const rows = data.values.map((row) => {
      const obj: Record<string, unknown> = {}
      data.columns.forEach((col, i) => {
        obj[col] = row[i]
      })
      return obj
    })
    const json = JSON.stringify(rows, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    downloadBlob(blob, `${tab.tableName}-results.json`)
    setTimeout(() => setOpenPaneMenuId(null), 0)
  }

  function exportQueryResultsAsCsv(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    const csv = buildCsvFromResult(data)
    const blob = new Blob([csv], { type: 'text/csv' })
    downloadBlob(blob, `${tab.tableName}-results.csv`)
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

  async function copyQueryResultsAsCsv(tabId: string) {
    const tab = tabs.find((t): t is TableTab => t.id === tabId && isTableTab(t))
    if (!tab) return
    const data = getTabResultData(tab)
    if (!data || data.values.length === 0) return
    const csv = buildCsvFromResult(data)
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(csv)
      } else {
        // Fallback for very old browsers: use a hidden textarea
        const textarea = document.createElement('textarea')
        textarea.value = csv
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
        tab.id === tabId
          ? { ...tab, x: Math.max(0, x), y: Math.max(0, y), zIndex: maxZ + 1 }
          : tab
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
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
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
    const h = Math.max(420, Math.round(height))
    setTabs((prev) => {
      const next = prev.map((tab) =>
        tab.id === tabId ? { ...tab, width: w, height: h } : tab
      )
      const changed = prev.some(
        (t) => t.id === tabId && (t.width !== w || t.height !== h)
      )
      return changed ? next : prev
    })
  }

  const canvasSize = useMemo(() => {
    if (tabs.length === 0) return { width: 0, height: 0 }
    const right = Math.max(...tabs.map((t) => t.x + t.width))
    const bottom = Math.max(...tabs.map((t) => t.y + t.height))
    return {
      width: Math.max(right + 120, 800),
      height: Math.max(bottom + 120, 600),
    }
  }, [tabs])

  const innerSize = useMemo(
    () => ({
      minWidth: Math.max(canvasSize.width, canvasViewport.width),
      minHeight: Math.max(canvasSize.height, canvasViewport.height),
    }),
    [canvasSize.width, canvasSize.height, canvasViewport.width, canvasViewport.height]
  )

  function toggleSchemaCollapsed(tabId: string) {
    setTabs(
      tabs.map((t) =>
        t.id === tabId && isTableTab(t) ? { ...t, schemaCollapsed: !t.schemaCollapsed } : t
      )
    )
  }

  function toggleKeysCollapsed(tabId: string) {
    setTabs(
      tabs.map((t) =>
        t.id === tabId && isTableTab(t) ? { ...t, keysCollapsed: !t.keysCollapsed } : t
      )
    )
  }

  function handleQueryChange(tabId: string, query: string) {
    setTabs(
      tabs.map((t) =>
        t.id === tabId && isTableTab(t) ? { ...t, query, error: null } : t
      )
    )
  }

  async function handleExecuteQuery(tabId: string) {
    if (loadState !== 'ready') return
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !isTableTab(tab)) return

    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, error: null, queryResult: null } : t
      )
    )

    try {
      const res = await execQuery(tab.query)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId ? { ...t, queryResult: res ?? null, error: null } : t
        )
      )
    } catch (err) {
      console.error(err)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                error: err instanceof Error ? err.message : 'Failed to execute SQL query',
                queryResult: null,
              }
            : t
        )
      )
    }
  }

  async function handleDownloadUpdatedVyb() {
    if (loadState !== 'ready') return
    try {
      const data = await exportDb()
      const zip = new JSZip()
      const filename = dbFilename ?? 'database.vyp'
      zip.file(filename, data)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, vybFilename ?? 'database.vyb')
    } catch (err) {
      console.error(err)
    }
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
    if (file && (file.name.toLowerCase().endsWith('.vyb') || file.name.toLowerCase().endsWith('.zip'))) {
      handleFileUpload(file)
    }
  }

  return (
    <div className="app-root" data-theme={theme}>
      <header className="app-header">
        <div className="app-header-inner">
          <h1>VYB SQLite Studio</h1>
          <p className="subtitle">
            Open a <code>.vyb</code> archive to browse and edit the internal SQLite database in your browser.
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
                {recentList.length > 0 ? 'Open another file' : 'Open a .vyb file'}
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
                  <p className="drop-text">Drop a .vyb file here</p>
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
                    accept=".vyb,.zip"
                    onChange={handleFileInputChange}
                    disabled={loadState === 'loading'}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="error-banner main-error">
              {error}
            </div>
          )}
        </section>
      )}

      {loadState === 'ready' && (
        <main className="app-main-with-sidebar">
          <aside className="tables-sidebar">
            <div className="panel-header">
              <h2>Tables</h2>
              <span className="table-count">{tableNames.length}</span>
            </div>
            <input
              type="search"
              className="tables-search-input"
              placeholder="Search tables…"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              aria-label="Search tables"
            />
            <div className="tables-list">
              {filteredTableInfos.length === 0 ? (
                <p className="tables-empty">
                  {tableSearch.trim() ? 'No matching tables' : 'No tables'}
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
                onClick={handleDownloadUpdatedVyb}
                className="download-button"
              >
                💾 Download .vyb
              </button>
            </div>
          </aside>

          <div className="app-content">
            {tabOrder.length > 0 && (
              <div className="tab-bar">
                {tabOrder.map((id) => {
                  const tab = tabs.find((t) => t.id === id)
                  if (!tab) return null
                  const label = tab.type === 'saved-queries' ? 'Saved Queries' : isTableTab(tab) ? tab.tableName : id
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
                        const toIndex = tabOrder.indexOf(id)
                        reorderTabBar(dragId, toIndex)
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
                  <p className="muted">Click a table on the left to open it in a new pane. Multiple panes show side by side.</p>
                </div>
              )}
              <div
                className="panes-canvas-inner"
                style={{
                  minWidth: innerSize.minWidth,
                  minHeight: innerSize.minHeight,
                }}
              >
                {tabs.map((tab) => {
                    if (tab.type === 'saved-queries') {
                      return (
                        <div
                          key={tab.id}
                          ref={(el) => {
                            paneRefs.current[tab.id] = el
                          }}
                          className={`pane-card ${draggingTabId === tab.id ? 'pane-dragging' : ''}`}
                          style={{
                            position: 'absolute',
                            left: tab.x,
                            top: tab.y,
                            width: tab.width,
                            height: tab.height,
                            zIndex: tab.zIndex,
                          }}
                        >
                          <div
                            className="pane-header pane-drag-handle"
                            onPointerDown={(e) => handlePanePointerDown(e, tab.id)}
                            title="Drag to move"
                          >
                            <span className="pane-drag-grip" aria-hidden>⋮⋮</span>
                            <h3 className="pane-title">
                              <span className="table-icon">📌</span>
                              Saved Queries
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
                          <div className="saved-queries-pane-content">
                            {savedQueries.length === 0 ? (
                              <p className="muted">No saved queries. Save a query from a table pane.</p>
                            ) : (
                              <ul className="saved-queries-list">
                                {savedQueries.map((sq) => (
                                  <li key={sq.id} className="saved-query-item">
                                    <div className="saved-query-name">{sq.name}</div>
                                    <pre className="saved-query-sql">{sq.sql.length > 120 ? sq.sql.slice(0, 120) + '…' : sq.sql}</pre>
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
                        </div>
                      )
                    }
                    if (!isTableTab(tab)) return null
                    const tableInfo = tableInfos.find((t) => t.name === tab.tableName)
                    return (
                      <div
                        key={tab.id}
                        ref={(el) => {
                          paneRefs.current[tab.id] = el
                        }}
                        className={`pane-card ${draggingTabId === tab.id ? 'pane-dragging' : ''}`}
                        style={{
                          position: 'absolute',
                          left: tab.x,
                          top: tab.y,
                          width: tab.width,
                          height: tab.height,
                          zIndex: tab.zIndex,
                        }}
                      >
                        <div
                          className="pane-header pane-drag-handle"
                          onPointerDown={(e) => handlePanePointerDown(e, tab.id)}
                          title="Drag to move"
                        >
                        <span className="pane-drag-grip" aria-hidden>⋮⋮</span>
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
                              <div
                                className="pane-menu-dropdown"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => exportQueryResultsAsJson(tab.id)}
                                  disabled={!getTabResultData(tab) || getTabResultData(tab)!.values.length === 0}
                                >
                                  Export as JSON
                                </button>
                                <button
                                  type="button"
                                  onClick={() => exportQueryResultsAsCsv(tab.id)}
                                  disabled={!getTabResultData(tab) || getTabResultData(tab)!.values.length === 0}
                                >
                                  Export as CSV
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copyQueryResultsAsCsv(tab.id)}
                                  disabled={!getTabResultData(tab) || getTabResultData(tab)!.values.length === 0}
                                >
                                  Copy results to clipboard
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

                      {tableInfo && (
                        <div className="table-schema pane-section">
                          <button
                            type="button"
                            className="schema-toggle"
                            onClick={() => toggleSchemaCollapsed(tab.id)}
                            aria-expanded={!tab.schemaCollapsed}
                          >
                            <span className="schema-toggle-icon">
                              {tab.schemaCollapsed ? '▶' : '▼'}
                            </span>
                            <h4>Schema (CREATE)</h4>
                            <span className="schema-count">
                              {tableInfo.createStatement ? 'SQL' : '—'}
                            </span>
                          </button>
                          {!tab.schemaCollapsed && (
                            <div className="schema-create-block">
                              {tableInfo.createStatement ? (
                                <pre className="create-statement">{tableInfo.createStatement}</pre>
                              ) : (
                                <p className="muted">No schema info</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {tableInfo && (tableInfo.primaryKey.length > 0 || tableInfo.foreignKeys.length > 0) && (
                        <div className="keys-relations pane-section">
                          <button
                            type="button"
                            className="schema-toggle keys-toggle"
                            onClick={() => toggleKeysCollapsed(tab.id)}
                            aria-expanded={!tab.keysCollapsed}
                          >
                            <span className="schema-toggle-icon">
                              {tab.keysCollapsed ? '▶' : '▼'}
                            </span>
                            <h4>Keys &amp; Relations</h4>
                            <span className="schema-count">
                              {tableInfo.primaryKey.length > 0 && `${tableInfo.primaryKey.length} PK`}
                              {tableInfo.primaryKey.length > 0 && tableInfo.foreignKeys.length > 0 && ' · '}
                              {tableInfo.foreignKeys.length > 0 && `${tableInfo.foreignKeys.length} FK`}
                            </span>
                          </button>
                          {!tab.keysCollapsed && (
                            <div className="keys-content">
                              {tableInfo.primaryKey.length > 0 && (
                                <div className="keys-block">
                                  <span className="keys-label">Primary key</span>
                                  <div className="keys-list">
                                    {tableInfo.primaryKey.map((col, idx) => (
                                      <span key={idx} className="key-badge key-pk">
                                        {col}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {tableInfo.foreignKeys.length > 0 && (
                                <div className="keys-block">
                                  <span className="keys-label">Foreign keys</span>
                                  <ul className="fk-list">
                                    {tableInfo.foreignKeys.map((fk, idx) => (
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
                        </div>
                      )}

                      <div className="query-section pane-section">
                        <h4>SQL Query</h4>
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
                      </div>

                      {tab.error && <div className="error-banner">{tab.error}</div>}

                      <div className="results-section pane-section">
                        <h4>{tab.queryResult ? 'Query Results' : 'Table Data'}</h4>
                        {tab.queryResult ? (
                          <div className="table-wrapper">
                            <table>
                              <thead>
                                <tr>
                                  {tab.queryResult.columns.map((col: string) => (
                                    <th key={col}>{col}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {tab.queryResult.values.length === 0 ? (
                                  <tr>
                                    <td colSpan={tab.queryResult.columns.length} className="empty-cell">
                                      No rows returned
                                    </td>
                                  </tr>
                                ) : (
                                  tab.queryResult.values.map((row: unknown[], i: number) => (
                                    <tr key={i}>
                                      {row.map((cell: unknown, j: number) => (
                                        <td key={j}>{cell != null ? String(cell) : <em>null</em>}</td>
                                      ))}
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        ) : tab.tableData ? (
                          <div className="table-wrapper">
                            <table>
                              <thead>
                                <tr>
                                  {tab.tableData.columns.map((col: string) => (
                                    <th key={col}>{col}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {tab.tableData.values.length === 0 ? (
                                  <tr>
                                    <td colSpan={tab.tableData.columns.length} className="empty-cell">
                                      No rows found
                                    </td>
                                  </tr>
                                ) : (
                                  tab.tableData.values.map((row: unknown[], i: number) => (
                                    <tr key={i}>
                                      {row.map((cell: unknown, j: number) => (
                                        <td key={j}>{cell != null ? String(cell) : <em>null</em>}</td>
                                      ))}
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                            {tab.tableData.values.length >= DEFAULT_ROW_LIMIT && (
                              <p className="table-limit-note">First {DEFAULT_ROW_LIMIT} rows (descending). Use SQL for more.</p>
                            )}
                          </div>
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
