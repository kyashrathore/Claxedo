export const FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS = 900
export const FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS = 1_500
export const FAST_SESSION_SWITCH_INTENT_MS = 250
export const FAST_SESSION_SWITCH_NETWORK_QUIET_MS = 2_000

export type FastSessionSwitchWindow = {
  sessionId: string
  until: number
  networkQuietUntil?: number
}

type FastSessionSwitchGlobal = typeof window & {
  // owner: session switch race suppression; delete when query/cache writers carry activation epochs (Phase 1 IU-9 design 1).
  __claxedoFastSessionSwitch?: FastSessionSwitchWindow
}

function fastSessionSwitchGlobal(): FastSessionSwitchGlobal | undefined {
  return (
    (globalThis as typeof globalThis & { window?: FastSessionSwitchGlobal }).window ??
    // as-any: non-browser tests use globalThis as the fast-switch debug carrier.
    (globalThis as unknown as FastSessionSwitchGlobal)
  )
}

export function fastSessionSwitchWindow(): FastSessionSwitchWindow | undefined {
  return fastSessionSwitchGlobal()?.__claxedoFastSessionSwitch
}

export function markFastSessionSwitch(sessionId: string, now = Date.now(), options: { networkQuiet?: boolean } = {}) {
  const target = fastSessionSwitchGlobal()
  if (!target) return
  const networkQuiet = options.networkQuiet ?? true
  target.__claxedoFastSessionSwitch = {
    sessionId,
    until: now + FAST_SESSION_SWITCH_INTENT_MS,
    ...(networkQuiet ? { networkQuietUntil: now + FAST_SESSION_SWITCH_NETWORK_QUIET_MS } : {}),
  }
}

export function suppressedByFastSessionSwitch(sessionId: string | undefined) {
  if (!sessionId) return false
  const fastSwitch = fastSessionSwitchWindow()
  return !!fastSwitch && Date.now() <= fastSwitch.until && sessionId !== fastSwitch.sessionId
}

export function fastSessionSwitchQuietDelay(input: { sessionId?: string; now?: number; baseDelay?: number }) {
  const fastSwitch = fastSessionSwitchWindow()
  const quietUntil = fastSwitch && fastSwitch.sessionId === input.sessionId ? fastSwitch.networkQuietUntil : undefined
  const remainingQuiet = quietUntil ? Math.max(0, quietUntil - (input.now ?? Date.now())) : 0
  return Math.max(input.baseDelay ?? 0, remainingQuiet)
}

export function fastSessionSwitchAnyQuietDelay(
  input: {
    now?: number
    baseDelay?: number
  } = {},
) {
  const quietUntil = fastSessionSwitchWindow()?.networkQuietUntil
  const remainingQuiet = quietUntil ? Math.max(0, quietUntil - (input.now ?? Date.now())) : 0
  return Math.max(input.baseDelay ?? 0, remainingQuiet)
}

export function fastSessionSwitchNetworkQuiet(input: { sessionId?: string; now?: number }) {
  return fastSessionSwitchQuietDelay(input) > 0
}

export function fastSessionSwitchAnyNetworkQuiet(now = Date.now()) {
  return fastSessionSwitchAnyQuietDelay({ now }) > 0
}
