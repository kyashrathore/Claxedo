import type * as OpenCodeSdk from "@opencode-ai/sdk"
import { isAbsolute } from "node:path"
import { canTransition, isTerminal, type OpenCodeEventHealth, type OpenCodeLifecycle, type OpenCodeStatus } from "./lifecycle.js"
import { errorMessage, singleFlightUntil } from "@claxedo/helpers"

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
  client(): Promise<OpenCodeClient>
  status(): OpenCodeStatus
  setEventHealth(health: OpenCodeEventHealth): void
  close(): Promise<void>
}>

export async function openCodeLocationClient(host: OpenCodeHost, directory: string): Promise<OpenCodeClient> {
  const client = await host.client()
  await client.plugin.awaitActivation({ location: { directory } })
  return client
}

class EmbeddedOpenCodeHost implements OpenCodeHost {
  private lifecycle: OpenCodeLifecycle = "cold"
  private events: OpenCodeEventHealth = "healthy"
  private reason: string | undefined
  private booting: Promise<OpenCodeClient> | undefined
  private current: OpenCodeClient | undefined
  private closing = false

  constructor(private readonly options: OpenCodeHostOptions) {
    if (!isAbsolute(options.databasePath)) {
      throw new Error(`OpenCode databasePath must be absolute, received ${options.databasePath}`)
    }
  }

  private moveTo(next: OpenCodeLifecycle, why?: string): void {
    if (!canTransition(this.lifecycle, next)) {
      throw new Error(`Illegal OpenCode lifecycle transition ${this.lifecycle} -> ${next}`)
    }
    this.lifecycle = next
    this.reason = why
  }

  private async boot(): Promise<OpenCodeClient> {
    this.moveTo("migrating")
    try {
      const { OpenCode } = await import("@opencode-ai/sdk")
      const created = await OpenCode.create({
        plugins: this.options.plugins,
        database: { path: this.options.databasePath },
        events: { persist: this.options.persistEvents ?? true },
        fs: { fff: false },
        ...(this.options.configContent ? { config: { content: this.options.configContent } } : {}),
      })
      this.current = created
      this.moveTo("ready")
      return created
    } catch (cause) {
      this.booting = undefined
      this.lifecycle = "unavailable"
      this.reason = errorMessage(cause)
      throw new OpenCodeUnavailableError(this.reason, { cause })
    }
  }

  client(): Promise<OpenCodeClient> {
    if (this.closing || isTerminal(this.lifecycle)) {
      return Promise.reject(new OpenCodeUnavailableError("the runtime owner is closed; construct a fresh one"))
    }
    if (this.current) return Promise.resolve(this.current)
    if (this.lifecycle === "unavailable") this.moveTo("cold")
    this.booting ??= this.boot()
    return this.booting
  }

  status(): OpenCodeStatus {
    return this.reason === undefined
      ? { lifecycle: this.lifecycle, events: this.events }
      : { lifecycle: this.lifecycle, events: this.events, reason: this.reason }
  }

  setEventHealth(next: OpenCodeEventHealth): void {
    this.events = next
  }

  private readonly drainOnce = singleFlightUntil(() => this.drain(), () => true)

  close(): Promise<void> {
    this.closing = true
    return this.drainOnce()
  }

  private async drain(): Promise<void> {
    if (isTerminal(this.lifecycle)) return
    if (this.booting) {
      try {
        await this.booting
      } catch (error) {
        if (!(error instanceof OpenCodeUnavailableError)) throw error
      }
    }
    if (this.lifecycle === "ready") this.moveTo("draining")
    await this.current?.close()
    this.current = undefined
    this.booting = undefined
    this.lifecycle = "closed"
  }
}

export function createOpenCodeHost(options: OpenCodeHostOptions): OpenCodeHost {
  return new EmbeddedOpenCodeHost(options)
}
