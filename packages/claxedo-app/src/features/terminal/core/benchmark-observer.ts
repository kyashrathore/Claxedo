import { instrumentOwnerExecution, instrumentOwnerMount, instrumentOwnerResource } from "@/platform/performance/owner-instrumentation"

export type TerminalBenchmarkWrite = {
  data: string
  serialize: () => string
  dimensions: () => { cols: number; rows: number }
  parsedAtMs: number
}

export type TerminalBenchmarkReceipt = TerminalBenchmarkWrite & {
  terminalId: string
  instanceId: string
}

export type TerminalBenchmarkAcceptedWrite = {
  data: string
  acceptedAtMs: number
}

type BenchmarkTarget = {
  __CLAXEDO_AGENT_APP_BENCHMARK__?: {
    terminalWriteAccepted?: (receipt: TerminalBenchmarkAcceptedWrite & { terminalId: string; instanceId: string }) => void
    terminalWriteParsed?: (receipt: TerminalBenchmarkReceipt) => void
  }
}

/**
 * Returns the observer present when a benchmark page was initialized. The
 * normal terminal path receives `undefined`; no callback, frame, fit, resize,
 * or write scheduling is added in that case.
 */
export function createTerminalBenchmarkInstanceId(
  target: BenchmarkTarget = globalThis as BenchmarkTarget,
) {
  return target.__CLAXEDO_AGENT_APP_BENCHMARK__ ? crypto.randomUUID() : undefined
}

export function terminalBenchmarkWriteObserver(
  terminalId: string,
  instanceId: string,
  target: BenchmarkTarget = globalThis as BenchmarkTarget,
) {
  const listener = target.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalWriteParsed
  if (!listener) return undefined
  return (write: TerminalBenchmarkWrite) => listener({ terminalId, instanceId, ...write })
}

export function terminalBenchmarkWriteAcceptedObserver(
  terminalId: string,
  instanceId: string,
  target: BenchmarkTarget = globalThis as BenchmarkTarget,
) {
  const listener = target.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalWriteAccepted
  if (!listener) return undefined
  return (write: TerminalBenchmarkAcceptedWrite) => listener({ terminalId, instanceId, ...write })
}

export function instrumentTerminalOwner(terminalId: string) {
  return instrumentOwnerMount("terminal", `terminal:${terminalId}`)
}

export function instrumentTerminalBackend(terminalId: string) {
  return instrumentOwnerResource("terminal", `backend:${terminalId}`)
}

export function instrumentTerminalExecution(label: string) {
  instrumentOwnerExecution("terminal", label)
}
