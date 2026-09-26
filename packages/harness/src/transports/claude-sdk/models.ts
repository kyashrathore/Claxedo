import { query, type AgentInfo, type ModelInfo, type Query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { draftProbeKey, DraftProbeCache, modelAndEffortOptions } from "../../contract"
import { claudeLaunchContext, type ClaudeSdkOptions } from "./launch-context"
import { ClaudeProcess } from "./process"

export class ClaudeModelCatalog {
  private readonly cache: DraftProbeCache<readonly ModelInfo[]>

  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions) {
    this.cache = new DraftProbeCache(services.clock)
  }

  peek(input: StartInput | DraftLaunch): readonly ModelInfo[] | undefined { return this.cache.peek(draftProbeKey(input)) }

  load(input: StartInput | DraftLaunch, sessionId?: string): Promise<readonly ModelInfo[]> {
    const key = draftProbeKey(input)
    return this.cache.get(key) ?? this.cache.set(key, this.discover(input, sessionId, (stream) => stream.supportedModels()))
  }

  async commands(input: StartInput | DraftLaunch, sessionId?: string): Promise<SlashCommand[]> {
    return this.discover(input, sessionId, (stream) => stream.supportedCommands())
  }

  async agents(input: StartInput | DraftLaunch, sessionId?: string): Promise<AgentInfo[]> {
    return this.discover(input, sessionId, (stream) => stream.supportedAgents())
  }

  private async discover<T>(input: StartInput | DraftLaunch, sessionId: string | undefined,
    read: (stream: Query) => Promise<T>): Promise<T> {
    const context = await claudeLaunchContext(input, this.options, sessionId ?? "probe")
    const spawned: ClaudeProcess[] = []
    const abort = new AbortController()
    const probe = query({ prompt: { async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    } }, options: {
      ...context, abortController: abort,
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, sessionId ?? "probe", "probe")
        spawned.push(child)
        return child
      },
    } })
    try {
      return await read(probe)
    } finally {
      abort.abort()
      probe.close()
      await Promise.all(spawned.map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    }
  }
}

export function claudeCatalogModel(models: readonly ModelInfo[], modelId?: string): ModelInfo | undefined {
  return models.find((model) => model.value === modelId) ?? models.find((model) => model.resolvedModel === modelId)
    ?? (modelId === undefined ? models.find((model) => model.value === "default") : undefined)
}

export function requiredClaudeEffort(models: readonly ModelInfo[], modelId: string, requested?: string | null): string | undefined {
  if (!requested) return undefined
  const row = claudeCatalogModel(models, modelId)
  if (row?.supportsEffort && row.supportedEffortLevels?.some((level) => level === requested)) return requested
  throw new TransportError("claude", "configuration", `Claude does not run ${row?.value ?? modelId} at effort ${requested}`)
}

export function modelOptions(models: readonly ModelInfo[], currentModel: string): AgentConfigOption[] {
  if (!models.length) return []
  const selected = claudeCatalogModel(models, currentModel)
  return modelAndEffortOptions({ selected: selected?.value,
    models: models.map((model) => ({ id: model.value, name: model.displayName, description: model.description })),
    efforts: selected?.supportsEffort ? selected.supportedEffortLevels : undefined })
}
