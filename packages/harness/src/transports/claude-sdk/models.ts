import path from "node:path"
import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOption } from "@claxedo/agent-runtime-contract"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { composeClaudeConfigHome } from "../../profiles/claude-code"
import { claudeBinding, claudeEnvironment } from "./credentials"
import { ClaudeTransportError } from "./errors"
import { ClaudeProcess } from "./process"

export class ClaudeModelCatalog {
  private readonly rows = new Map<string, readonly ModelInfo[]>()
  private readonly inFlight = new Map<string, Promise<readonly ModelInfo[]>>()

  constructor(private readonly services: HarnessServices, private readonly options: {
    executable: string; configRoot: string; userConfigRoot: string; env?: NodeJS.ProcessEnv
  }) {}

  private key(input: StartInput | DraftLaunch): string {
    return JSON.stringify([input.directory, input.owner.kind === "person" ? input.owner.userId : "machine-owner", input.credentials.leaseGeneration])
  }

  peek(input: StartInput | DraftLaunch): readonly ModelInfo[] | undefined { return this.rows.get(this.key(input)) }

  async load(input: StartInput | DraftLaunch, sessionId?: string): Promise<readonly ModelInfo[]> {
    const key = this.key(input)
    const cached = this.peek(input)
    if (cached) return cached
    const running = this.inFlight.get(key)
    if (running) return running
    const probe = this.probe(input, sessionId)
    this.inFlight.set(key, probe)
    try { return await probe }
    finally { this.inFlight.delete(key) }
  }

  private async probe(input: StartInput | DraftLaunch, sessionId?: string): Promise<readonly ModelInfo[]> {
    const binding = claudeBinding(input.credentials, input.owner)
    const home = binding ? await composeClaudeConfigHome(path.join(this.options.configRoot, sessionId ?? "probe"), this.options.userConfigRoot) : undefined
    const spawned: ClaudeProcess[] = []
    const abort = new AbortController()
    const probe = query({ prompt: { async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    } }, options: {
      cwd: input.directory, pathToClaudeCodeExecutable: this.options.executable,
      env: claudeEnvironment(this.options.env ?? process.env, binding, home), abortController: abort,
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, sessionId ?? "probe", "probe")
        spawned.push(child)
        return child
      },
    } })
    try {
      const models = await probe.supportedModels()
      this.rows.set(this.key(input), models)
      return models
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
  throw new ClaudeTransportError("configuration", `Claude does not run ${row?.value ?? modelId} at effort ${requested}`)
}

export function modelOptions(models: readonly ModelInfo[], currentModel: string): AgentConfigOption[] {
  if (!models.length) return []
  const selected = claudeCatalogModel(models, currentModel)
  const result: AgentConfigOption[] = [{ id: "model", name: "Model", category: "model", type: "select",
    ...(selected ? { currentValue: selected.value } : {}),
    selectOptions: models.map((model) => ({ id: model.value, name: model.displayName, description: model.description })) }]
  if (selected?.supportsEffort && (selected.supportedEffortLevels?.length ?? 0) > 1) result.push({
    id: "effort", name: "Effort", category: "thought_level", type: "select",
    selectOptions: selected.supportedEffortLevels!.map((level) => ({ id: level, name: level[0]!.toUpperCase() + level.slice(1) })),
  })
  return result
}
