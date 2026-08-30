import type { StopReason } from "@agentclientprotocol/sdk"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { createAcpEventTranslator, translateStopReason } from "@claxedo/agent-event-runtime/harnesses/acp"
import {
  buildAssistantMessage,
  buildUserMessage,
  isTerminalCompatEvent,
  messageUpdated,
  permissionAsked,
  sessionError,
  sessionStatus,
  type CompatEvent,
} from "../../compat-events"
import type { AgentRuntimeStreamEvent, PromptInput } from "../../index"
import { firstTurnErrorData } from "../../first-turn-error"
import { Log } from "../../log"
import { recovering } from "../../status"
import { createTurnEventProjector } from "../shared/turn-projection"
import { createChildEventRouter } from "../shared/child-event-routing"
import { acpPermissionRequest } from "./permission-options"
import { ACPProcess, type SessionUpdate } from "./process"
import {
  errorMessage,
  messageUsage,
  missing,
  newSessionTimeoutMs,
  promptTimeoutMs,
  runtimeUsage,
} from "./helpers"
import { maybeAutoTitle } from "./title"
import { AcpProcessManager } from "./process-manager"

const log = Log.create({ service: "acp-turn-runner" })
const activePromptCounts = new Map<string, number>()
const activePromptWaiters = new Map<string, Set<() => void>>()

export function activeAcpPromptCount(harness: string) {
  return activePromptCounts.get(harness) ?? 0
}

function enterActivePrompt(harness: string) {
  activePromptCounts.set(harness, activeAcpPromptCount(harness) + 1)
  return () => {
    const next = activeAcpPromptCount(harness) - 1
    if (next > 0) {
      activePromptCounts.set(harness, next)
      return
    }
    activePromptCounts.delete(harness)
    for (const resolve of activePromptWaiters.get(harness) ?? []) resolve()
    activePromptWaiters.delete(harness)
  }
}

export function waitForNoActiveAcpPrompts(harness: string) {
  if (activeAcpPromptCount(harness) === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const waiters = activePromptWaiters.get(harness) ?? new Set<() => void>()
    waiters.add(resolve)
    activePromptWaiters.set(harness, waiters)
  })
}

function unrestorable(error: unknown) {
  return missing(error)
}

export abstract class AcpTurnRunner extends AcpProcessManager {
  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    const t0 = Date.now()
    log.info("sendMessage: start", { id, directory, partCount: input.parts.length })

    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      log.info("sendMessage: session already busy, rejecting duplicate", { id })
      yield sessionError("Session is already processing a message", id)
      return
    }
    const leaveActivePrompt = enterActivePrompt(this.harnessId())

    try {
      yield* this._sendMessage(id, input, directory, t0)
    } finally {
      leaveActivePrompt()
      leaveBusy()
    }
  }

  async *_sendMessage(id: string, input: PromptInput, directory: string, t0: number): AsyncIterable<AgentRuntimeStreamEvent> {
    const current = this.store.getAgentSessionId(id)
    if (!current) {
      log.error("sendMessage: session not found in DB", { id })
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    let agentSessionId = current
    const session = this.store.getSession(id) as { title?: string | null } | null
    let created = Date.now()
    log.info("sendMessage: found session in store", { id, agentSessionId })
    if (input.model?.modelID) {
      const nextModel = input.model.modelID === "default" ? "" : input.model.modelID
      if ((this.currentModel || "") !== nextModel) this.setModel(nextModel)
    }

    let proc: ACPProcess
    let fresh = false
    try {
      const result = await this.getOrSpawnProcess(id, directory)
      proc = result.proc
      fresh = result.isNew
    } catch (err) {
      log.error("sendMessage: failed to get/spawn ACP process", { err, directory })
      yield sessionError(`Failed to start ACP process: ${err}`, id)
      return
    }
    const processKey = this.sessionProcessMap().get(id) ?? this.keyForSession(id, directory)
    if (this.store.getSessionOwnerKey && this.store.getSessionOwnerKey(id) !== processKey) {
      this.store.bindSession({
        sessionId: id,
        directory,
        title: session?.title ?? undefined,
        agentSessionId,
        ownerKey: processKey,
      })
    }

    log.info("sendMessage: got ACP process, starting prompt", {
      directory,
      binary: this.options.binary,
      agentSessionId,
      msToHere: Date.now() - t0,
    })

    const recover = this.store.consumeRecoveryError(id)
    const queue = this.startTurnEvents(id, agentSessionId, directory, created, input, recover)
    let promptDone = false
    let promptError: string | null = null
    let promptPromise: Promise<void> = Promise.resolve()
    const resolvers: Array<() => void> = []
    let chunkCount = 0
    let assistantMsgId = input.assistantMessageId
    let drainTurn!: (err: Error) => void
    let drained = false
    const drainPromise = new Promise<never>((_, reject) => {
      drainTurn = reject
    })
    drainPromise.catch(() => {})
    const drain = (message: string) => {
      if (drained) return
      drained = true
      promptError = message
      promptDone = true
      proc.cancel(agentSessionId).catch(() => {})
      this.invalidateProcess(processKey, message, proc)
      for (const r of resolvers.splice(0)) r()
      drainTurn(new Error(message))
    }
    const turn = { drain }
    this.lifecycle().set(id, turn)
    const eventRuntime = createAgentEventRuntime({
      harness: this.harnessId(),
      threadId: agentSessionId,
      adapter: createAcpEventTranslator({ client: this.harnessId() }),
    })

    const push = (event: CompatEvent) => {
      chunkCount++
      log.info("sendMessage: pushing chunk to stream", {
        chunkType: event.type,
        chunkN: chunkCount,
        msFromStart: Date.now() - t0,
      })
      queue.push(event)
      for (const r of resolvers.splice(0)) r()
    }
    const parentProjector = createTurnEventProjector({
      store: this.store,
      owner: {
        sessionId: id,
        getAgentSessionId: () => agentSessionId,
      },
      directory,
      input,
      assistantMessageId: assistantMsgId,
      created,
      onEvent: push,
      onRuntimeEvent: this.options.eventHub?.publishRuntime,
    })
    const router = createChildEventRouter({
      parent: parentProjector,
      createChildProjector: (target) => createTurnEventProjector({
        store: this.store,
        owner: {
          sessionId: target.sessionId,
          getAgentSessionId: target.getAgentSessionId,
        },
        directory,
        input: target.input,
        assistantMessageId: target.assistantMessageId,
        created: target.created,
        onEvent: () => {},
        onRuntimeEvent: this.options.eventHub?.publishRuntime,
      }),
      onDiagnostic: (payload) => this.options.eventHub?.publishRuntime({
        directory,
        sessionId: id,
        agentSessionId,
        assistantMessageId: input.assistantMessageId,
        payload,
      }),
    })
    const wait = () =>
      new Promise<void>((resolve) => {
        if (queue.length > 0 || promptDone) resolve()
        else resolvers.push(resolve)
      })

    const bound = async <T>(label: string, run: Promise<T>, timeoutMs?: number) => {
      let id: ReturnType<typeof setTimeout> | undefined
      const ms = timeoutMs ?? newSessionTimeoutMs()
      try {
        return await Promise.race([
          run,
          drainPromise,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    const replace = async () => {
      log.info("sendMessage: ACP session missing, creating replacement session", {
        id,
        oldAgentSessionId: agentSessionId,
      })
      agentSessionId = await this.boot(proc, directory, session?.title ?? undefined)
      this.store.bindSession({
        sessionId: id,
        directory,
        title: session?.title ?? undefined,
        agentSessionId,
        ownerKey: this.keyForSession(id, directory),
      })
    }

    try {
      if (fresh) {
        log.info("sendMessage: process is freshly spawned, restoring ACP session", {
          id,
          agentSessionId,
        })
        try {
          await bound("ACP resume", proc.resumeSession(agentSessionId, directory))
        } catch (err) {
          if (!unrestorable(err)) throw err
          await replace()
        }
      }
      if (input.permissionMode) {
        const applied = await bound("ACP permission mode", proc.setPermissionMode(agentSessionId, input.permissionMode))
        if (applied.currentModeId !== input.permissionMode) {
          throw new Error(`ACP kept permission mode ${applied.currentModeId ?? "unknown"} instead of ${input.permissionMode}`)
        }
      }
      try {
        await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
      } catch (err) {
        if (!unrestorable(err)) throw err
        await replace()
        await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
      }
    } catch (err) {
      promptError = errorMessage(err)
      proc.cancel(agentSessionId).catch(() => {})
      this.invalidateProcess(processKey, promptError, proc)
      promptDone = true
      for (const r of resolvers.splice(0)) r()
    }

    if (!promptError) {
      const forward = (update: SessionUpdate) => {
        const result = eventRuntime.ingest({
          source: "acp.jsonrpc",
          method: "session/update",
          payload: update,
        })
        for (const runtimeEvent of result.events) {
          router.project(runtimeEvent, {
            dir: "in",
            method: "sessionUpdate",
            frame: update,
          }, { kind: "parent" })
          if (runtimeEvent.type !== "step-start") continue
          assistantMsgId = router.assistantMessageId()
          created = router.created()
        }
      }
      const install = () => {
        proc.permissionPushers.set(agentSessionId, ({ permId, tool, kind, paths }) => {
          log.info("sendMessage: forwarding permission-request to stream", { permId, tool, kind })
          this.permissionOwnerMap().set(permId, proc)
          const event = permissionAsked(
            acpPermissionRequest({ permId, sessionId: id, tool, kind, paths }),
          )
          this.store.appendEvent({
            sessionId: id,
            agentSessionId,
            payload: event,
            source: {
              dir: "in",
              method: "requestPermission",
              frame: { tool, paths },
            },
          })
          push(event)
        })
      }
      const stop = (stopReason: StopReason) => {
        log.info("sendMessage: prompt resolved", { stopReason, ms: Date.now() - t0 })
        for (const runtimeEvent of translateStopReason(stopReason as Parameters<typeof translateStopReason>[0], id)) {
          router.project(runtimeEvent, {
            dir: "in",
            method: "prompt.stop",
            frame: { stopReason },
          })
        }
      }
      let retried = false
      const run = async (): Promise<void> => {
        install()
        try {
          // The PROMPT turn runs for as long as the model thinks/streams — it
          // must use the prompt timeout (5 min default), NOT the 10s
          // new-session handshake timeout, which cancelled every turn slower
          // than 10s.
          const result = await bound("ACP prompt", proc.prompt(agentSessionId, input, forward), promptTimeoutMs())
          // Prompt-result usage is the ONLY meterable usage on this rail:
          // mid-turn `usage_update` notifications carry a context meter, not
          // token categories. The ACP agent is authoritative for the final
          // per-turn usage payload.
          const usableUsage = hasMeteredUsage(result.usage)
          if (!usableUsage && isCompletedStopReason(result.stopReason)) {
            router.project({
              type: "diagnostic",
              diagnostic: {
                code: "acp_prompt_usage_missing",
                message: `ACP agent returned no token usage for a completed turn (stopReason: ${result.stopReason}); the turn meters as unavailable`,
                severity: "warn",
                source: "acp-adapter",
              },
            }, {
              dir: "in",
              method: "prompt.result.usage",
              frame: { stopReason: result.stopReason },
            })
          }
          if (result.usage && usableUsage) {
            router.project(runtimeUsage(result.usage, agentSessionId), {
              dir: "in",
              method: "prompt.result.usage",
              frame: { usage: result.usage },
            })
            const event = messageUpdated({
              ...buildAssistantMessage({
                id: assistantMsgId,
                sessionID: id,
                parentID: input.userMessageId ?? id,
                agent: input.agent,
                model: input.model,
                directory,
                created,
                completed: Date.now(),
                variant: input.variant,
              }),
              tokens: messageUsage(result.usage),
            })
            this.store.appendEvent({
              sessionId: id,
              agentSessionId,
              payload: event,
              source: {
                dir: "in",
                method: "prompt.result",
                frame: { usage: result.usage },
              },
            })
            push(event)
          }
          stop(result.stopReason)
        } catch (err) {
          proc.permissionPushers.delete(agentSessionId)
          if (retried || !missing(err)) throw err
          retried = true
          await replace()
          await bound("ACP sync", proc.syncSession(agentSessionId, input, { syncMode: false }))
          return run()
        }
      }
      promptPromise = Promise.race([run(), drainPromise])
      .catch((err: unknown) => {
        log.error("sendMessage: prompt rejected", { err, ms: Date.now() - t0 })
        promptError = errorMessage(err)
        proc.cancel(agentSessionId).catch(() => {})
        this.invalidateProcess(processKey, promptError, proc)
      })
      .finally(() => {
        proc.permissionPushers.delete(agentSessionId)
        promptDone = true
        for (const r of resolvers.splice(0)) r()
      })
    }

    let titleEmitted = false
    try {
      while (true) {
        await wait()
        let event: CompatEvent | undefined
        while ((event = queue.shift())) {
          // Before yielding session.idle, emit auto-title if needed
          if (event.type === "session.idle" && !titleEmitted) {
            titleEmitted = true
            const titleEvent = maybeAutoTitle({
              store: this.store,
              eventHub: this.options.eventHub,
              getOrSpawnProcess: (sessionId, workdir) => this.getOrSpawnProcess(sessionId, workdir),
              boot: (proc, workdir, title) => this.boot(proc, workdir, title),
            }, id, agentSessionId, directory, input.parts)
            if (titleEvent) yield titleEvent
          }
          yield event
          if (isTerminalCompatEvent(event)) {
            log.info("sendMessage: terminal chunk yielded, returning", {
              chunkType: event.type,
              totalChunks: chunkCount,
              ms: Date.now() - t0,
            })
          }
        }
        if (promptDone) break
      }
    } finally {
      await promptPromise
      router.dispose()
      this.lifecycle().delete(id, turn)
    }

    if (promptError) {
      log.error("sendMessage: ending with error", { promptError, ms: Date.now() - t0 })
      for (const event of router.terminalizeParent(promptError, {
        dir: "in",
        method: "prompt.error.open-tools",
        frame: { message: promptError },
      })) yield event
      const updated = messageUpdated(buildAssistantMessage({
        id: assistantMsgId,
        sessionID: id,
        parentID: input.userMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created,
        completed: Date.now(),
        error: {
          name: "UnknownError",
          data: firstTurnErrorData(promptError),
        },
        variant: input.variant,
      }))
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: updated,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield updated
      const event = sessionError(promptError, id)
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: event,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield event
      return
    }

    log.info("sendMessage: finished successfully", { totalChunks: chunkCount, ms: Date.now() - t0 })
  }

  private startTurnEvents(
    sessionId: string,
    agentSessionId: string,
    directory: string,
    created: number,
    input: PromptInput,
    recoveryMessage: string | null | undefined,
  ): CompatEvent[] {
    const start: CompatEvent[] = [
      sessionStatus(sessionId, recoveryMessage ? recovering(recoveryMessage) : { type: "busy" }),
      ...(input.userMessageId ? [messageUpdated(buildUserMessage({
        id: input.userMessageId,
        sessionID: sessionId,
        agent: input.agent,
        model: input.model,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      }))] : []),
      messageUpdated(buildAssistantMessage({
        id: input.assistantMessageId,
        sessionID: sessionId,
        parentID: input.userMessageId ?? sessionId,
        agent: input.agent,
        model: input.model,
        directory,
        created,
      })),
    ]
    const committed = this.store.startTurn({
      sessionId,
      agentSessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      agent: input.agent,
      model: input.model,
      parts: input.parts,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })
    return [
      ...(recoveryMessage ? [start[0]!] : []),
      ...committed.events.filter((event) => !recoveryMessage || event.type !== "session.status"),
    ]
  }
}

function hasMeteredUsage(usage: {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
} | null | undefined) {
  if (!usage) return false
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0 ||
    (usage.thoughtTokens ?? 0) > 0 || (usage.cachedReadTokens ?? 0) > 0 || (usage.cachedWriteTokens ?? 0) > 0
}

function isCompletedStopReason(reason: StopReason) {
  return reason === "end_turn" || reason === "max_tokens" || reason === "max_turn_requests"
}
