import { Worker } from "node:worker_threads"
import { ElicitationValidationError } from "@claxedo/agent-runtime-contract"
import { evaluateNativeElicitationPatterns } from "@claxedo/agent-runtime-contract/elicitation-pattern-worker"
import type { HarnessServices } from "@claxedo/harness/contract"
import type { LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "./first-party-mcp"
import { createSpawnService } from "./spawn-service"
import type { WorkspaceTranscriptRoutesOptions } from "./workspace/core"

type ServiceInputs = {
  ownership: LaunchOwnershipStore
  transcripts: WorkspaceTranscriptRoutesOptions
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
  log: HarnessServices["log"]
  clock: HarnessServices["clock"]
}

const patternWorkerSource = `const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ready:true});parentPort.postMessage({result:(${evaluateNativeElicitationPatterns.toString()})(workerData)});`

function boundedPatternEvaluator(): HarnessServices["patternEvaluator"] {
  let active = 0
  return async (checks, signal) => {
    if (signal?.aborted) throw new ElicitationValidationError("validation_cancelled", "Form validation was cancelled")
    if (active >= 2) throw new ElicitationValidationError("validation_busy", "Form validation is busy; try again")
    active++
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        worker = new Worker(patternWorkerSource, { eval: true, workerData: checks, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } })
        let ready = false
        const fail = (code: "validation_timeout" | "validation_unavailable" | "validation_cancelled", message: string) =>
          reject(new ElicitationValidationError(code, message))
        timer = setTimeout(() => fail("validation_unavailable", "Pattern validator did not start"), 2_000)
        abort = () => fail("validation_cancelled", "Form validation was cancelled")
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
        worker.on("message", (message: { ready?: boolean; result?: { code: "invalid_schema" | "invalid_answer"; message: string } | null }) => {
          if (message.ready === true && !ready) {
            ready = true
            clearTimeout(timer)
            timer = setTimeout(() => fail("validation_timeout", "Pattern validation timed out; edit the response or decline the question"), 250)
          } else if (ready && "result" in message) {
            if (message.result) reject(new ElicitationValidationError(message.result.code, message.result.message))
            else resolve()
          }
        })
        worker.once("error", () => fail("validation_unavailable", "Pattern validator failed"))
        worker.once("exit", () => fail("validation_unavailable", "Pattern validator exited before completing"))
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (abort) signal?.removeEventListener("abort", abort)
      if (worker) { worker.removeAllListeners(); await worker.terminate() }
      active--
    }
  }
}

export function createHarnessServices(input: ServiceInputs): HarnessServices {
  const { workspaceId, resolver } = input.transcripts
  if (!resolver.register) throw new Error("Transcript resolver must support registration")
  const register = resolver.register.bind(resolver)
  return {
    spawn: createSpawnService(input.ownership),
    transcripts: {
      register: (request) => register({ workspaceId, ...request }),
      open: (request) => resolver.open({ workspaceId, ...request }),
    },
    firstPartyMcp(sessionId, locality) {
      if (locality !== "local" || !input.firstPartyMcpLaunch) return undefined
      const server = firstPartyMcpServerFor(input.firstPartyMcpLaunch, sessionId)
      return server ? { kind: "http", ...server } : undefined
    },
    patternEvaluator: boundedPatternEvaluator(),
    log: input.log,
    clock: input.clock,
  }
}
