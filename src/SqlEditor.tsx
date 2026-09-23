/**
 * A SQL textarea that keeps its own undo/redo history.
 *
 * The browser's native history is not usable here: the value is React-controlled
 * and gets rewritten from the outside — applying a filter, loading a saved
 * query, clicking a table chip — and every one of those programmatic writes
 * clears the native undo stack. So we keep the stack ourselves, which also
 * makes those outside edits undoable, which the native one never managed.
 *
 * Typing inside a short window collapses into a single step, the way a real
 * editor behaves; caret and selection are restored along with the text.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** Keystrokes closer together than this collapse into one undo step. */
const COALESCE_MS = 450
const MAX_STEPS = 200

type Snapshot = { value: string; selStart: number; selEnd: number }

type Props = {
  value: string
  onChange: (next: string) => void
  /** Cmd/Ctrl+Enter. */
  onRun?: () => void
  className?: string
  placeholder?: string
  rows?: number
  label?: string
}

export default function SqlEditor({
  value,
  onChange,
  onRun,
  className = '',
  placeholder,
  rows,
  label,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const stack = useRef<Snapshot[]>([
    { value, selStart: value.length, selEnd: value.length },
  ])
  const at = useRef(0)
  const lastTypedAt = useRef(0)
  const typing = useRef(false)
  /** Set while we are the ones writing the value, so we don't record our own undo. */
  const replaying = useRef(false)
  const latest = useRef(value)
  const [[canUndo, canRedo], setCan] = useState<[boolean, boolean]>([false, false])

  const syncCan = useCallback(() => {
    setCan([at.current > 0, at.current < stack.current.length - 1])
  }, [])

  // Every value change lands here, whoever caused it.
  useEffect(() => {
    latest.current = value
    if (replaying.current) {
      replaying.current = false
      syncCan()
      return
    }
    if (stack.current[at.current]?.value === value) return

    const el = ref.current
    const snap: Snapshot = {
      value,
      selStart: el?.selectionStart ?? value.length,
      selEnd: el?.selectionEnd ?? value.length,
    }
    const now = Date.now()
    const wasTyping = typing.current
    typing.current = false

    // Editing after an undo discards whatever we had rolled forward to.
    if (at.current < stack.current.length - 1) {
      stack.current = stack.current.slice(0, at.current + 1)
    }

    const burst = wasTyping && at.current > 0 && now - lastTypedAt.current < COALESCE_MS
    if (burst) {
      stack.current[at.current] = snap
    } else {
      stack.current.push(snap)
      if (stack.current.length > MAX_STEPS) stack.current.shift()
      at.current = stack.current.length - 1
    }
    lastTypedAt.current = wasTyping ? now : 0
    syncCan()
  }, [value, syncCan])

  const restore = useCallback(
    (snap: Snapshot) => {
      lastTypedAt.current = 0
      typing.current = false
      if (snap.value !== latest.current) {
        replaying.current = true
        onChange(snap.value)
      } else {
        syncCan()
      }
      // The caret can only be placed once React has written the new text.
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        try {
          el.setSelectionRange(snap.selStart, snap.selEnd)
        } catch {
          /* out-of-range after an external edit — harmless */
        }
      })
    },
    [onChange, syncCan]
  )

  const undo = useCallback(() => {
    if (at.current <= 0) return
    at.current -= 1
    restore(stack.current[at.current])
  }, [restore])

  const redo = useCallback(() => {
    if (at.current >= stack.current.length - 1) return
    at.current += 1
    restore(stack.current[at.current])
  }, [restore])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 'enter' && onRun) {
      e.preventDefault()
      onRun()
      return
    }
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
      return
    }
    if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault()
      redo()
    }
  }

  // Undo reached through the context menu or the Edit menu arrives as a
  // beforeinput, never as a keydown.
  function handleBeforeInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const type = (e.nativeEvent as InputEvent).inputType
    if (type === 'historyUndo') {
      e.preventDefault()
      undo()
    } else if (type === 'historyRedo') {
      e.preventDefault()
      redo()
    }
  }

  return (
    <div className="sql-editor">
      <textarea
        ref={ref}
        className={`sql-editor-area ${className}`}
        value={value}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          typing.current = true
          onChange(e.target.value)
        }}
        onKeyDown={handleKeyDown}
        onBeforeInput={handleBeforeInput}
      />
      <div className="sql-editor-history">
        <button
          type="button"
          className="sql-editor-history-btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (⌘/Ctrl+Z)"
          aria-label="Undo"
          tabIndex={-1}
        >
          ↶
        </button>
        <button
          type="button"
          className="sql-editor-history-btn"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (⌘/Ctrl+Shift+Z)"
          aria-label="Redo"
          tabIndex={-1}
        >
          ↷
        </button>
      </div>
    </div>
  )
}
