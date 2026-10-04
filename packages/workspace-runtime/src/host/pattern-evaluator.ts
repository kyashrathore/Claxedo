import { Worker } from "node:worker_threads"
import { ElicitationValidationError, type ElicitationPatternEvaluator } from "@claxedo/agent-runtime-contract"
import { evaluateNativeElicitationPatterns } from "@claxedo/agent-runtime-contract/elicitation-pattern-worker"

// Only trusted, self-contained evaluator code is serialized. Agent values travel
// exclusively as workerData; no pattern or response is interpolated into code.
const source = `const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage({ready:true});parentPort.postMessage({result:(${evaluateNativeElicitationPatterns.toString()})(workerData)});`
let active = 0

export function createElicitationPatternEvaluator(options: { executionMs?: number; startupMs?: number } = {}): ElicitationPatternEvaluator {
  return async (checks, signal) => {
    if (signal?.aborted) throw new ElicitationValidationError("validation_cancelled", "Form validation was cancelled")
    if (active >= 2) throw new ElicitationValidationError("validation_busy", "Form validation is busy; try again")
    active++
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        worker = new Worker(source, { eval: true, workerData: checks, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } })
        let ready = false
        const fail = (code: "validation_timeout" | "validation_unavailable" | "validation_cancelled", message: string) => reject(new ElicitationValidationError(code, message))
        timer = setTimeout(() => fail("validation_unavailable", "Pattern validator did not start"), options.startupMs ?? 2000)
        abort = () => fail("validation_cancelled", "Form validation was cancelled")
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) abort()
        worker.on("message", (message: { ready?: boolean; result?: { code: "invalid_schema" | "invalid_answer"; message: string } | null }) => {
          if (message.ready === true && !ready) {
            ready = true
            clearTimeout(timer)
            timer = setTimeout(() => fail("validation_timeout", "Pattern validation timed out; edit the response or decline the question"), options.executionMs ?? 250)
          } else if (ready && "result" in message) {
            if (message.result) reject(new ElicitationValidationError(message.result.code, message.result.message))
            else resolve()
          }
        })
        worker.once("error", () => fail("validation_unavailable", "Pattern validator failed"))
        worker.once("exit", () => fail("validation_unavailable", "Pattern validator exited before completing"))
      })
    } catch (error) {
      if (error instanceof ElicitationValidationError) throw error
      throw new ElicitationValidationError("validation_unavailable", "Pattern validator could not start")
    } finally {
      if (timer) clearTimeout(timer)
      if (abort) signal?.removeEventListener("abort", abort)
      if (worker) { worker.removeAllListeners(); await worker.terminate() }
      active--
    }
  }
}
