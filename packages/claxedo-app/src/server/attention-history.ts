import { machine, type Machine } from "../lib/machine"
import type { HostedAccount } from "./account"
import { historyTransition, type HistoryEvent, type HistoryState } from "./attention-history-model"
import { toAppError } from "./errors"
import type { Transport } from "./transport"
import { attentionHistoryPage, readHostedAttention, readLocalAttention } from "./wire/attention-history"

type HistorySource = {
  readonly name: string
  readonly machine: Machine<HistoryState, HistoryEvent>
  readonly read: (cursor: number, signal: AbortSignal) => Promise<unknown>
  readonly signal: AbortSignal
  readonly frame: (frame: unknown) => void
  running?: Promise<void>
}

async function readPages(source: HistorySource) {
  while (!source.signal.aborted) {
    const state = source.machine.state()
    if (state.kind !== "reading") return
    try {
      const page = attentionHistoryPage(await source.read(state.cursor, source.signal), state.cursor)
      if (source.signal.aborted) return
      for (const frame of page.frames) source.frame(frame)
      source.machine.send({ type: "pageReceived", revision: state.revision, cursor: page.next ?? page.through, more: page.next !== undefined })
    } catch (error) {
      if (source.signal.aborted) return
      const failure = toAppError(error)
      source.machine.send({ type: "failed", revision: state.revision, error: failure })
      console.error("Session attention history could not be recovered", { source: source.name, error: failure })
      return
    }
  }
}

function recoverSource(source: HistorySource, reset: boolean) {
  source.machine.send({ type: "requested", reset })
  if (source.running) return
  runSource(source)
}

function runSource(source: HistorySource) {
  source.running = readPages(source).finally(() => {
    source.running = undefined
    if (!source.signal.aborted && source.machine.state().kind === "reading") runSource(source)
  })
}

export function createAttentionHistory(input: { readonly transport: Transport; readonly account?: HostedAccount; readonly frame: (frame: unknown) => void }) {
  const controller = new AbortController()
  const source = (name: string, read: HistorySource["read"]): HistorySource => ({ name, read, machine: machine<HistoryState, HistoryEvent>({ kind: "ready", cursor: 0, revision: 0 }, historyTransition), signal: controller.signal, frame: input.frame })
  const sources = [
    ...(input.transport.loopback ? [source("local", (cursor, signal) => readLocalAttention(input.transport, cursor, signal))] : []),
    ...(input.account || !input.transport.loopback ? [source("account", (cursor, signal) => readHostedAttention(input.transport, input.account, cursor, signal))] : []),
  ]
  return {
    recover: (reset = false) => { for (const current of sources) recoverSource(current, reset) },
    dispose: () => controller.abort(),
  }
}
