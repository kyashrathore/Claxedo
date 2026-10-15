import { TurnAuthorityError } from "./turn-delivery"

/** Fast wakes measured 11–25 s server-side; a tool call holds this long so most run on the start they began. */
const TOOL_CALL_START_WAIT_MS = 20_000
const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 1_000

const ASLEEP = "The workspace machine is asleep. A tool call starts it."

/** The workspace machine is not running; the message is the tool's result, read by the model and the person alike. */
export class WorkspaceMachineUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceMachineUnavailableError"
  }
}

function startingMessage(input: { started: boolean; sinceStartMs: number; waits: boolean }): string {
  const seconds = Math.round(input.sinceStartMs / 1_000)
  const progress = seconds >= 1 ? `still starting (${seconds} s so far)` : "starting now"
  const state = input.started ? `The workspace machine was asleep. This tool call started it; it is ${progress}.` : `The workspace machine is ${progress}.`
  return input.waits ? `${state} Call this tool again: the call waits up to ${TOOL_CALL_START_WAIT_MS / 1_000} s for the machine to come up.` : state
}

function refusedMachine(error: TurnAuthorityError): WorkspaceMachineUnavailableError | undefined {
  if (error.code === "cloud_runtime_unavailable") return new WorkspaceMachineUnavailableError(ASLEEP)
  if (error.code !== "cloud_runtime_start_refused") return undefined
  const reason = (error.refusal.message ?? "The workspace machine could not start").replace(/\.$/, "")
  const retryAfterMs = error.refusal.retryAfterMs
  const retry = retryAfterMs === undefined ? "" : ` It can be tried again in about ${Math.max(1, Math.round(retryAfterMs / 1_000))} s.`
  return new WorkspaceMachineUnavailableError(`${reason}.${retry}`)
}

function sleepRejectingOnAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve() }, ms)
    const aborted = () => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener("abort", aborted, { once: true })
  })
}

/**
 * The machine access `ask` answers, through the control plane's refusals: a
 * machine that is not running, or whose start was refused, is the tool's
 * result at once. One that is starting is asked for again when the start says
 * its next answer can differ, for as long as that falls within a waiting tool
 * call's hold; past it, the result says whether this call started it and how
 * long the start has run.
 */
export async function workspaceMachineAccess<T>(ask: () => Promise<T>, options: { wait: boolean; signal?: AbortSignal }): Promise<T> {
  const askedAt = Date.now()
  let started = false
  for (;;) {
    let refusal: TurnAuthorityError
    try {
      return await ask()
    } catch (error) {
      if (!(error instanceof TurnAuthorityError)) throw error
      if (error.code !== "cloud_runtime_starting") throw refusedMachine(error) ?? error
      refusal = error
    }
    started ||= refusal.refusal.started === true
    const waited = Date.now() - askedAt
    const next = Math.max(MIN_RETRY_MS, refusal.refusal.retryAfterMs ?? DEFAULT_RETRY_MS)
    if (!options.wait || waited + next > TOOL_CALL_START_WAIT_MS) {
      throw new WorkspaceMachineUnavailableError(startingMessage({ started, sinceStartMs: refusal.refusal.sinceStartMs ?? waited, waits: options.wait }))
    }
    await sleepRejectingOnAbort(next, options.signal)
  }
}

export function machineFailureText(error: unknown): string {
  return error instanceof WorkspaceMachineUnavailableError ? error.message : String(error)
}
