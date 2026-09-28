import type { AgentConfigOption, AgentModel } from "@claxedo/agent-runtime-contract"
import { credentialBrokerErrorCode } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import { modelAndEffortOptions } from "../../contract"
import { TransportError } from "../../contract/errors"
import type { CursorCredential } from "./credentials"
import type { CursorHost } from "./host-registry"
import type { HostModel } from "./protocol"

const AUTO: HostModel = { id: "auto", name: "Auto" }

export function catalogReadError(cause: unknown, viaBinding: boolean): TransportError {
  const text = errorMessage(cause)
  const code = viaBinding ? credentialBrokerErrorCode(text) : undefined
  if (code === "credential_unavailable" || code === "binding_unavailable") {
    return new TransportError("cursor", "configuration", "No Cursor API key is stored for this workspace, so Cursor's model catalog cannot be read. Add a cursor-sdk API key under Settings → Providers.", { cause })
  }
  if (code === "request_outside_policy") {
    return new TransportError("cursor", "configuration", "Cursor's model catalog (api.cursor.com) is not reachable through the credential broker, which routes only the agent service; models cannot be listed with a stored key. The default model still runs when that key is valid.", { cause })
  }
  return new TransportError("cursor", "configuration", `Cursor's model catalog could not be read: ${text}`, { cause })
}

function pinAuto(models: readonly HostModel[]): HostModel[] {
  if (!models.length || models.some((model) => model.id === AUTO.id)) return [...models]
  return [AUTO, ...models]
}

export function cursorModelOptions(models: readonly HostModel[], requested: string): AgentConfigOption[] {
  const catalog = pinAuto(models)
  if (!catalog.length) return []
  const selected = catalog.some((model) => model.id === requested) ? requested : AUTO.id
  return modelAndEffortOptions({ models: catalog, selected })
}

export function cursorCatalogModels(models: readonly HostModel[]): AgentModel[] {
  return pinAuto(models).map((model) => ({ providerId: "cursor", modelId: model.id, name: model.name,
    ...(model.description ? { description: model.description } : {}) }))
}

export function catalogKey(credential: CursorCredential, leaseGeneration: string): string {
  return JSON.stringify([credential.key, leaseGeneration])
}

export class CursorModelCatalog {
  private readonly rows = new Map<string, HostModel[]>()
  private readonly inFlight = new Map<string, Promise<HostModel[]>>()

  peek(key: string): HostModel[] | undefined { return this.rows.get(key) }

  async load(key: string, host: () => Promise<CursorHost>, credential: CursorCredential): Promise<HostModel[]> {
    const cached = this.rows.get(key)
    if (cached) return cached
    const running = this.inFlight.get(key)
    if (running) return running
    const probe = this.read(host, credential)
    this.inFlight.set(key, probe)
    try {
      const models = await probe
      this.rows.set(key, models)
      return models
    } finally { this.inFlight.delete(key) }
  }

  private async read(host: () => Promise<CursorHost>, credential: CursorCredential): Promise<HostModel[]> {
    let reply
    try { reply = await (await host()).call({ kind: "models", apiKey: credential.apiKey }) }
    catch (error) { throw catalogReadError(error, credential.bound) }
    return reply.kind === "result" ? reply.value?.models ?? [] : []
  }
}
