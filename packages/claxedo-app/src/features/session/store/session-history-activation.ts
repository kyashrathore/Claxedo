import {
  FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  fastSessionSwitchNetworkQuiet,
  fastSessionSwitchQuietDelay,
} from "@/platform/runtime/session-switch"

export function createActivationSessionReadEpoch() {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    active: () => !controller.signal.aborted,
    abort: () => controller.abort(),
  }
}

export function firstFoldSessionHydrateDelay(input: {
  sessionID: string
  prefetched?: boolean
  now?: number
  baseDelay?: number
}) {
  if (input.prefetched === false) return input.baseDelay ?? 0
  return fastSessionSwitchQuietDelay({
    sessionId: input.sessionID,
    now: input.now,
    baseDelay: input.baseDelay ?? FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  })
}

export function shouldSkipSessionTransportHydrate(input: {
  sessionID: string
  force?: boolean
  before?: string
  bypassQuiet?: boolean
  now?: number
}) {
  if (input.force || input.before || input.bypassQuiet) return false
  return fastSessionSwitchNetworkQuiet({ sessionId: input.sessionID, now: input.now })
}

export function shouldDeferSessionTransportHydrate(input: {
  loading?: boolean
  force?: boolean
}) {
  return input.loading === true && input.force !== true
}

export function shouldAcceptSessionTransportResult(input: {
  expectedSessionID: string
  currentSessionID: string | undefined
  expectedDirectory?: string
  currentDirectory?: string
  expectedActivationEpoch?: number
  currentActivationEpoch?: number
}) {
  if (input.currentSessionID !== input.expectedSessionID) return false
  if (
    input.expectedDirectory !== undefined &&
    input.currentDirectory !== undefined &&
    input.currentDirectory !== input.expectedDirectory
  ) return false
  if (
    input.expectedActivationEpoch !== undefined &&
    input.currentActivationEpoch !== input.expectedActivationEpoch
  ) return false
  return true
}
