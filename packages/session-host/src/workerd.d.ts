/**
 * The workerd surface this package constructs, modelled structurally as
 * `@claxedo/workspace-relay` models its own: `@cloudflare/workers-types`
 * redeclares `Request`, `Response` and `WebSocket` for the whole program,
 * which breaks the sibling sources this package typechecks against.
 */
declare global {
  type DurableObjectState = {
    id: { name?: string }
    storage: {
      sql: { exec<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): Row[] } }
      transactionSync<T>(run: () => T): T
      deleteAll(): Promise<void>
      deleteAlarm(): Promise<void>
    }
    abort(reason?: string): void
  }
  interface WebSocket {
    accept(): void
  }
  interface Response {
    readonly webSocket?: WebSocket | null
  }
}

export {}
