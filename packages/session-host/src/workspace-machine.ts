import { TurnAuthorityError } from "./turn-delivery"

const STARTED = "The workspace machine was asleep. This tool call started it; it usually takes about a minute. Try this tool again in a few seconds."
const STARTING = "The workspace machine is starting; it usually takes about a minute. Try this tool again in a few seconds."
const ASLEEP = "The workspace machine is asleep. A tool call starts it."

/** The workspace machine is not running; the message is the tool's result, read by the model and the person alike. */
export class WorkspaceMachineUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceMachineUnavailableError"
  }
}

/** The control plane's refusal of a machine that is not running, as the tool that asked tells it; nothing for any other refusal. */
export function workspaceMachineUnavailable(error: unknown): WorkspaceMachineUnavailableError | undefined {
  if (!(error instanceof TurnAuthorityError)) return undefined
  if (error.code === "cloud_runtime_starting") return new WorkspaceMachineUnavailableError(error.refusal.started ? STARTED : STARTING)
  if (error.code === "cloud_runtime_unavailable") return new WorkspaceMachineUnavailableError(ASLEEP)
  if (error.code === "cloud_runtime_start_refused") {
    return new WorkspaceMachineUnavailableError(error.refusal.message ?? "The workspace machine could not start")
  }
  return undefined
}

export function machineFailureText(error: unknown): string {
  return error instanceof WorkspaceMachineUnavailableError ? error.message : String(error)
}
