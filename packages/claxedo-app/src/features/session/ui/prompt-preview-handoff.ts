import type { SelectedLineRange } from "@/platform/files/types"
import { queryClient, removeExactQuery } from "@/platform/query/query-client"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
}

const MAX = 40

export const sessionHandoffQueryRoot = ["shell", "session-handoff"] as const

export const sessionHandoffQueryKey = (key: string) => [...sessionHandoffQueryRoot, "session", key] as const
export const terminalHandoffQueryKey = (key: string) => [...sessionHandoffQueryRoot, "terminal", key] as const

const sessionHandoffIndexKey = [...sessionHandoffQueryRoot, "session-index"] as const
const terminalHandoffIndexKey = [...sessionHandoffQueryRoot, "terminal-index"] as const

function cloneSessionHandoff(input: HandoffSession | undefined): HandoffSession | undefined {
  if (!input) return undefined
  return {
    prompt: input.prompt,
    files: Object.fromEntries(
      Object.entries(input.files).map(([key, range]) => [
        key,
        range === null
          ? null
          : {
            start: range.start,
            end: range.end,
            ...(range.side ? { side: range.side } : {}),
            ...(range.endSide ? { endSide: range.endSide } : {}),
          },
      ]),
    ),
  }
}

function touchIndex(indexKey: readonly unknown[], key: string, valueKey: readonly unknown[]) {
  queryClient.setQueryData<string[]>(indexKey, (current = []) => {
    const next = [...current.filter((item) => item !== key), key]
    for (const item of next.slice(0, Math.max(0, next.length - MAX))) {
      removeExactQuery(valueKey.slice(0, -1).concat(item))
    }
    return next.slice(-MAX)
  })
}

function touchSession(key: string, value: HandoffSession) {
  queryClient.setQueryData(sessionHandoffQueryKey(key), cloneSessionHandoff(value))
  touchIndex(sessionHandoffIndexKey, key, sessionHandoffQueryKey(key))
}

function touchTerminal(key: string, value: string[]) {
  queryClient.setQueryData(terminalHandoffQueryKey(key), value.slice())
  touchIndex(terminalHandoffIndexKey, key, terminalHandoffQueryKey(key))
}

export function clearSessionHandoffCache() {
  queryClient.removeQueries({ queryKey: sessionHandoffQueryRoot })
}

export function sessionHandoffKeys() {
  return {
    session: queryClient.getQueryData<string[]>(sessionHandoffIndexKey) ?? [],
    terminal: queryClient.getQueryData<string[]>(terminalHandoffIndexKey) ?? [],
  }
}

export const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = getSessionHandoff(key) ?? { prompt: "", files: {} }
  touchSession(key, {
    ...prev,
    ...patch,
    files: patch.files ? { ...patch.files } : prev.files,
  })
}

export const getSessionHandoff = (key: string) =>
  cloneSessionHandoff(queryClient.getQueryData<HandoffSession>(sessionHandoffQueryKey(key)))

export const setTerminalHandoff = (key: string, value: string[]) => {
  touchTerminal(key, value)
}

export const getTerminalHandoff = (key: string) => queryClient.getQueryData<string[]>(terminalHandoffQueryKey(key))?.slice()
