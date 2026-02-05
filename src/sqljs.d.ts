declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[]
    values: unknown[][]
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<{
    Database: new (data?: Uint8Array) => {
      exec(sql: string): QueryExecResult[]
      export(): Uint8Array
      close(): void
    }
  }>
  export type { Database, QueryExecResult }
}
