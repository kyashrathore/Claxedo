/**
 * The one owner of `OpenCode.create()` in this process.
 *
 * Ownership rules this module exists to enforce:
 *
 *   - ONE host per OS process, created lazily on first OpenCode use and shared
 *     across every local workspace runtime. Cold shell hydration and the
 *     generic event stream must not touch this module, or the SDK stops being
 *     lazy and idle memory regresses.
 *   - ONE database writer. The path is explicit and absolute; the SDK
 *     otherwise defaults to `:memory:` and would silently lose everything
 *     (contract doc §3).
 *   - Concurrent first-use requests share ONE creation promise. Two callers
 *     racing must not open two hosts against one SQLite file.
 *   - A closed owner is terminal. Restart constructs a fresh owner.
 *
 * Failure is explicit: a boot failure leaves the owner `unavailable` with a
 * reason and never selects another transport. There is no fallback runtime.
 */
import { OpenCode } from "@opencode-ai/sdk"
import { repairCoreLayerGraph } from "./upstream-repair"
import {
  canTransition,
  isTerminal,
  type OpenCodeEventHealth,
  type OpenCodeLifecycle,
  type OpenCodeStatus,
} from "./lifecycle"

/** The public SDK's client interface. Only this module may hold one. */
export type OpenCodeClient = Awaited<ReturnType<typeof OpenCode.create>>

export type OpenCodeHostOptions = Readonly<{
  /**
   * Absolute path to the process-owned SQLite database. Required: the SDK
   * defaults to `:memory:`, which would look like a working host that loses
   * every session on restart.
   */
  databasePath: string
  /** Explicit SDK config content, when the composition supplies one. */
  configContent?: string
  /** Persist events. Defaults to true; the stream is volatile either way. */
  persistEvents?: boolean
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

export function createOpenCodeHost(options: OpenCodeHostOptions): OpenCodeHost {
  if (!options.databasePath.startsWith("/")) {
    throw new Error(`OpenCode databasePath must be absolute, received ${options.databasePath}`)
  }

  let lifecycle: OpenCodeLifecycle = "cold"
  let events: OpenCodeEventHealth = "healthy"
  let reason: string | undefined
  // The single-flight latch. Both concurrent first-use callers await this.
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
      // Must precede the first `OpenCode.create()`: the layer graph it repairs
      // is compiled during creation, and a hole in it makes every
      // location-resolving request a 500. See upstream-repair.ts.
      repairCoreLayerGraph()
      const created = await OpenCode.create({
        database: { path: options.databasePath },
        events: { persist: options.persistEvents ?? true },
        ...(options.configContent ? { config: { content: options.configContent } } : {}),
      })
      client = created
      moveTo("ready")
      return created
    } catch (cause) {
      // Boot failure is terminal for THIS attempt but not for the owner: the
      // cause may be corrected (a locked database released, a plugin fixed)
      // and retried on the same SDK path. It may never select another one.
      booting = undefined
      lifecycle = "unavailable"
      reason = cause instanceof Error ? cause.message : String(cause)
      throw new OpenCodeUnavailableError(reason, { cause })
    }
  }

  return {
    client() {
      if (isTerminal(lifecycle)) {
        return Promise.reject(new OpenCodeUnavailableError("the runtime owner is closed; construct a fresh one"))
      }
      if (client) return Promise.resolve(client)
      // Single-flight: the first caller installs the promise, everyone else
      // awaits it. Without this, concurrent first use opens two hosts.
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
        // Let in-flight work finish before the writer goes away.
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
