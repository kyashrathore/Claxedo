import type { ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { ProjectedMcpServer, TurnExecutionAccess } from "@claxedo/harness/contract"
import type { PiPlacement, PiSessionRuntime, PiTurnContext } from "@claxedo/harness/pi-durable"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Models } from "@earendil-works/pi-ai"
import { createRegistry, Harness, type HarnessOptions } from "@earendil-works/pi-durable"
import { StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp"
import type { PiHarness, PiHarnessFactory } from "agents/harness/pi"
import { RelayedStdioMcpTransport } from "./mcp-relay-transport"
import { RemoteExecutionEnv } from "./remote-env"

export type DurablePiHost = {
  root: string
  pi: PiHarness
  execution(signal: AbortSignal): Promise<TurnExecutionAccess>
  turnContext(signal: AbortSignal): Promise<PiTurnContext>
  refresh(credentialProviderId: string): Promise<ProviderDirect | undefined>
  report(error: unknown): void
}

/**
 * The object's one Pi `Harness`: opened by `PiHarness`'s factory over the
 * object's SQLite, with the object's one registry and one `Models` that
 * forwards to whichever session's credentials the transport last opened.
 * pi-durable fixes `models` and `registry` when the Harness opens and
 * `PiHarness` resumes it as soon as the factory returns, so the factory runs
 * the object's boot first: a session with live work is attached, which
 * installs its extensions, before anything of it can run.
 */
export class DurablePiPlacement implements PiPlacement {
  private readonly registry = createRegistry()
  private sessionModels: Models | undefined
  private opened: Promise<Harness> | undefined
  private turn: AbortSignal | undefined
  private readonly models = new Proxy<Models>(Object.create(null), {
    get: (_target, key) => {
      if (!this.sessionModels) throw new Error("No Pi session is open in this session host")
      const value: unknown = Reflect.get(this.sessionModels, key)
      return typeof value === "function" ? value.bind(this.sessionModels) : value
    },
  })

  constructor(private readonly host: DurablePiHost) {}

  factory(boot: () => Promise<void>): PiHarnessFactory {
    return async ({ storage, context }) => {
      const options: HarnessOptions = { models: this.models, registry: this.registry, env: this.env(), onReport: (error) => this.host.report(error) }
      const opening = Harness.open(storage, options, context)
      this.opened = opening
      try {
        await opening
        await boot()
      } catch (error) {
        this.opened = undefined
        await opening.then((harness) => harness.close(BACKGROUND_CONTEXT), () => undefined)
        throw error
      }
      return opening
    }
  }

  /** Every wait on the workspace machine ends with this signal: the running turn's, or at boot the adopted lease's. */
  turnStarted(signal: AbortSignal): void {
    this.turn = signal
  }

  harness(): Promise<Harness> {
    return this.opened ?? this.host.pi.pi()
  }

  async open(input: { sessionId: string; directory: string; models: Models }): Promise<PiSessionRuntime> {
    if (input.sessionId !== this.host.root) throw new Error(`This session host serves ${this.host.root}, not ${input.sessionId}`)
    this.sessionModels = input.models
    const harness = await this.harness()
    const conversation = await harness.root(BACKGROUND_CONTEXT)
    return {
      harness, conversation, registry: this.registry,
      submit: async (content, { requestId, whenBusy }) => { await this.host.pi.submit(content, { operationId: requestId, whenBusy }) },
      close: async () => {},
    }
  }

  env(): HarnessOptions["env"] {
    return async (_target, context) => new RemoteExecutionEnv(await this.host.execution(context.abortSignal ?? this.turnSignal()))
  }

  async mcpTransport(server: ProjectedMcpServer): Promise<McpTransport> {
    if (server.kind === "stdio") return new RelayedStdioMcpTransport(server.name, () => this.host.execution(this.turnSignal()))
    if (server.kind === "sse") throw new Error(`Pi cannot load SSE MCP server ${server.name}`)
    return new StreamableHttpTransport({ url: server.url, headers: { ...server.headers } })
  }

  prepareTurn(_sessionId: string, signal: AbortSignal): Promise<PiTurnContext> {
    this.turnStarted(signal)
    return this.host.turnContext(signal)
  }

  private turnSignal(): AbortSignal {
    return this.turn ?? AbortSignal.abort(new Error("No turn is running in this session host"))
  }

  refreshCredential(credentialProviderId: string): Promise<ProviderDirect | undefined> {
    return this.host.refresh(credentialProviderId)
  }
}
