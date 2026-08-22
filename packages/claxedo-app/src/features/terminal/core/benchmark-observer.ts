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
    terminalWriteAccepted?: (
      receipt: TerminalBenchmarkAcceptedWrite & { terminalId: string; instanceId: string },
    ) => void
    terminalWriteParsed?: (receipt: TerminalBenchmarkReceipt) => void
  }
}

/**
 * Returns the observer present when a benchmark page was initialized. The
 * normal terminal path receives `undefined`; no callback, frame, fit, resize,
 * or write scheduling is added in that case.
 *
 * `instanceId` distinguishes this xterm instance's receipts from a remounted
 * predecessor on the same PTY — the benchmark discards foreign receipts so a
 * measurement can never mix two instances' streams.
 */
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

/**
 * The pair of backend options a terminal component spreads into
 * `createBackend` — empty (and therefore zero-cost) unless a benchmark page
 * installed the observer surface before the app booted.
 */
export function terminalBenchmarkBackendObservers(
  terminalId: string,
  instanceId: string,
  target: BenchmarkTarget = globalThis as BenchmarkTarget,
) {
  const onWriteAccepted = terminalBenchmarkWriteAcceptedObserver(terminalId, instanceId, target)
  const onWriteParsed = terminalBenchmarkWriteObserver(terminalId, instanceId, target)
  return {
    ...(onWriteAccepted ? { onWriteAccepted } : {}),
    ...(onWriteParsed ? { onWriteParsed } : {}),
  }
}
