/**
 * Shared filter -> SQL builders.
 *
 * Imported by both the UI and dbWorker so the SQL that counts matches during a
 * global search is exactly the SQL that fetches the rows when a table is opened.
 */

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts'
  | 'ends'
  | 'like'
  | 'regex'
  | 'fuzzy'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'null'
  | 'notnull'

export type FilterCondition = {
  column: string
  op: FilterOp
  value: string
}

export type FilterOptions = {
  /** LIKE/= are ASCII case-insensitive by default; opt in to exact casing. */
  caseSensitive?: boolean
  /** Max Levenshtein distance for the `fuzzy` operator. */
  distance?: number
}

export type OpMeta = {
  value: FilterOp
  label: string
  /** Only offered once "Advanced" is switched on. */
  advanced: boolean
  /** Operator takes no value input. */
  noValue?: boolean
  hint?: string
}

export const FILTER_OPS: OpMeta[] = [
  { value: 'eq', label: 'equals', advanced: false },
  { value: 'contains', label: 'contains', advanced: false },
  { value: 'starts', label: 'starts with', advanced: false },
  { value: 'ends', label: 'ends with', advanced: false },
  { value: 'neq', label: 'not equals', advanced: true },
  { value: 'not_contains', label: 'does not contain', advanced: true },
  { value: 'like', label: 'LIKE pattern', advanced: true, hint: '% = any run, _ = any single char' },
  { value: 'regex', label: 'regex', advanced: true, hint: 'JavaScript regex, e.g. ^INV-\\d+$' },
  { value: 'fuzzy', label: 'fuzzy (edit distance)', advanced: true, hint: 'Levenshtein distance within the limit' },
  { value: 'in', label: 'in list', advanced: true, hint: 'Comma separated values' },
  { value: 'gt', label: '>', advanced: true },
  { value: 'gte', label: '>=', advanced: true },
  { value: 'lt', label: '<', advanced: true },
  { value: 'lte', label: '<=', advanced: true },
  { value: 'null', label: 'is null', advanced: true, noValue: true },
  { value: 'notnull', label: 'is not null', advanced: true, noValue: true },
]

export const OP_META: Record<FilterOp, OpMeta> = Object.fromEntries(
  FILTER_OPS.map((op) => [op.value, op])
) as Record<FilterOp, OpMeta>

export function opTakesValue(op: FilterOp): boolean {
  return !OP_META[op]?.noValue
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  return sqlString(String(value))
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

const NUMERIC_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

function isNumeric(value: string): boolean {
  return NUMERIC_RE.test(value.trim())
}

/** LIKE with a real ESCAPE clause so user input can contain % and _. */
function likeExpr(target: string, pattern: string): string {
  return `${target} LIKE ${sqlString(pattern)} ESCAPE '\\'`
}

/**
 * Builds one WHERE fragment. Returns null when the condition is incomplete
 * (empty value on an operator that needs one), so callers can skip it.
 */
export function buildConditionSql(
  cond: FilterCondition,
  opts: FilterOptions = {}
): string | null {
  if (!cond.column) return null
  const col = quoteIdent(cond.column)
  const text = `CAST(${col} AS TEXT)`
  const ci = !opts.caseSensitive
  const raw = cond.value

  if (cond.op === 'null') return `${col} IS NULL`
  if (cond.op === 'notnull') return `${col} IS NOT NULL`
  if (raw === '') return null

  const lit = sqlString(raw)

  switch (cond.op) {
    case 'eq':
      if (isNumeric(raw)) return `${col} = ${raw.trim()}`
      return ci ? `${text} = ${lit} COLLATE NOCASE` : `${text} = ${lit}`

    case 'neq': {
      const inner = isNumeric(raw)
        ? `${col} <> ${raw.trim()}`
        : ci
          ? `${text} <> ${lit} COLLATE NOCASE`
          : `${text} <> ${lit}`
      return `(${col} IS NULL OR ${inner})`
    }

    case 'contains':
      return ci
        ? likeExpr(text, `%${escapeLike(raw)}%`)
        : `INSTR(${text}, ${lit}) > 0`

    case 'not_contains': {
      const inner = ci
        ? likeExpr(text, `%${escapeLike(raw)}%`)
        : `INSTR(${text}, ${lit}) > 0`
      return `(${col} IS NULL OR NOT (${inner}))`
    }

    case 'starts':
      return ci
        ? likeExpr(text, `${escapeLike(raw)}%`)
        : `INSTR(${text}, ${lit}) = 1`

    case 'ends':
      return ci
        ? likeExpr(text, `%${escapeLike(raw)}`)
        : `SUBSTR(${text}, -LENGTH(${lit})) = ${lit}`

    case 'like':
      // LIKE is ASCII case-insensitive in SQLite; GLOB is the case-sensitive twin.
      if (ci) return `${text} LIKE ${lit}`
      return `${text} GLOB ${sqlString(
        raw
          .replace(/\[/g, '[[]')
          .replace(/\*/g, '[*]')
          .replace(/\?/g, '[?]')
          .replace(/%/g, '*')
          .replace(/_/g, '?')
      )}`

    case 'regex':
      return `${text} REGEXP ${sqlString(ci ? `(?i)${raw}` : raw)}`

    case 'fuzzy': {
      const distance = Math.max(0, Math.floor(opts.distance ?? 2))
      const target = ci ? `LOWER(${text})` : text
      const needle = ci ? sqlString(raw.toLowerCase()) : lit
      return `EDITDIST(${target}, ${needle}) <= ${distance}`
    }

    case 'in': {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (items.length === 0) return null
      const list = items.map((s) => (isNumeric(s) ? s : sqlString(s))).join(', ')
      return ci ? `${text} COLLATE NOCASE IN (${list})` : `${col} IN (${list})`
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const symbol = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[cond.op]
      return isNumeric(raw)
        ? `${col} ${symbol} ${raw.trim()}`
        : `${text} ${symbol} ${lit}`
    }

    default:
      return null
  }
}

export function buildWhereClause(
  conds: FilterCondition[],
  join: 'AND' | 'OR',
  opts: FilterOptions = {}
): string | null {
  const parts = conds
    .map((c) => buildConditionSql(c, opts))
    .filter((s): s is string => s != null)
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  return parts.map((p) => `(${p})`).join(join === 'OR' ? ' OR ' : ' AND ')
}

export type GlobalSearchMode = 'contains' | 'exact' | 'regex' | 'fuzzy'

const GLOBAL_MODE_OP: Record<GlobalSearchMode, FilterOp> = {
  contains: 'contains',
  exact: 'eq',
  regex: 'regex',
  fuzzy: 'fuzzy',
}

/** OR of one condition per column — "does this value appear anywhere in the table". */
export function buildGlobalWhere(
  columns: string[],
  value: string,
  mode: GlobalSearchMode,
  opts: FilterOptions = {}
): string | null {
  const op = GLOBAL_MODE_OP[mode] ?? 'contains'
  const conds = columns.map((column) => ({ column, op, value }))
  return buildWhereClause(conds, 'OR', opts)
}

/** Equality criteria from a pasted JSON object, matched against real columns. */
export function buildJsonCriteriaWhere(
  columns: string[],
  criteria: Record<string, unknown>
): string | null {
  const parts: string[] = []
  for (const [key, value] of Object.entries(criteria)) {
    const col = columns.find((c) => c.toLowerCase() === key.toLowerCase())
    if (!col) return null
    parts.push(`${quoteIdent(col)} = ${sqlLiteral(value)}`)
  }
  if (parts.length === 0) return null
  return parts.join(' AND ')
}

export function buildSelect(
  table: string,
  where: string | null,
  limit: number,
  hasRowid = true
): string {
  const order = hasRowid ? ' ORDER BY rowid DESC' : ''
  const clause = where ? ` WHERE ${where}` : ''
  return `SELECT * FROM ${quoteIdent(table)}${clause}${order} LIMIT ${Math.max(1, Math.floor(limit))};`
}

export function buildCount(table: string, where: string | null): string {
  const clause = where ? ` WHERE ${where}` : ''
  return `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}${clause};`
}
