import { createSignal, type Accessor } from "solid-js"
import { asRecord } from "@claxedo/helpers/guards"
import { readField, readString } from "@claxedo/helpers/readers"

export type DaemonExit = { readonly code: number | null; readonly signal: string | null }

export type DaemonStatus =
  | { readonly kind: "running" }
  | { readonly kind: "lost"; readonly restart: "relaunch" | "reload"; readonly exit?: DaemonExit }

export type DaemonStatusBridge = {
  readonly relaunch: () => void
  readonly daemonStatus: {
    readonly read: () => Promise<unknown>
    readonly onChange: (listener: (status: unknown) => void) => () => void
  }
}

export function daemonStatusBridge(scope: unknown): DaemonStatusBridge | undefined {
  const api = asRecord(readField(scope, "api"))
  const status = asRecord(api?.daemonStatus)
  if (typeof api?.relaunch !== "function" || typeof status?.read !== "function" || typeof status.onChange !== "function") return undefined
  return api as unknown as DaemonStatusBridge
}

export function readDaemonStatus(raw: unknown): DaemonStatus {
  if (readString(raw, "kind") !== "lost") return { kind: "running" }
  const restart = readString(raw, "restart") === "relaunch" ? "relaunch" : "reload"
  const exit = asRecord(readField(raw, "exit"))
  if (!exit) return { kind: "lost", restart }
  return {
    kind: "lost",
    restart,
    exit: { code: typeof exit.code === "number" ? exit.code : null, signal: typeof exit.signal === "string" ? exit.signal : null },
  }
}

export type DaemonStatusFollower = {
  readonly status: Accessor<DaemonStatus>
  readonly restarting: Accessor<boolean>
  readonly restart: () => void
  readonly stop: () => void
}

export function followDaemonStatus(bridge: DaemonStatusBridge): DaemonStatusFollower {
  const [status, setStatus] = createSignal<DaemonStatus>({ kind: "running" })
  const [restarting, setRestarting] = createSignal(false)
  let pushed = false
  const stop = bridge.daemonStatus.onChange((raw) => {
    pushed = true
    setStatus(readDaemonStatus(raw))
  })
  void bridge.daemonStatus.read().then((raw) => {
    if (!pushed) setStatus(readDaemonStatus(raw))
  })
  return {
    status,
    restarting,
    restart: () => {
      if (restarting() || status().kind !== "lost") return
      setRestarting(true)
      bridge.relaunch()
    },
    stop,
  }
}
