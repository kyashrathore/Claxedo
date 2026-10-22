import path from "node:path"
import { query, type AgentInfo, type ModelInfo, type Query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { DraftLaunch, HarnessServices, StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { draftProbeKey, DraftProbeCache, type ProbeInputs } from "../../contract/node"
import { CLAUDE_SETTINGS_FILES } from "../../profiles/claude-code"
import { claudeLaunchContext, type ClaudeSdkOptions } from "./launch-context"
import { ClaudeProcess } from "./process"

export class ClaudeModelCatalog {
  private readonly cache: DraftProbeCache<readonly ModelInfo[]>
  private readonly disposal = new AbortController()
  private readonly probing = new Set<Promise<unknown>>()

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

  async dispose(): Promise<void> {
    this.disposal.abort()
    await Promise.allSettled(this.probing)
  }

  private async discover<T>(input: StartInput | DraftLaunch, sessionId: string | undefined,
    read: (stream: Query) => Promise<T>): Promise<T> {
    if (this.disposal.signal.aborted) throw new TransportError("claude", "session", "Claude transport disposed")
    const probe = this.probe(input, sessionId, read)
    this.probing.add(probe)
    try {
      return await probe
    } finally {
      this.probing.delete(probe)
    }
  }

  private async probe<T>(input: StartInput | DraftLaunch, sessionId: string | undefined,
    read: (stream: Query) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    const stop = () => abort.abort()
    this.disposal.signal.addEventListener("abort", stop, { once: true })
    const context = await claudeLaunchContext(input, this.options, sessionId ?? "probe").catch((error: unknown) => {
      this.disposal.signal.removeEventListener("abort", stop)
      throw error
    })
    if (abort.signal.aborted) throw new TransportError("claude", "session", "Claude transport disposed")
    const spawned: ClaudeProcess[] = []
    const probe = query({ prompt: { async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    } }, options: {
      ...context, ...claudeProbeModel(input), abortController: abort,
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, sessionId ?? "probe", "probe")
        spawned.push(child)
        return child
      },
    } })
    try {
      return await read(probe)
    } finally {
      this.disposal.signal.removeEventListener("abort", stop)
      abort.abort()
      probe.close()
      await Promise.all(spawned.map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    }
  }
}

export function claudeProbeModel(input: StartInput | DraftLaunch): { model?: string } {
  return input.model ? { model: input.model.modelID } : {}
}
