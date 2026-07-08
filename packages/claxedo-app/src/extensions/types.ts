/**
 * Claxedo extension surface (formerly @opencode-ai/app-shared).
 *
 * After Phase 4a-prep, claxedo owns its own extension types and a
 * single-tenant getExtensions() accessor. The plugin registry pattern
 * (multi-plugin map, globalThis dance, merge logic) is gone — only
 * claxedo registers, so the indirection had no consumer.
 */

export interface AppExtensions {
  strings?: Record<string, Record<string, string>>
}

export interface ServerExtensions {
  transformUrl?: (url: string) => string
  resolveSessionUrl?: (sessionId: string) => Promise<string | null>
}

export type Extensions = {
  app: AppExtensions
  server: ServerExtensions
}
