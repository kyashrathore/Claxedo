/**
 * Claxedo's extension surface: a single-tenant getExtensions() accessor, not a
 * plugin registry (multi-plugin map, globalThis dance, merge logic) — only
 * claxedo registers, so that indirection would have no consumer.
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

export type ExtensionConfig = {
  cloudAutoSwitch?: boolean
  claxedoServerUrl?: string
  gatewayUrl?: string
}
