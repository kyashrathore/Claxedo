// Send-phase glue: wait for a still-provisioning worktree, fire the dispatch,
// and roll back if anything throws. Owns the pending prompt entry for the
// lifetime of one send.
import { asRecord, readField } from "@/lib/record"
import { Worktree as WorktreeState } from "@/platform/sync/worktree"
import { dispatchPrompt } from "./dispatch"
import { clearPendingPrompt, hasPendingPrompt, markPendingPromptSent, registerPendingPrompt } from "../store/pending-prompt-registry"
import { setPromptSessionStatus } from "./pending"
import type {
  RollbackPromptDispatchContext,
  SendPromptRequestContext,
  WaitForPendingWorktreeContext,
} from "./types"

const LIVE_EVENT_READY_TIMEOUT_MS = 1_500
const PROMPT_ADMISSION_CONFLICT_CODE = "session_turn_in_progress"

export async function waitForPendingWorktree(input: WaitForPendingWorktreeContext) {
  const worktree = WorktreeState.get(input.sessionDirectory)
  if (worktree?.status === "failed") throw new Error(worktree.message)
  if (!worktree || worktree.status !== "pending") return true

  input.onPending()

  const controller = new AbortController()
  registerPendingPrompt(input.sessionID, { abort: controller, cleanup: input.onAbortCleanup })

  const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
    if (controller.signal.aborted) {
      resolve({ status: "failed", message: "aborted" })
      return
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve({ status: "failed", message: "aborted" })
      },
      { once: true },
    )
  })

  const timer = { id: undefined as number | undefined }
  const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
    timer.id = window.setTimeout(() => {
      resolve({
        status: "failed",
        message: input.timeoutMessage,
      })
    }, 5 * 60 * 1000)
  })

  const result = await Promise.race([WorktreeState.wait(input.sessionDirectory), abortWait, timeout]).finally(() => {
    if (timer.id === undefined) return
    clearTimeout(timer.id)
  })
  clearPendingPrompt(input.sessionID)
  if (controller.signal.aborted) return false
  if (result.status === "failed") throw new Error(result.message)
  return true
}

export function rollbackPromptDispatch(input: RollbackPromptDispatchContext) {
  clearPendingPrompt(input.sessionID)
  const admissionConflict = isPromptAdmissionConflict(input.err)
  if (!admissionConflict) setPromptSessionStatus({ sessionID: input.sessionID, status: { type: "idle" } })
  input.clearBoot()
  if (!admissionConflict) input.reportCloudStartupError(input.err)
  input.showSendFailed(input.err)
  input.removeSubmittedPrompt()
  input.restoreSubmittedComments()
  input.restoreInput()
}

export function isPromptAdmissionConflict(error: unknown) {
  const record = asRecord(error)
  if (record?.code === PROMPT_ADMISSION_CONFLICT_CODE) return true
  const data = asRecord(record?.data)
  if (data?.code === PROMPT_ADMISSION_CONFLICT_CODE) return true
  const candidates = [record?.responseBody, record?.message]
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false
    try {
      return readField(asRecord(JSON.parse(candidate))?.error, "code") === PROMPT_ADMISSION_CONFLICT_CODE
    } catch {
      return false
    }
  })
}

async function prepareLiveEventsBestEffort(run: SendPromptRequestContext["prepareLiveEvents"]) {
  if (!run) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.resolve(run()),
    new Promise<void>((resolve) => {
      timer = globalThis.setTimeout(resolve, LIVE_EVENT_READY_TIMEOUT_MS)
    }),
  ]).catch(() => undefined).finally(() => {
    if (timer !== undefined) globalThis.clearTimeout(timer)
  })
}

export async function sendPromptRequest(input: SendPromptRequestContext) {
  setPromptSessionStatus({
    sessionID: input.sessionID,
    status: { type: "busy" },
    refreshDirectory: input.refreshDirectory,
  })
  if (!(await input.waitForWorktree())) return
  const controller = new AbortController()
  registerPendingPrompt(input.sessionID, {
    abort: controller,
    cleanup: input.onAbortCleanup,
  })
  await prepareLiveEventsBestEffort(input.prepareLiveEvents)
  if (controller.signal.aborted) return
  markPendingPromptSent(input.sessionID)
  let claimedByStop = false
  try {
    await dispatchPrompt({
      client: input.client,
      payload: input.payload,
    })
  } finally {
    claimedByStop = !hasPendingPrompt(input.sessionID)
    clearPendingPrompt(input.sessionID)
  }
  // A prompt already on the wire keeps no abort handle, so Stop cannot reach
  // `controller` — it claims this session's entry and writes idle itself.
  // Re-asserting busy over that would put the control back on "stop" and arm a
  // fresh escalation ladder for a turn the user has already cancelled.
  if (!claimedByStop) setPromptSessionStatus({
    sessionID: input.sessionID,
    status: { type: "busy" },
    refreshDirectory: input.refreshDirectory,
  })
  input.clearBoot()
  await Promise.resolve(input.reconcileAfterDispatch?.()).catch(() => undefined)
  input.clearCloudStartup()
}
