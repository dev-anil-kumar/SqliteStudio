/**
 * The schema as a map: tables as boxes, foreign keys as links.
 *
 * Follows the md-reader canvas playbook — the drawing lives in an SVG viewBox
 * that pan and zoom write to directly, the dot grid belongs to the drawing so
 * it travels with the boxes, and every gesture is coalesced onto animation
 * frames. Dragging a table moves that one group and redraws only the links
 * touching it, so a big schema stays smooth under the pointer; React is told
 * about the new position once, when the pointer comes up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TableInfo } from './dbBridge'
import {
  BODY_PAD,
  HEADER_H,
  ROW_H,
  clamp,
  countDeclaredLinks,
  edgeHighlight,
  edgePath,
  layoutSchema,
  nodeHighlight,
  relatednessFrom,
  withInferredLinks,
  type Bounds,
  type Density,
  type GraphEdge,
  type GraphTable,
  type Rect,
} from './schemaGraph'
import './GraphView.css'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 3
const DOTS = 26
const CHAR_W = 6.35 // upper bound on one character of the 11px mono stack
const TYPE_SHARE = 0.38

type Offset = { dx: number; dy: number }

type Props = {
  tables: TableInfo[]
  onBack: () => void
  onOpenTable: (name: string) => void
  title?: string
}

const cut = (text: string, max: number) =>
  text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text

/**
 * How much of the column name and how much of its type fit side by side.
 *
 * The row is monospace, so a string's width is its length times a fixed
 * advance and no measuring is needed. When both fit, both are drawn whole —
 * a fixed split would shorten "→ categories" with half the row still empty.
 * Otherwise the type takes a share, the name takes what is left, and any
 * slack the name did not need goes back to the type.
 */
function fitRow(name: string, type: string, width: number): { name: number; type: number } {
  const room = Math.floor((width - 24 - 12) / CHAR_W) - 1
  if (name.length + type.length <= room) return { name: name.length, type: type.length }
  const share = Math.max(6, Math.floor(room * TYPE_SHARE))
  const forType = Math.min(type.length, share)
  const forName = Math.max(8, Math.min(name.length, room - forType))
  return { name: forName, type: Math.max(5, Math.min(type.length, room - forName)) }
}

function toGraphTables(tables: TableInfo[]): GraphTable[] {
  return tables.map((t) => ({
    name: t.name,
    columnDetails: t.columnDetails,
    primaryKey: t.primaryKey,
    foreignKeys: t.foreignKeys,
    rowCount: t.rowCount,
  }))
}

/** True when at least one foreign key actually lands on a table we have. */
function hasResolvableLink(tables: GraphTable[]): boolean {
  const names = new Set(tables.map((t) => t.name.toLowerCase()))
  return tables.some((t) => t.foreignKeys.some((fk) => names.has(fk.toTable.toLowerCase())))
}

const DEPTHS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: '1', hint: 'Direct relations only' },
  { value: 2, label: '2', hint: 'Direct relations and one step beyond' },
  { value: 3, label: '3', hint: 'Up to three hops away' },
  { value: Infinity, label: 'All', hint: 'Everything reachable through foreign keys' },
]

const DENSITIES: { value: Density; label: string; hint: string }[] = [
  { value: 'compact', label: 'Compact', hint: 'Table names only' },
  { value: 'keys', label: 'Keys', hint: 'Primary and foreign key columns' },
  { value: 'all', label: 'All', hint: 'Every column' },
]

export default function GraphView({ tables, onBack, onOpenTable, title }: Props) {
  const [density, setDensity] = useState<Density>('keys')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [showIsolated, setShowIsolated] = useState(false)
  const [guess, setGuess] = useState(() => {
    const base = toGraphTables(tables)
    return countDeclaredLinks(base) === 0 && base.length > 1
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [depth, setDepth] = useState(2)
  const [query, setQuery] = useState('')
  const [offsets, setOffsets] = useState<Record<string, Offset>>({})
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)

  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const groundRef = useRef<SVGRectElement>(null)
  const zoomLabelRef = useRef<HTMLSpanElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const edgeEls = useRef(new Map<string, SVGPathElement>())
  const view = useRef({ x: 0, y: 0, zoom: 1 })
  const liveOffsets = useRef<Record<string, Offset>>({})
  const frame = useRef(0)

  const baseTables = useMemo<GraphTable[]>(() => toGraphTables(tables), [tables])

  const declaredLinks = useMemo(() => countDeclaredLinks(baseTables), [baseTables])

  const graphTables = useMemo(
    () => (guess ? withInferredLinks(baseTables) : baseTables),
    [guess, baseTables]
  )

  // With nothing joined to anything, the connected graph is empty — so the
  // unconnected tables are the whole picture and hiding them shows nothing.
  const anyLinks = useMemo(() => hasResolvableLink(graphTables), [graphTables])
  const includeIsolated = showIsolated || !anyLinks

  const layout = useMemo(
    () => layoutSchema(graphTables, { density, expanded, includeIsolated }),
    [graphTables, density, expanded, includeIsolated]
  )

  const nodeMap = useMemo(
    () => new Map(layout.nodes.map((n) => [n.name, n])),
    [layout.nodes]
  )

  const incident = useMemo(() => {
    const map = new Map<string, GraphEdge[]>()
    const add = (name: string, edge: GraphEdge) => {
      const list = map.get(name)
      if (list) list.push(edge)
      else map.set(name, [edge])
    }
    layout.edges.forEach((edge) => {
      add(edge.from, edge)
      if (edge.to !== edge.from) add(edge.to, edge)
    })
    return map
  }, [layout.edges])

  const boundsRef = useRef<Bounds>(layout.bounds)
  useEffect(() => {
    boundsRef.current = layout.bounds
  }, [layout.bounds])

  useEffect(() => {
    liveOffsets.current = offsets
  }, [offsets])

  /* ---------- view: pan, zoom, fit ---------- */

  const writeZoom = useCallback(() => {
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(view.current.zoom * 100)}%`
    }
  }, [])

  const applyView = useCallback(() => {
    const svg = svgRef.current
    const host = hostRef.current
    if (!svg || !host) return
    const r = host.getBoundingClientRect()
    const v = view.current
    const w = (r.width || 900) / v.zoom
    const h = (r.height || 600) / v.zoom
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${w} ${h}`)
    const ground = groundRef.current
    if (ground) {
      // Cover well beyond the viewport so a fast drag never outruns the grid.
      ground.setAttribute('x', String(v.x - w))
      ground.setAttribute('y', String(v.y - h))
      ground.setAttribute('width', String(w * 3))
      ground.setAttribute('height', String(h * 3))
    }
  }, [])

  const toScene = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current
    const r = host?.getBoundingClientRect()
    const v = view.current
    return {
      x: v.x + (clientX - (r?.left ?? 0)) / v.zoom,
      y: v.y + (clientY - (r?.top ?? 0)) / v.zoom,
    }
  }, [])

  const zoomBy = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      const at = anchor ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      const before = toScene(at.x, at.y)
      view.current.zoom = clamp(view.current.zoom * factor, ZOOM_MIN, ZOOM_MAX)
      const after = toScene(at.x, at.y)
      // Hold the point under the cursor still while the scale changes.
      view.current.x += before.x - after.x
      view.current.y += before.y - after.y
      applyView()
      writeZoom()
    },
    [applyView, toScene, writeZoom]
  )

  const fitTo = useCallback(
    (b: Bounds) => {
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      const w = r.width || 900
      const h = r.height || 600
      const zoom = clamp(Math.min(w / b.w, h / b.h), ZOOM_MIN, ZOOM_MAX)
      view.current = {
        zoom,
        x: b.x + b.w / 2 - w / (2 * zoom),
        y: b.y + b.h / 2 - h / (2 * zoom),
      }
      applyView()
      writeZoom()
    },
    [applyView, writeZoom]
  )

  const fit = useCallback(() => fitTo(boundsRef.current), [fitTo])

  const centreOn = useCallback(
    (name: string) => {
      const node = nodeMap.get(name)
      const host = hostRef.current
      if (!node || !host) return
      const off = liveOffsets.current[name]
      const r = host.getBoundingClientRect()
      const v = view.current
      v.x = node.x + (off?.dx ?? 0) + node.width / 2 - (r.width || 900) / (2 * v.zoom)
      v.y = node.y + (off?.dy ?? 0) + node.height / 2 - (r.height || 600) / (2 * v.zoom)
      applyView()
    },
    [applyView, nodeMap]
  )

  // Frame the whole schema when a different database arrives, not on every
  // density change — refitting under someone who is reading a corner is rude.
  useEffect(() => {
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [baseTables, fit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => applyView())
    ro.observe(host)
    return () => ro.disconnect()
  }, [applyView])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // Trackpad pinch arrives as ctrl+wheel; plain wheel scrolls the canvas.
      if (e.ctrlKey || e.metaKey) {
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX, y: e.clientY })
        return
      }
      view.current.x += e.deltaX / view.current.zoom
      view.current.y += e.deltaY / view.current.zoom
      applyView()
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [applyView, zoomBy])

  /* ---------- geometry that drags keep up to date ---------- */

  const rectOf = useCallback(
    (name: string, from: Record<string, Offset>): Rect | null => {
      const node = nodeMap.get(name)
      if (!node) return null
      const off = from[name]
      return {
        x: node.x + (off?.dx ?? 0),
        y: node.y + (off?.dy ?? 0),
        width: node.width,
        height: node.height,
      }
    },
    [nodeMap]
  )

  /**
   * Rendering reads committed state; a drag in progress reads the live map it
   * is mutating. Keeping the source an argument is what lets both share one
   * piece of geometry without either reaching for the other's copy.
   */
  const pathFor = useCallback(
    (edge: GraphEdge, from: Record<string, Offset>): string => {
      const a = rectOf(edge.from, from)
      const b = rectOf(edge.to, from)
      if (!a || !b) return ''
      return edgePath(a, b, edge.self)
    },
    [rectOf]
  )

  const schedule = useCallback((run: () => void) => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      run()
    })
  }, [])

  /* ---------- dragging a table ---------- */

  function startNodeDrag(e: React.PointerEvent, name: string) {
    if (e.button !== 0) return
    e.stopPropagation()
    const target = e.currentTarget as Element
    const node = nodeMap.get(name)
    if (!node) return

    const origin = toScene(e.clientX, e.clientY)
    const base = liveOffsets.current[name] ?? { dx: 0, dy: 0 }
    const edges = incident.get(name) ?? []
    const el = nodeEls.current.get(name)
    let moved = false
    let pending: Offset | null = null

    svgRef.current?.classList.add('dragging')
    try {
      target.setPointerCapture(e.pointerId)
    } catch {
      /* not fatal */
    }

    const onMove = (ev: PointerEvent) => {
      const at = toScene(ev.clientX, ev.clientY)
      if (Math.abs(at.x - origin.x) > 2 || Math.abs(at.y - origin.y) > 2) moved = true
      pending = { dx: base.dx + (at.x - origin.x), dy: base.dy + (at.y - origin.y) }
      schedule(() => {
        if (!pending) return
        liveOffsets.current = { ...liveOffsets.current, [name]: pending }
        el?.setAttribute('transform', `translate(${node.x + pending.dx} ${node.y + pending.dy})`)
        edges.forEach((edge) =>
          edgeEls.current.get(edge.id)?.setAttribute('d', pathFor(edge, liveOffsets.current))
        )
      })
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (frame.current) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
      svgRef.current?.classList.remove('dragging')
      try {
        target.releasePointerCapture(ev.pointerId)
      } catch {
        /* already gone */
      }
      if (moved) setOffsets({ ...liveOffsets.current })
      else setSelected((prev) => (prev === name ? null : name))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /* ---------- panning the background ---------- */

  function startPan(e: React.PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as Element
    if (target.closest?.('.sg-node')) return
    const host = hostRef.current
    if (!host) return

    const startX = e.clientX
    const startY = e.clientY
    const from = { x: view.current.x, y: view.current.y }
    let moved = false
    let pending: { x: number; y: number } | null = null
    host.classList.add('panning')

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 2 || Math.abs(ev.clientY - startY) > 2) moved = true
      pending = {
        x: from.x - (ev.clientX - startX) / view.current.zoom,
        y: from.y - (ev.clientY - startY) / view.current.zoom,
      }
      schedule(() => {
        if (!pending) return
        view.current.x = pending.x
        view.current.y = pending.y
        applyView()
      })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (frame.current) {
        cancelAnimationFrame(frame.current)
        frame.current = 0
      }
      host.classList.remove('panning')
      if (!moved) setSelected(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /* ---------- search, selection, keys ---------- */

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const hit = new Set<string>()
    graphTables.forEach((t) => {
      if (
        t.name.toLowerCase().includes(q) ||
        t.columnDetails.some((c) => c.name.toLowerCase().includes(q))
      ) {
        hit.add(t.name)
      }
    })
    return hit
  }, [query, graphTables])

  // How far every other table sits from the selected one, so direct and
  // indirect relations can be told apart instead of collapsed into "related".
  const relation = useMemo(
    () => (selected ? relatednessFrom(layout.edges, selected, depth) : null),
    [selected, layout.edges, depth]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if (e.key === 'Escape') {
        if (typing) (e.target as HTMLElement).blur()
        else setSelected(null)
        return
      }
      if (typing) return
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBy(1.2)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomBy(1 / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        fit()
      } else if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fit, zoomBy])

  useEffect(() => {
    if (!optionsOpen) return
    const close = () => setOptionsOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [optionsOpen])

  function toggleExpanded(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function submitSearch() {
    const first = layout.nodes.find((n) => matches?.has(n.name))
    if (first) {
      setSelected(first.name)
      centreOn(first.name)
    }
  }

  /* ---------- render ---------- */

  const highlight = { selected, relation, matches }

  const linkCount = layout.edges.length
  const guessedCount = layout.edges.filter((e) => e.inferred).length
  const shownCount = layout.nodes.length
  const emptyCanvas = shownCount === 0

  return (
    <div className="sg-root">
      <div className="sg-toolbar">
        <button type="button" className="sg-back" onClick={onBack}>
          ← Tables
        </button>
        <div className="sg-title">
          <strong>Schema graph</strong>
          <span className="sg-meta">
            {title ? `${title} · ` : ''}
            {shownCount} table{shownCount !== 1 ? 's' : ''} · {linkCount} link
            {linkCount !== 1 ? 's' : ''}
            {guessedCount > 0 ? ` (${guessedCount} guessed)` : ''}
          </span>
        </div>

        <input
          ref={searchRef}
          type="search"
          className="sg-search"
          placeholder="Find a table or column…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
          aria-label="Find a table or column"
        />

        <div className="sg-segment" role="group" aria-label="Detail level">
          {DENSITIES.map((d) => (
            <button
              key={d.value}
              type="button"
              className={density === d.value ? 'active' : ''}
              onClick={() => setDensity(d.value)}
              title={d.hint}
              aria-pressed={density === d.value}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="sg-zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </button>
          <span ref={zoomLabelRef} className="sg-zoom-label">
            100%
          </span>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </button>
        </div>
        <button type="button" className="sg-btn" onClick={fit} title="Fit to view (0)">
          Fit
        </button>

        <div className="sg-options-wrap">
          <button
            type="button"
            className="sg-btn"
            onClick={(e) => {
              e.stopPropagation()
              setOptionsOpen((v) => !v)
            }}
            aria-expanded={optionsOpen}
            aria-label="More options"
          >
            ⋯
          </button>
          {optionsOpen && (
            <div className="sg-options" onClick={(e) => e.stopPropagation()}>
              <label className="sg-opt">
                <input
                  type="checkbox"
                  checked={guess}
                  onChange={(e) => setGuess(e.target.checked)}
                />
                Guess links from column names
              </label>
              <p className="sg-opt-hint">
                {declaredLinks > 0
                  ? `${declaredLinks} link${declaredLinks !== 1 ? 's' : ''} declared by the schema.`
                  : 'This schema declares no foreign keys.'}
              </p>
              <label className="sg-opt">
                <input
                  type="checkbox"
                  checked={includeIsolated}
                  disabled={!anyLinks}
                  onChange={(e) => setShowIsolated(e.target.checked)}
                />
                Show unconnected tables ({layout.isolatedCount})
              </label>
              <label className="sg-opt">
                <input
                  type="checkbox"
                  checked={legendOpen}
                  onChange={(e) => setLegendOpen(e.target.checked)}
                />
                Show legend
              </label>
              <button
                type="button"
                className="sg-opt-action"
                onClick={() => {
                  setOffsets({})
                  liveOffsets.current = {}
                  setExpanded(new Set())
                  requestAnimationFrame(fit)
                }}
              >
                Reset layout
              </button>
            </div>
          )}
        </div>
      </div>

      {selected && relation && (
        <div className="sg-selection">
          <span className="sg-selection-name">{selected}</span>

          <span className="sg-selection-rel">
            <span className="sg-rel out" title={relation.references.join(', ') || 'None'}>
              references {relation.references.length}
            </span>
            <span className="sg-rel in" title={relation.referencedBy.join(', ') || 'None'}>
              referenced by {relation.referencedBy.length}
            </span>
            <span
              className="sg-rel far"
              title={
                relation.indirect.length
                  ? relation.indirect.join(', ')
                  : 'No further tables within this depth'
              }
            >
              indirect {relation.indirect.length}
            </span>
          </span>

          <span className="sg-depth" role="group" aria-label="Relation depth">
            <span className="sg-depth-label">depth</span>
            {DEPTHS.map((d) => (
              <button
                key={d.label}
                type="button"
                className={depth === d.value ? 'active' : ''}
                onClick={() => setDepth(d.value)}
                title={d.hint}
                aria-pressed={depth === d.value}
              >
                {d.label}
              </button>
            ))}
          </span>

          <button type="button" onClick={() => onOpenTable(selected)}>
            Open table ↗
          </button>
          <button type="button" onClick={() => setSelected(null)} aria-label="Clear selection">
            ✕
          </button>
        </div>
      )}

      <div className="sg-host" ref={hostRef} onPointerDown={startPan}>
        <svg
          ref={svgRef}
          className={`sg-svg${selected ? ' focused' : ''}${matches ? ' searching' : ''}`}
          role="img"
          aria-label="A map of the database schema"
        >
          <defs>
            <pattern id="sg-dots" width={DOTS} height={DOTS} patternUnits="userSpaceOnUse">
              <circle className="sg-dot-mark" cx={1} cy={1} r={1} />
            </pattern>
            <marker
              id="sg-arrow"
              viewBox="0 0 10 10"
              refX={9.5}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto"
            >
              <path className="sg-arrow-head" d="M0 1 L10 5 L0 9 z" />
            </marker>
            <marker
              id="sg-arrow-lit"
              viewBox="0 0 10 10"
              refX={9.5}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto"
            >
              <path className="sg-arrow-head lit" d="M0 1 L10 5 L0 9 z" />
            </marker>
          </defs>

          <rect ref={groundRef} className="sg-ground" fill="url(#sg-dots)" />

          <g className="sg-edges">
            {layout.edges.map((edge) => {
              const state = edgeHighlight(edge, highlight)
              const direct = state.includes('lit')
              return (
                <path
                  key={edge.id}
                  ref={(el) => {
                    if (el) edgeEls.current.set(edge.id, el)
                    else edgeEls.current.delete(edge.id)
                  }}
                  className={`sg-edge${edge.inferred ? ' guessed' : ''}${state ? ' ' + state : ''}`}
                  d={pathFor(edge, offsets)}
                  markerEnd={`url(#${direct ? 'sg-arrow-lit' : 'sg-arrow'})`}
                >
                  <title>
                    {edge.pairs
                      .map((p) => `${edge.from}.${p.from} → ${edge.to}.${p.to}`)
                      .join('\n') + (edge.inferred ? '\n(guessed from column names)' : '')}
                  </title>
                </path>
              )
            })}
          </g>

          <g className="sg-nodes">
            {layout.nodes.map((node) => {
              const off = offsets[node.name]
              const x = node.x + (off?.dx ?? 0)
              const y = node.y + (off?.dy ?? 0)
              const hops = relation?.hops.get(node.name)
              const state = nodeHighlight(node.name, highlight)
              const canExpand = node.hidden > 0 || expanded.has(node.name)

              return (
                <g
                  key={node.name}
                  ref={(el) => {
                    if (el) nodeEls.current.set(node.name, el)
                    else nodeEls.current.delete(node.name)
                  }}
                  className={
                    `sg-node${state ? ' ' + state : ''}${node.isolated ? ' lone' : ''}`
                  }
                  transform={`translate(${x} ${y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.name}, ${node.rowCount} rows, ${node.columnCount} columns`}
                  onPointerDown={(e) => startNodeDrag(e, node.name)}
                  onDoubleClick={() => onOpenTable(node.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenTable(node.name)
                    if (e.key === ' ') {
                      e.preventDefault()
                      setSelected((p) => (p === node.name ? null : node.name))
                    }
                  }}
                >
                  <title>
                    {`${node.name} — ${node.rowCount.toLocaleString()} rows, ` +
                      `${node.columnCount} columns` +
                      (hops === 1
                        ? `\nDirectly related to ${selected}`
                        : hops !== undefined && hops > 1
                          ? `\n${hops} hops from ${selected}`
                          : '') +
                      '\nDouble-click to open the table'}
                  </title>

                  <rect
                    className="sg-box"
                    width={node.width}
                    height={node.height}
                    rx={10}
                  />
                  <rect className="sg-cap" width={node.width} height={HEADER_H} rx={10} />
                  {node.height > HEADER_H && (
                    <line className="sg-rule" x1={0} y1={HEADER_H} x2={node.width} y2={HEADER_H} />
                  )}

                  <text className="sg-name" x={12} y={18}>
                    {cut(node.name, canExpand ? 26 : 30)}
                  </text>
                  <text className="sg-sub" x={12} y={31}>
                    {node.rowCount.toLocaleString()} rows · {node.columnCount} cols
                  </text>

                  {canExpand && (
                    <g
                      className="sg-twist"
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleExpanded(node.name)
                      }}
                      role="button"
                      aria-label={expanded.has(node.name) ? 'Collapse columns' : 'Expand columns'}
                    >
                      <circle cx={node.width - 18} cy={HEADER_H / 2} r={9} />
                      <text x={node.width - 18} y={HEADER_H / 2 + 4} textAnchor="middle">
                        {expanded.has(node.name) ? '−' : '+'}
                      </text>
                    </g>
                  )}

                  {node.rows.map((row, i) => {
                    const ry = HEADER_H + BODY_PAD / 2 + i * ROW_H + 14
                    // A foreign key says where it points; anything else says its type.
                    const trailing = row.ref ? `→ ${row.ref}` : row.type || ''
                    const fits = fitRow(row.name, trailing, node.width)
                    return (
                      <g
                        key={row.name}
                        className={
                          'sg-row' +
                          (row.pk ? ' pk' : '') +
                          (row.fk ? ' fk' : '') +
                          (row.inferred ? ' guessed' : '')
                        }
                      >
                        <circle className="sg-bullet" cx={14} cy={ry - 4} r={3.2} />
                        <text className="sg-col" x={24} y={ry}>
                          {cut(row.name, fits.name)}
                        </text>
                        <text
                          className="sg-type"
                          x={node.width - 12}
                          y={ry}
                          textAnchor="end"
                        >
                          {cut(trailing, fits.type)}
                        </text>
                      </g>
                    )
                  })}

                  {node.hidden > 0 && (
                    <text
                      className="sg-more"
                      x={24}
                      y={HEADER_H + BODY_PAD / 2 + node.rows.length * ROW_H + 14}
                    >
                      +{node.hidden} more
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        {emptyCanvas && (
          <div className="sg-empty">
            <div className="sg-empty-box">
              <h2>Nothing to draw</h2>
              <p>
                {tables.length === 0
                  ? 'This database has no tables.'
                  : 'No relationships were found between these tables.'}
              </p>
              {layout.isolatedCount > 0 && (
                <button type="button" onClick={() => setShowIsolated(true)}>
                  Show all {layout.isolatedCount} tables
                </button>
              )}
            </div>
          </div>
        )}

        {legendOpen && (
          <div className="sg-legend">
            <button
              type="button"
              className="sg-legend-close"
              onClick={() => setLegendOpen(false)}
              aria-label="Hide legend"
            >
              ✕
            </button>
            <ul>
              <li>
                <span className="sg-key pk" /> primary key
              </li>
              <li>
                <span className="sg-key fk" /> foreign key
              </li>
              <li>
                <span className="sg-key box direct" /> direct relation
              </li>
              <li>
                <span className="sg-key box indirect" /> indirect relation
              </li>
              <li>
                <span className="sg-key line" /> declared link
              </li>
              <li>
                <span className="sg-key line guessed" /> guessed link
              </li>
            </ul>
            <p>
              Drag a table to move it · double-click to open it · ⌘/Ctrl + scroll to zoom ·
              <kbd>0</kbd> to fit
            </p>
          </div>
        )}

        {!legendOpen && (
          <button
            type="button"
            className="sg-help"
            onClick={() => setLegendOpen(true)}
            aria-label="Show legend"
            title="Legend and shortcuts"
          >
            ?
          </button>
        )}
      </div>
    </div>
  )
}
