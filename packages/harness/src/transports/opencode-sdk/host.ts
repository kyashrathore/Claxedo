import type * as OpenCodeSdk from "@opencode-ai/sdk"
import { isAbsolute } from "node:path"
import {
  canTransition,
  isTerminal,
  type OpenCodeEventHealth,
  type OpenCodeLifecycle,
  type OpenCodeStatus,
} from "./lifecycle"

export type OpenCodeClient = Awaited<ReturnType<typeof OpenCodeSdk.OpenCode.create>>

export type OpenCodeHostOptions = Readonly<{
  
  databasePath: string
  
  configContent?: string
  
  persistEvents?: boolean
  plugins?: OpenCodeSdk.OpenCode.CreateOptions["plugins"]
}>

export class OpenCodeUnavailableError extends Error {
  readonly code = "opencode_unavailable"
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`OpenCode is unavailable: ${reason}`)
    this.name = "OpenCodeUnavailableError"
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

export type OpenCodeHost = Readonly<{
  /** Resolve the shared client, booting it if this is first use. */
  client(): Promise<OpenCodeClient>
  status(): OpenCodeStatus
  /** Report event-stream health without disturbing lifecycle. */
  setEventHealth(health: OpenCodeEventHealth): void
  /** Drain and close exactly once. Repeated calls are safe. */
  close(): Promise<void>
}>

export async function openCodeLocationClient(host: OpenCodeHost, directory: string): Promise<OpenCodeClient> {
  const client = await host.client()
  await client.plugin.awaitActivation({ location: { directory } })
  return client
}

export function createOpenCodeHost(options: OpenCodeHostOptions): OpenCodeHost {
  if (!isAbsolute(options.databasePath)) {
    throw new Error(`OpenCode databasePath must be absolute, received ${options.databasePath}`)
  }

  let lifecycle: OpenCodeLifecycle = "cold"
  let events: OpenCodeEventHealth = "healthy"
  let reason: string | undefined
  let booting: Promise<OpenCodeClient> | undefined
  let client: OpenCodeClient | undefined
  let closing: Promise<void> | undefined

  function moveTo(next: OpenCodeLifecycle, why?: string) {
    if (!canTransition(lifecycle, next)) {
      throw new Error(`Illegal OpenCode lifecycle transition ${lifecycle} -> ${next}`)
    }
    lifecycle = next
    reason = why
  }

  async function boot(): Promise<OpenCodeClient> {
    moveTo("migrating")
    try {
      const { OpenCode } = await import("@opencode-ai/sdk")
      const created = await OpenCode.create({
        plugins: options.plugins,
        database: { path: options.databasePath },
        events: { persist: options.persistEvents ?? true },
        fs: { fff: false },
        ...(options.configContent ? { config: { content: options.configContent } } : {}),
      })
      client = created
      moveTo("ready")
      return created
    } catch (cause) {
      booting = undefined
      lifecycle = "unavailable"
      reason = cause instanceof Error ? cause.message : String(cause)
      throw new OpenCodeUnavailableError(reason, { cause })
    }
  }

  return {
    client() {
      if (closing || isTerminal(lifecycle)) {
        return Promise.reject(new OpenCodeUnavailableError("the runtime owner is closed; construct a fresh one"))
      }
      if (client) return Promise.resolve(client)
      if (lifecycle === "unavailable") moveTo("cold")
      booting ??= boot()
      return booting
    },
    status() {
      return reason === undefined ? { lifecycle, events } : { lifecycle, events, reason }
    },
    setEventHealth(next) {
      events = next
    },
    close() {
      closing ??= (async () => {
        if (isTerminal(lifecycle)) return
        if (booting) await booting.catch(() => undefined)
        if (lifecycle === "ready") moveTo("draining")
        try {
          await client?.close()
        } finally {
          client = undefined
          booting = undefined
          lifecycle = "closed"
        }
      })()
      return closing
    },
  }
}
