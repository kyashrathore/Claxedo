import path from "node:path"
import { query, type AgentInfo, type ModelInfo, type Query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { modelAndEffortOptions } from "../../contract"
import { draftProbeKey, DraftProbeCache, type ProbeInputs } from "../../contract/probe-cache"
import { CLAUDE_SETTINGS_FILES } from "../../profiles/claude-code"
import { claudeLaunchContext, type ClaudeSdkOptions } from "./launch-context"
import { ClaudeProcess } from "./process"

export class ClaudeModelCatalog {
  private readonly cache: DraftProbeCache<readonly ModelInfo[]>

  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions) {
    this.cache = new DraftProbeCache()
  }

  peek(input: StartInput | DraftLaunch): Promise<readonly ModelInfo[] | undefined> {
    return this.cache.peek(draftProbeKey(input), this.probeInputs(input))
  }

  load(input: StartInput | DraftLaunch, sessionId?: string): Promise<readonly ModelInfo[]> {
    return this.cache.read(draftProbeKey(input), this.probeInputs(input), () => this.discover(input, sessionId, (stream) => stream.supportedModels()))
  }

  private probeInputs(input: StartInput | DraftLaunch): ProbeInputs {
    const project = path.join(path.resolve(input.directory), ".claude")
    const root = this.options.userConfigRoot
    const account = path.join(this.options.env.CLAUDE_CONFIG_DIR ? root : path.dirname(root), ".claude.json")
    return { files: [...CLAUDE_SETTINGS_FILES.map((name) => path.join(root, name)), path.join(root, ".credentials.json"), account,
      path.join(project, "settings.json"), path.join(project, "settings.local.json")] }
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
    models: models.map((model) => ({ id: model.value, name: model.displayName, description: model.description,
      ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}) })),
    efforts: selected?.supportsEffort ? selected.supportedEffortLevels : undefined })
}
