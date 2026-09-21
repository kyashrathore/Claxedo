import {
  assertPiProvidersBindable,
  piProviderOverrides,
  piSpawnEnv,
  retainPiAuth,
  type PiProviderOverrides,
} from "./auth"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { observeAgentProcess } from "../../process-observer"
import { createEvaluatedGoalResource } from "../shared/evaluated-goal-resource"
import { harnessSpawnEnv } from "../shared/spawn-env"
import { GOAL_PROMPT_TEXT, goalEvaluatorRequest, parseGoalEvaluation } from "../shared/goal-protocol"
import path from "node:path"
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
import { ensurePiTitleExtension, generatePiTitle, setPiSessionName } from "./title-extension"
import type { SessionTitleRequest } from "../../title-generation"
import { cleanupFromRetirement, createTurnStop, createTurnStopRecord } from "../shared/cancellation-facts"
import { controlRequestDeadline, modelRequestDeadline } from "../shared/request-deadline"
import { RecoveryCodedError, retirementSettled, volatileLaunchOwnership, type LaunchOwnershipStore, type RetirementResult } from "../../launch"

export type PiDriverOptions = {
  binary?: string
  agentDir: string
  idleMs?: number
  /** Durable launch records, so a Pi process outliving this one stays a recoverable owner. */
  ownership?: LaunchOwnershipStore
  /** The workspace a later owner reconciles this driver's launches under. */
  workspaceId?: string
}
type Entry = {
  process: PiRpcProcess
  directory: string
  busy: boolean
  idleGeneration: number
  idle?: ReturnType<typeof setTimeout>
  /** Set when a retirement did not establish that this launch stopped. */
  retiring?: RetirementResult
}

function unresolvedPiLaunch(result: RetirementResult) {
  return new RecoveryCodedError(
    result.error?.code ?? "exit_unverified",
    `A Pi process this driver launched was not established as stopped (leader ${result.leader}, group ${result.descendants})${result.error ? `: ${result.error.message}` : ""}`,
  )
}

export function createPiRpcDriver(host: SdkRuntimeDriverHost, options: PiDriverOptions): SdkRuntimeDriver {
  return new PiRpcDriver(host, options)
}

export class PiRpcDriver implements SdkRuntimeDriver {
  readonly type = "pi" as const
  // `--append-system-prompt` is a spawn flag, and `ensure` respawns a reaped
  // session with `--session <file>` alone, so a block given at create is gone
  // the first time the process is reaped. The per-turn message carries it.
  readonly instructionChannel = "prompt-prefix" as const
  readonly interactions = { permissions: false, questions: true } as const
  readonly goals
  private evaluators = 0
  private readonly goalController
  private projectedProviders?: PiProviderOverrides
  private auth: Record<string, ProviderProjection> | undefined
  private entries = new Map<string, Entry>()
  private models: SdkModelEntry[] = []
  private thinking: string[] = []
  private selectedThinking = "off"
  private processError?: string
  /** Retirements that did not establish an exit; they defer the auth profile's release. */
  private readonly blockers = new Map<string, RetirementResult>()
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
          // Print mode builds its prompt from piped stdin, so the request
          // crosses on the pipe; argv would put the objective and the work
          // result in the process list for every local user.
          child.stdin?.on("error", () => {
            // EPIPE only means the evaluator exited before reading; the
            // execFile callback already reports that exit.
          })
          child.stdin?.end(goalEvaluatorRequest(request))
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
    this.agentDir = options.agentDir
    this.authProfile = retainPiAuth(this.agentDir)
  }
  async applyConfig(config: Record<string, unknown>) {
    const auth = providerProjectionRecord(config.auth, {}, { onInvalid: "reject" })
    if (config.auth !== undefined && !auth) {
      throw new Error("pi harness received an auth map that is not provider projections")
    }
    this.auth = auth
    // A brokered account reaches Pi as a `models.json` overlay, never as a key
    // in the environment or in `auth.json`; both files are scrubbed when the
    // last adapter sharing the profile is disposed.
    const providers = piProviderOverrides(this.auth)
    if (JSON.stringify(providers) !== JSON.stringify(this.projectedProviders)) {
      if (this.evaluators || [...this.entries.values()].some((entry) => entry.busy))
        throw new Error("Cannot rotate Pi credentials during an active turn")
      this.closeProcesses()
      await this.authProfile.write(providers)
      this.projectedProviders = providers
      this.models = []
    }
  }

  createRuntime(threadId: string) {
    return createAgentEventRuntime({ harness: "pi", threadId, adapter: piRpcAdapter() })
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...piSpawnEnv(harnessSpawnEnv(process.env), this.auth),
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
    const titleExtension = await ensurePiTitleExtension(this.agentDir)
    const process = await PiRpcProcess.start({
      binary,
      directory,
      args: ["--mode", "rpc", "--session-dir", path.join(this.agentDir, "sessions"), "-e", titleExtension, ...args],
      env: this.environment(),
      observer: this.host.processObserver,
      // A composition that gave this driver no store still gets a launch
      // record; it just cannot be reconciled after a restart, which is what
      // volatile ownership says about itself.
      ownership: this.options.ownership ?? volatileLaunchOwnership(),
      // Empty when the composition named no workspace: a launch nobody will
      // reconcile is worth saying so, and inventing an id would hide it.
      workspaceId: this.options.workspaceId ?? "",
    })
    try {
      await process.request("get_state", {}, controlRequestDeadline())
      return process
    } catch (error) {
      this.recordUnresolved(`start:${randomUUID()}`, await process.dispose())
      throw error
    }
  }
  async createAgentSession(input: { directory: string; title?: string; model: string }) {
    const process = await this.start(input.directory, [
      ...(input.model ? ["--model", input.model] : []),
      ...(input.title ? ["--name", input.title] : []),
    ], input.model)
    try {
      const state = record(await process.request("get_state", {}, controlRequestDeadline()))
      const id = text(state?.sessionId)
      if (!id) throw new Error("Pi did not return its native session id")
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
  async generateTitle(input: { agentSessionId: string; request: SessionTitleRequest }) {
    const entry = await this.ensure(input.agentSessionId, input.request.directory)
    if (entry.busy) return null
    this.reap(input.agentSessionId, entry)
    return await generatePiTitle(entry.process, input.request)
  }
  /** Only a live process is renamed: a reaped session's name lives on in the Claxedo store, and is not worth a respawn. */
  async setAgentSessionTitle(input: { agentSessionId: string; title: string }) {
    const entry = this.entries.get(input.agentSessionId)
    if (!entry || entry.busy || !entry.process.alive) return
    await setPiSessionName(entry.process, input.title)
  }
  private remember(id: string, process: PiRpcProcess, directory: string) {
    const entry: Entry = { process, directory, busy: false, idleGeneration: 0 }
    this.entries.set(id, entry)
    // A leader exit is not the end of what this launch started. The entry is
    // dropped only once retirement establishes that its group went with it.
    process.onExit((error) => {
      if (entry.busy) this.processError = error.message
      void this.retire(id, entry)
    })
    this.reap(id, entry)
    return entry
  }

  /**
   * Retires one Pi launch and forgets it only on evidence that it stopped. An
   * unresolved retirement is retained on its entry, which refuses the session
   * a replacement process and blocks the shared auth profile's release.
   */
  private async retire(id: string, entry: Entry): Promise<RetirementResult> {
    if (entry.idle) clearTimeout(entry.idle)
    const result = await entry.process.dispose()
    if (retirementSettled(result)) {
      if (this.entries.get(id) === entry) this.entries.delete(id)
      delete entry.retiring
      // A retirement result is a snapshot and never becomes settled on its
      // own, so the blocker is dropped by the retirement that settled it —
      // this one — and the release it deferred is retried here.
      this.blockers.delete(id)
      await this.releaseWhenUnblocked()
      return result
    }
    entry.retiring = result
    this.recordUnresolved(id, result)
    return result
  }

  /**
   * Keyed by the launch it describes, so a later retirement of the same launch
   * can drop it. Kept apart from `processError`, which is this driver's record
   * of a process dying under a turn: an unresolved retirement is a different
   * state with a different remedy, and `readRuntimeHealth` reports it first.
   */
  private recordUnresolved(id: string, result: RetirementResult) {
    if (retirementSettled(result)) return
    this.blockers.set(id, result)
  }
  private reap(sessionId: string, entry: Entry) {
    const generation = ++entry.idleGeneration
    if (entry.idle) clearTimeout(entry.idle)
    if (entry.busy) return
    const current = () => generation === entry.idleGeneration && !entry.busy && entry.process.alive
    entry.idle = setTimeout(() => {
      // Pi defers writing its session until the first assistant message. Keep a new session alive.
      void entry.process
        .request("get_state", {}, controlRequestDeadline())
        .then(async (value) => {
          const file = text(record(value)?.sessionFile)
          const persisted =
            file &&
            (await fs.stat(file).then(
              () => true,
              () => false,
            ))
          if (!current()) return
          if (persisted) await this.retire(sessionId, entry)
          else this.reap(sessionId, entry)
        })
        .catch(async () => {
          if (current()) await this.retire(sessionId, entry)
        })
    }, this.options.idleMs ?? 60_000)
    entry.idle.unref()
  }
  private async ensure(id: string, directory: string) {
    const entry = this.entries.get(id)
    if (entry) {
      if (entry.retiring) throw unresolvedPiLaunch(entry.retiring)
      if (entry.directory !== directory) throw new Error("Pi native session directory mismatch")
      return entry
    }
    // Never let an unknown session identifier cause Pi to create a fresh session.
    const files = await fs.readdir(path.join(this.agentDir, "sessions"))
    const filename = files.find((name) => name.endsWith(`_${id}.jsonl`))
    if (!filename) throw new Error(`Pi session file is missing for ${id}`)
    const process = await this.start(directory, ["--session", path.join(this.agentDir, "sessions", filename)])
    try {
      const state = record(await process.request("get_state", {}, controlRequestDeadline()))
      if (state?.sessionId !== id) throw new Error("Pi resumed a different session")
      return this.remember(id, process, directory)
    } catch (error) {
      this.recordUnresolved(id, await process.dispose())
      throw error
    }
  }
  async runTurn(input: SdkRuntimeTurnInput) {
    const agentSessionId = input.getAgentSessionId()
    const entry = await this.ensure(agentSessionId, input.directory)
    if (entry.busy) throw new Error("Pi already has an active turn")
    entry.busy = true
    this.reap(agentSessionId, entry)
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
    const stops = createTurnStopRecord()
    const onTurnAbort = () => { void abort() }
    // One attempt at a time, and a rejected one is evidence rather than a
    // memoised answer: a stop that never reached Pi established nothing, so a
    // later caller gets a new request instead of the old rejection.
    const abort = createTurnStop(stops, "provider_unreachable", async (deadline) => {
      cancelling = settled
      try {
        for (const id of questionIds) this.host.pendingQuestions.get(id)?.reject()
        await process.request("clear_queue", {}, controlRequestDeadline(deadline))
        await process.request("abort", {}, controlRequestDeadline(deadline))
        finish()
      } catch (error) {
        // Pi refused or never answered the cancel, so the only remaining
        // authority over this turn is the launch it runs in.
        stops.cleanup = cleanupFromRetirement(await this.retire(agentSessionId, entry))
        fail(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    })
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
        stops,
        steer: async (steered) => {
          const steeredImages = piImageContents(steered.parts)
          await process.request("steer", {
            message: extractTextFromParts(steered.parts),
            ...(steeredImages.length ? { images: steeredImages } : {}),
          }, controlRequestDeadline())
          return { ok: true as const }
        },
      })
      input.abort.signal.addEventListener("abort", onTurnAbort, { once: true })
      if (input.abort.signal.aborted) {
        abort()
        await settled
        return
      }
      if (!input.input.model) throw new Error("Pi turn requires a resolved model")
      const model = piModel(input.input.model)
      await process.request("set_model", { provider: model.providerID, modelId: model.modelID }, controlRequestDeadline())
      if (input.input.variant) await process.request("set_thinking_level", { level: input.input.variant }, controlRequestDeadline())
      if (input.abort.signal.aborted) {
        await settled
        return
      }
      const images = piImageContents(input.input.parts)
      await process.request("prompt", {
        message: [input.input.system, extractTextFromParts(input.input.parts)].filter(Boolean).join("\n\n"),
        ...(images.length ? { images } : {}),
      }, modelRequestDeadline())
      await settled
    } catch (error) {
      // Losing an acknowledgement does not authorize replay; retire this launch
      // before another turn may be admitted on the session.
      stops.cleanup = cleanupFromRetirement(await this.retire(agentSessionId, entry))
      throw error
    } finally {
      await cancelling
      removeEvent()
      removeExit()
      input.abort.signal.removeEventListener("abort", onTurnAbort)
      for (const id of questionIds) this.host.pendingQuestions.delete(id)
      entry.busy = false
      if (process.alive) this.reap(agentSessionId, entry)
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
      const result = record(await probe.request("get_available_models", {}, controlRequestDeadline()))
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
        }, controlRequestDeadline())
      }
      const levels = record(await probe.request("get_available_thinking_levels", {}, controlRequestDeadline()))
      this.thinking = Array.isArray(levels?.levels)
        ? levels.levels.filter((value): value is string => typeof value === "string")
        : []
      const state = record(await probe.request("get_state", {}, controlRequestDeadline()))
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
    const blocker = [...this.blockers.values()].at(-1)
    if (blocker) return {
      status: "unavailable" as const,
      reason: "harness_retirement_unresolved" as const,
      message: unresolvedPiLaunch(blocker).message,
    }
    return this.processError
      ? { status: "degraded" as const, reason: "harness_process_lost" as const, message: this.processError }
      : { status: "ok" as const }
  }
  async deleteAgentSession(_sessionId: string, agentSessionId: string) {
    const entry = this.entries.get(agentSessionId)
    if (entry) await this.retire(agentSessionId, entry)
  }
  /**
   * The shared auth profile is scrubbed only once every launch under it has
   * been established as stopped. Releasing it over an unresolved Pi process
   * would pull that process's credentials out from under work still running.
   */
  async dispose() {
    await this.goalController.dispose()
    await this.closeProcesses()
    await this.releaseWhenUnblocked()
  }
  private async closeProcesses() {
    const retiring = [...this.entries].map(([sessionId, entry]) => this.retire(sessionId, entry))
    const results = await Promise.all(retiring)
    for (const [sessionId, entry] of [...this.entries]) {
      if (!entry.retiring) this.entries.delete(sessionId)
    }
    return results
  }

  /** Retirements that never established an exit, and the auth release they hold. */
  retirementBlockers(): readonly RetirementResult[] {
    return [...this.blockers.values()]
  }

  /**
   * Re-reads the retirements that deferred the auth profile's release and
   * drops the ones a later retirement settled. A profile held open forever
   * because one process could not be established as stopped is a leak of the
   * credentials it holds, not containment.
   */
  private async releaseWhenUnblocked() {
    if (this.blockers.size) return false
    await this.authProfile.release()
    return true
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
