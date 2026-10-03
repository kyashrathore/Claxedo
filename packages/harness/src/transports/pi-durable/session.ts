import { errorMessage } from "@claxedo/helpers"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { mergeStartInput, sessionMcpServers, type HarnessServices, type SessionBroker, type StartInput,
  type TransportConfigUpdate } from "../../contract"
import type { PiAsker } from "./approvals"
import { PiCredentials } from "./credentials"
import { piConfiguration } from "./errors"
import { claxedoPiExtension } from "./extension"
import { PiMcpTools } from "./mcp"
import { cachedMcpTools, recordMcpTools } from "./mcp-cache"
import type { PiPlacement, PiSessionRuntime } from "./placement"
import { PiSessionStream } from "./stream"

export type PiSessionInput = { start: StartInput; broker: SessionBroker; placement: PiPlacement; services: HarnessServices }

export class PiSession {
  readonly stream: PiSessionStream
  private readonly opening = crypto.randomUUID()
  private readonly mcp: PiMcpTools

  private constructor(private readonly input: PiSessionInput, public start: StartInput, readonly credentials: PiCredentials,
    readonly runtime: PiSessionRuntime) {
    this.stream = new PiSessionStream({ sessionId: start.sessionId, directory: start.directory, runtime, broker: input.broker, log: input.services.log, stop: () => this.stop() })
    this.mcp = new PiMcpTools({
      connect: (server) => input.placement.mcpTransport(server, start.sessionId),
      failed: (serverName, error) => void input.broker.publish({ type: "mcp-server-status", serverName, status: "failed", error: errorMessage(error) })
        .then(undefined, (failure: unknown) => input.services.log.error("Pi MCP status publication failed", { error: errorMessage(failure) })),
      cached: (key) => cachedMcpTools(runtime, key),
      record: (key, lists) => recordMcpTools(runtime, key, lists),
    })
  }

  static async open(input: PiSessionInput): Promise<PiSession> {
    const { start, placement } = input
    const credentials = new PiCredentials(start.credentials, start.providerDefinitions ?? [],
      async (credentialProviderId) => placement.refreshCredential?.(credentialProviderId, start.sessionId))
    const runtime = await placement.open({ sessionId: start.sessionId, directory: start.directory, models: credentials.models })
    const session = new PiSession(input, start, credentials, runtime)
    try {
      await session.install()
      await session.stream.open()
      runtime.harness.resume()
    } catch (error) {
      await session.close()
      throw error
    }
    return session
  }

  get sessionId(): string { return this.start.sessionId }

  get upstreamSessionId(): string { return `${this.start.sessionId}:${this.runtime.conversation.id}` }

  asker(): PiAsker { return this.stream.active?.broker ?? this.input.broker }

  async configure(update: TransportConfigUpdate): Promise<void> {
    this.start = mergeStartInput(this.start, update)
    if (update.credentials || update.providerDefinitions) this.credentials.update(this.start.credentials, this.start.providerDefinitions ?? [])
    if (update.projection) await this.install()
  }

  async stop(signal?: AbortSignal): Promise<void> {
    await this.runtime.conversation.abort(signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT)
  }

  async close(): Promise<void> {
    await this.stream.close()
    await this.mcp.close()
    await this.runtime.close()
  }

  private async install(): Promise<void> {
    const servers = sessionMcpServers(this.start, this.input.services, { includeFirstParty: this.start.locality === "local",
      duplicate: (name) => piConfiguration(`Duplicate Pi MCP server ${name}`) })
    const tools = await this.mcp.tools(servers, JSON.stringify([this.start.projection.generation, servers.map((server) => server.name)]))
    this.runtime.registry.install(CodingTools)
    this.runtime.registry.install(claxedoPiExtension({
      sessionId: this.sessionId, config: () => this.start.config, skills: () => this.start.projection.pluginRoots, asker: () => this.asker(), opening: this.opening,
    }, tools))
  }
}
