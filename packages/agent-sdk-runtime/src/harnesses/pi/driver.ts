import {
  assertPiProvidersBindable,
  piProviderOverrides,
  piSpawnEnv,
  retainPiAuth,
  type PiAuthEntries,
  type PiProviderOverrides,
} from "./auth"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { trimToUndefined } from "@claxedo/helpers/string"
import { observeAgentProcess } from "../../process-observer"
import { createEvaluatedGoalResource } from "../shared/evaluated-goal-resource"
import { GOAL_PROMPT_TEXT, goalEvaluatorRequest, parseGoalEvaluation } from "../shared/goal-protocol"
import path from "node:path"
import os from "node:os"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { piRpcAdapter } from "@claxedo/agent-event-runtime/harnesses/pi"
import type { AgentConfigOption, PromptInput } from "../../index"
import { modelConfigOption, type SdkModelEntry } from "../../sdk-model-options"
import {
  extractTextFromParts,
  record,
  text,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import { providerProjectionRecord, type ProviderProjection } from "../../provider-projection"
import { PiJsonLines, PiRpcProcess, type PiRpcMessage } from "./rpc-process"
import { listPiCatalogModels } from "./catalog"
import { requirePiExecutable, verifyPiExecutable, piCommand } from "./executable"

export type PiDriverOptions = {
  binary?: string
  agentDir?: string
  /** Scopes the default profile; two workspaces must not share one `models.json`. */
  workspaceId?: string
  idleMs?: number
}
type Entry = {
  id: string
  process: PiRpcProcess
  directory: string
  busy: boolean
  idleGeneration: number
  idle?: ReturnType<typeof setTimeout>
}

/** A workspace id as one path segment; the id itself may contain separators. */
function piWorkspaceDirName(workspaceId: string | undefined) {
  return workspaceId ? createHash("sha256").update(workspaceId).digest("hex").slice(0, 16) : "default"
}

export function createPiRpcDriver(host: SdkRuntimeDriverHost, options: PiDriverOptions = {}): SdkRuntimeDriver {
  return new PiRpcDriver(host, options)
}

class PiRpcDriver implements SdkRuntimeDriver {
  readonly type = "pi" as const
  readonly interactions = { permissions: false, questions: true } as const
  readonly goals
  private evaluators = 0
  private readonly goalController
  private projectedAuth?: PiAuthEntries
  private projectedProviders?: PiProviderOverrides
  private auth: Record<string, ProviderProjection> | undefined
  private entries = new Map<string, Entry>()
  // Pi writes a session's file only at its first assistant message; a process
  // lost before then leaves a bound id nothing on disk can name. These are the
  // ids this driver created but has never seen persisted, so `ensure` may
  // recreate just those while still refusing a fabricated one.
  private readonly unpersisted = new Set<string>()
  private models: SdkModelEntry[] = []
  private thinking: string[] = []
  private selectedThinking = "off"
  private processError?: string
  private readonly agentDir: string
  private readonly authProfile: ReturnType<typeof retainPiAuth>

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly options: PiDriverOptions,
  ) {
    this.goalController = createEvaluatedGoalResource({
      host,
      runIteration: async (turn, prompt, objective) => {
        let work = ""
        let settled: Parameters<SdkRuntimeTurnInput["ingest"]> | undefined
        await this.runTurn({
          ...turn,
          input: { ...turn.input, parts: [{ type: "text", text: prompt }] },
          ingest: (raw, source, route) => {
            // This native finish belongs to the work phase. The shared goal
            // turn also owns evaluation, including its observed billable usage.
            if (record(raw.payload)?.type === "agent_settled") {
              settled = [raw, source, route]
              return
            }
            const message = record(record(raw.payload)?.message)
            if (
              record(raw.payload)?.type === "message_end" &&
              message?.role === "assistant" &&
              Array.isArray(message.content)
            ) {
              work = message.content
                .flatMap((part) => (record(part)?.type === "text" ? [text(record(part)?.text) ?? ""] : []))
                .join("\n")
              if (message.stopReason === "error") throw new Error(text(message.errorMessage) ?? "Pi model failed")
            }
            turn.ingest(raw, source, route)
          },
        })
        if (!settled) throw new Error("Pi goal work ended without its native settlement")
        const request = {
          sessionId: turn.sessionId,
          directory: turn.directory,
          objective,
          work,
          signal: turn.abort.signal,
        }
        const selected = host.getSessionConfig(request.sessionId)?.model
        if (!selected) throw new Error("Goal evaluator requires a selected model")
        const model = piModel(selected)
        const binary = options.binary ?? requirePiExecutable()
        const args = [
          "-p",
          "--mode",
          "json",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--provider",
          model.providerID,
          "--model",
          model.modelID,
          "--system-prompt",
          GOAL_PROMPT_TEXT.evaluatorSystem.join("\n"),
          goalEvaluatorRequest(request),
        ]
        const command = piCommand(binary, args)
        this.evaluators++
        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            command.file,
            command.args,
            { cwd: request.directory, env: this.environment(), signal: request.signal, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
              try {
                let answer: string | undefined
                for (const event of new PiJsonLines().read(stdout)) {
                  if (event.type !== "message_end") continue
                  const message = record(event.message)
                  if (message?.role !== "assistant") continue
                  // Keep the native evaluator record as the usage source. Its
                  // private judgment is not a second transcript reply.
                  turn.ingest(
                    { source: "pi.goal-evaluator", payload: event },
                    { dir: "in", method: "goal.evaluation", frame: event },
                  )
                  if (message.stopReason === "error")
                    throw new Error(text(message.errorMessage) ?? "Pi evaluator failed")
                  if (Array.isArray(message.content))
                    answer = message.content
                      .flatMap((part) => (record(part)?.type === "text" ? [text(record(part)?.text) ?? ""] : []))
                      .join("\n")
                }
                if (error) throw error
                if (answer === undefined) throw new Error("Pi evaluator returned no assistant message")
                resolve(answer)
              } catch (failure) {
                reject(failure)
              }
            },
          )
          // Print mode consumes redirected stdin before running the prompt.
          child.stdin?.end()
          const observation = observeAgentProcess(host.processObserver, {
            ownerId: `pi-goal:${request.sessionId}`,
            launchId: randomUUID(),
            harnessId: "pi",
            access: "native",
            role: "harness",
            label: "Pi goal evaluator",
            locality: "local-process",
            confidence: "direct",
            capabilities: { resourceMetrics: "process", ownerActions: false },
            directory: request.directory,
            sessionId: request.sessionId,
            pid: child.pid,
            executableBasename: path.basename(binary),
          })
          let observedExit = false
          const exit = (reason: "cancelled" | "exited" | "error", exitCode?: number) => {
            if (observedExit) return
            observedExit = true
            observation.exit({ reason, ...(exitCode === undefined ? {} : { exitCode }) })
          }
          child.once("exit", (code) =>
            exit(request.signal.aborted ? "cancelled" : code === 0 ? "exited" : "error", code ?? undefined),
          )
          child.once("error", () => exit(request.signal.aborted ? "cancelled" : "error"))
        }).finally(() => {
          this.evaluators--
        })
        const evaluation = parseGoalEvaluation(output, "Pi")
        turn.ingest(...settled)
        return evaluation
      },
    })
    this.goals = this.goalController.resource
    // Per workspace, because the profile holds `models.json` — and that file
    // carries the broker placeholder. One shared profile lets the workspace
    // that applied last hand its binding to every other workspace's turns.
    this.agentDir = options.agentDir
      ?? trimToUndefined(process.env.PI_CODING_AGENT_DIR)
      ?? path.join(os.homedir(), ".claxedo", "pi", "agent", piWorkspaceDirName(options.workspaceId))
    this.authProfile = retainPiAuth(this.agentDir)
  }
  async applyConfig(config: Record<string, unknown>) {
    const auth = providerProjectionRecord(config.auth)
    if (config.auth !== undefined && !auth) {
      throw new Error("pi harness received an auth map that is not provider projections")
    }
    this.auth = auth
    // A brokered account reaches Pi as a `models.json` overlay, never as a key
    // in the environment or in `auth.json`; the managed profile writes both
    // files so it also replaces whatever an earlier build left behind, and both
    // are scrubbed when the last adapter sharing the profile is disposed.
    const projected: PiAuthEntries = {}
    const providers = piProviderOverrides(this.auth)
    if (JSON.stringify([projected, providers]) !== JSON.stringify([this.projectedAuth, this.projectedProviders])) {
      if (this.evaluators || [...this.entries.values()].some((entry) => entry.busy))
        throw new Error("Cannot rotate Pi credentials during an active turn")
      this.closeProcesses()
      await this.authProfile.write(projected, providers)
      this.projectedAuth = projected
      this.projectedProviders = providers
      this.models = []
    }
  }

  createRuntime(threadId: string) {
    return createAgentEventRuntime({ harness: "pi", threadId, adapter: piRpcAdapter() })
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...piSpawnEnv(process.env, this.auth),
      PI_CODING_AGENT_DIR: this.agentDir,
    }
  }
  private async start(directory: string, args: string[], model?: string) {
    if (!directory.trim()) throw new Error("Pi requires a workspace directory")
    assertPiProvidersBindable(this.auth, model)
    await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(this.agentDir, "sessions"), { recursive: true })
    const binary = this.options.binary ?? requirePiExecutable()
    await verifyPiExecutable(binary)
    const process = new PiRpcProcess({
      binary,
      directory,
      args: ["--mode", "rpc", "--session-dir", path.join(this.agentDir, "sessions"), ...args],
      env: this.environment(),
      observer: this.host.processObserver,
    })
    try {
      await process.request("get_state")
      return process
    } catch (error) {
      process.dispose()
      throw error
    }
  }
  async createAgentSession(input: { directory: string; title?: string; model: string; system?: string }) {
    const process = await this.start(input.directory, [
      ...(input.model ? ["--model", input.model] : []),
      ...(input.system ? ["--append-system-prompt", input.system] : []),
      ...(input.title ? ["--name", input.title] : []),
    ], input.model)
    try {
      const state = record(await process.request("get_state"))
      const id = text(state?.sessionId)
      if (!id) throw new Error("Pi did not return its native session id")
      this.unpersisted.add(id)
      this.remember(id, process, input.directory)
      const model = record(state?.model)
      const provider = text(model?.provider)
      const modelId = text(model?.id)
      return {
        id,
        ...(provider && modelId ? { model: { providerID: "pi", modelID: `${provider}/${modelId}` } } : {}),
      }
    } catch (error) {
      process.dispose()
      throw error
    }
  }
  private remember(id: string, process: PiRpcProcess, directory: string) {
    const entry: Entry = { id, process, directory, busy: false, idleGeneration: 0 }
    this.entries.set(id, entry)
    process.onExit((error) => {
      if (entry.idle) clearTimeout(entry.idle)
      if (this.entries.get(id) === entry) this.entries.delete(id)
      if (entry.busy) this.processError = error.message
    })
    this.reap(entry)
    return entry
  }
  private reap(entry: Entry) {
    const generation = ++entry.idleGeneration
    if (entry.idle) clearTimeout(entry.idle)
    if (entry.busy) return
    const current = () => generation === entry.idleGeneration && !entry.busy && entry.process.alive
    entry.idle = setTimeout(() => {
      // Pi defers writing its session until the first assistant message. Keep a new session alive.
      void entry.process
        .request("get_state")
        .then(async (value) => {
          const file = text(record(value)?.sessionFile)
          const persisted =
            file &&
            (await fs.stat(file).then(
              () => true,
              () => false,
            ))
          if (!current()) return
          if (persisted) {
            this.unpersisted.delete(entry.id)
            entry.process.dispose()
          } else this.reap(entry)
        })
        .catch(() => {
          if (current()) entry.process.dispose()
        })
    }, this.options.idleMs ?? 60_000)
    entry.idle.unref()
  }
  private async ensure(id: string, directory: string) {
    const entry = this.entries.get(id)
    if (entry) {
      if (entry.directory !== directory) throw new Error("Pi native session directory mismatch")
      return entry
    }
    // Never let an unknown session identifier cause Pi to create a fresh session.
    const files = await fs.readdir(path.join(this.agentDir, "sessions"))
    const filename = files.find((name) => name.endsWith(`_${id}.jsonl`))
    if (filename) this.unpersisted.delete(id)
    else if (!this.unpersisted.has(id)) throw new Error(`Pi session file is missing for ${id}`)
    const process = await this.start(directory, filename
      ? ["--session", path.join(this.agentDir, "sessions", filename)]
      : ["--session-id", id])
    try {
      const state = record(await process.request("get_state"))
      if (state?.sessionId !== id) throw new Error("Pi resumed a different session")
      return this.remember(id, process, directory)
    } catch (error) {
      process.dispose()
      throw error
    }
  }
  async runTurn(input: SdkRuntimeTurnInput) {
    const entry = await this.ensure(input.getAgentSessionId(), input.directory)
    if (entry.busy) throw new Error("Pi already has an active turn")
    entry.busy = true
    this.reap(entry)
    this.processError = undefined
    const process = entry.process
    const questionIds = new Set<string>()
    let modelError: Error | undefined
    let started = false
    let cancelling: Promise<void> | undefined
    let removeEvent = () => {}
    let removeExit = () => {}
    let finish!: () => void
    let fail!: (error: Error) => void
    const settled = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    // The stream may fail while awaiting command acknowledgement.
    void settled.catch(() => {})
    const abort = () => {
      if (cancelling) return
      cancelling = Promise.resolve()
        .then(async () => {
          for (const id of questionIds) this.host.pendingQuestions.get(id)?.reject()
          await process.request("clear_queue")
          await process.request("abort")
          finish()
        })
        .catch((error) => {
          process.dispose()
          fail(error)
        })
    }
    try {
      removeExit = process.onExit(fail)
      removeEvent = process.onEvent((event) => {
        if (event.type === "agent_start") started = true
        // A cancelled extension can settle before the abort command itself has
        // drained. Only this turn's start and the completed cancellation own release.
        if (event.type === "agent_settled" && (!started || input.abort.signal.aborted)) return
        if (event.type === "extension_ui_request") {
          this.question(input, process, event, questionIds)
          input.ingest(
            { source: "pi.rpc", method: event.type, payload: event },
            { dir: "in", method: event.type, frame: event },
          )
          return
        }
        if (event.type === "message_end" && record(event.message)?.role === "assistant") {
          const message = record(event.message)!
          modelError =
            message.stopReason === "error"
              ? new Error(text(message.errorMessage) ?? "Pi model request failed")
              : undefined
        }
        if (event.type === "agent_settled" && modelError) {
          fail(modelError)
          return
        }
        input.ingest(
          { source: "pi.rpc", method: event.type, payload: event },
          { dir: "in", method: event.type, frame: event },
        )
        if (event.type === "agent_settled") finish()
      })
      this.host.lifecycle().set(input.sessionId, {
        abort: input.abort,
        close: abort,
        steer: async (steered) => {
          const steeredImages = piImageContents(steered.parts)
          await process.request("steer", {
            message: extractTextFromParts(steered.parts),
            ...(steeredImages.length ? { images: steeredImages } : {}),
          })
        },
      })
      input.abort.signal.addEventListener("abort", abort, { once: true })
      if (input.abort.signal.aborted) {
        abort()
        await settled
        return
      }
      const model = piModel(input.input.model)
      await process.request("set_model", { provider: model.providerID, modelId: model.modelID })
      if (input.input.variant) await process.request("set_thinking_level", { level: input.input.variant })
      if (input.abort.signal.aborted) {
        await settled
        return
      }
      const images = piImageContents(input.input.parts)
      await process.request("prompt", {
        message: [input.input.system, extractTextFromParts(input.input.parts)].filter(Boolean).join("\n\n"),
        ...(images.length ? { images } : {}),
      })
      await settled
    } catch (error) {
      // Losing an acknowledgement does not authorize replay; stop this process before admitting another turn.
      process.dispose()
      throw error
    } finally {
      await cancelling
      removeEvent()
      removeExit()
      input.abort.signal.removeEventListener("abort", abort)
      for (const id of questionIds) this.host.pendingQuestions.delete(id)
      entry.busy = false
      if (process.alive) this.reap(entry)
    }
  }
  private question(input: SdkRuntimeTurnInput, process: PiRpcProcess, event: PiRpcMessage, ids: Set<string>) {
    if (typeof event.id !== "string") throw new Error("Pi extension question lacks request id")
    const id = event.id
    if (!["select", "confirm", "input", "editor"].includes(String(event.method))) {
      if (event.method === "notify")
        input.ingest(
          {
            source: "pi.rpc",
            payload: { type: "extension_notify", message: event.message, notifyType: event.notifyType },
          },
          { dir: "in", method: "extension_ui_request" },
        )
      return
    }
    const options = Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === "string")
      : undefined
    ids.add(id)
    const respond = (response: Record<string, unknown>) => {
      ids.delete(id)
      this.host.pendingQuestions.delete(id)
      process.send({ type: "extension_ui_response", id, ...response })
    }
    this.host.pendingQuestions.set(id, {
      sessionId: input.sessionId,
      agentSessionId: input.getAgentSessionId(),
      questions: [
        {
          question: text(event.title) ?? text(event.message) ?? "Pi extension",
          header: "Pi",
          options: (options ?? (event.method === "confirm" ? ["Yes", "No"] : [])).map((label) => ({
            label,
            description: "",
          })),
          multiple: false,
        },
      ],
      resolve: (answers) => {
        const answer = answers[0]
        const value = typeof answer === "string" ? answer : Array.isArray(answer) ? answer[0] : undefined
        if (event.method === "confirm") respond({ confirmed: value === "Yes" })
        else if (value !== undefined) respond({ value })
        else respond({ cancelled: true })
      },
      reject: () => respond({ cancelled: true }),
    })
  }
  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    if (!directory) throw new Error("Pi model discovery requires a machine workspace")
    const probe = await this.start(directory, ["--no-session"])
    try {
      const result = record(await probe.request("get_available_models"))
      if (!Array.isArray(result?.models)) throw new Error("Pi returned an invalid model catalog")
      const available = result.models.map((value) => {
        const model = record(value)
        const provider = text(model?.provider)
        const modelId = text(model?.id)
        if (!provider || !modelId) throw new Error("Pi model lacks provider/id")
        return { id: `${provider}/${modelId}`, name: text(model?.name) ?? modelId }
      })
      const binary = this.options.binary ?? requirePiExecutable()
      const catalog = await listPiCatalogModels(binary, this.agentDir)
      const availableIds = new Set(available.map((model) => model.id))
      this.models = (catalog.length ? catalog : available).map((model) => ({
        ...model,
        connected: availableIds.has(model.id),
      }))
      if (availableIds.has(currentModel)) {
        const slash = currentModel.indexOf("/")
        await probe.request("set_model", {
          provider: currentModel.slice(0, slash),
          modelId: currentModel.slice(slash + 1),
        })
      }
      const levels = record(await probe.request("get_available_thinking_levels"))
      this.thinking = Array.isArray(levels?.levels)
        ? levels.levels.filter((value): value is string => typeof value === "string")
        : []
      const state = record(await probe.request("get_state"))
      this.selectedThinking = text(state?.thinkingLevel) ?? "off"
      const selectedProvider = text(record(state?.model)?.provider)
      const selectedModelId = text(record(state?.model)?.id)
      const selectedId = selectedProvider && selectedModelId ? `${selectedProvider}/${selectedModelId}` : undefined
      this.models = this.models.map((model) => ({ ...model, isDefault: model.id === selectedId }))
      return this.peekConfigOptions(currentModel)
    } finally {
      probe.dispose()
    }
  }
  peekConfigOptions(currentModel: string): AgentConfigOption[] {
    if (!this.models.length) return []
    return [
      modelConfigOption(this.models, currentModel),
      ...(this.thinking.length
        ? [
            {
              id: "effort",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              currentValue: this.selectedThinking,
              selectOptions: this.thinking.map((value) => ({ id: value, name: value })),
            } satisfies AgentConfigOption,
          ]
        : []),
    ]
  }
  readRuntimeHealth() {
    return this.processError
      ? { status: "degraded" as const, reason: "harness_process_lost" as const, message: this.processError }
      : { status: "ok" as const }
  }
  deleteAgentSession(_sessionId: string, agentSessionId: string) {
    this.unpersisted.delete(agentSessionId)
    this.entries.get(agentSessionId)?.process.dispose()
  }
  async dispose() {
    await this.goalController.dispose()
    this.closeProcesses()
    await this.authProfile.release()
  }
  private closeProcesses() {
    for (const entry of this.entries.values()) {
      if (entry.idle) clearTimeout(entry.idle)
      entry.process.dispose()
    }
    this.entries.clear()
  }
}

/**
 * Pi takes images inline. A file part with any other url has no Pi
 * representation at all, so it is refused rather than silently dropped.
 */
function piImageContents(parts: PromptInput["parts"]) {
  return parts.flatMap((part) => {
    const file = record(part)
    const url = text(file?.url)
    const match = url?.match(/^data:(image\/[^;]+);base64,(.+)$/s)
    if (file?.type === "file" && !match)
      throw new Error("Pi attachments require an inline base64 image; refer to workspace files by path")
    return match ? [{ type: "image", mimeType: match[1], data: match[2] }] : []
  })
}

/** A native model key belongs to its harness; Pi qualifies its models by provider. */
function piModel(model: { providerID: string; modelID: string }) {
  const slash = model.modelID.indexOf("/")
  if (model.providerID !== "pi" || slash < 1 || slash === model.modelID.length - 1) {
    throw new Error("Pi requires a pi model key with a provider/model ID")
  }
  return { providerID: model.modelID.slice(0, slash), modelID: model.modelID.slice(slash + 1) }
}
