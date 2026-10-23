import { isRecord } from "@claxedo/helpers/guards"
import { readArray, readField, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import { isSshFailureReason, type SshFailureReason } from "./ssh-connect"

export type SshFailure = { readonly reason: SshFailureReason; readonly line?: string; readonly os?: string }

export type SshHostKey = { readonly type: string; readonly fingerprint: string }

export type SshCheck =
  | { readonly kind: "reachable"; readonly os: string; readonly arch: string }
  | { readonly kind: "unknownHost"; readonly scanId: string; readonly keys: readonly SshHostKey[] }
  | { readonly kind: "failed"; readonly failure: SshFailure }

export type SshInstallOutcome = { readonly kind: "finished" } | { readonly kind: "cancelled" } | { readonly kind: "failed"; readonly failure: SshFailure }

export type SshInstallStep = { readonly runId: string; readonly index: number; readonly total: number; readonly title: string }

export type SshTarget = { readonly destination: string; readonly port?: number; readonly identityFile?: string; readonly folder?: string }

export type SshBridge = {
  readonly check: (target: SshTarget) => Promise<SshCheck>
  readonly trust: (scanId: string) => Promise<SshCheck>
  readonly install: (input: { readonly runId: string; readonly target: SshTarget; readonly code: string }) => Promise<SshInstallOutcome>
  readonly cancel: (runId: string) => Promise<void>
  readonly onStep: (listener: (step: SshInstallStep) => void) => () => void
}

type RawBridge = {
  readonly [Method in "check" | "trust" | "install" | "cancel"]: (input: unknown) => unknown
} & { readonly onStep: (listener: (step: unknown) => void) => unknown }

const unreadableAnswer = (what: string, value: unknown): { readonly kind: "failed"; readonly failure: SshFailure } => {
  console.error(`The desktop's SSH ${what} answer is not one this app can read`, { value })
  return { kind: "failed", failure: { reason: "unavailable" } }
}

function failureFrom(value: unknown): SshFailure | undefined {
  const reason = readString(value, "reason")
  if (!isSshFailureReason(reason)) return undefined
  const line = readString(value, "line")
  const os = readString(value, "os")
  return { reason, ...(line ? { line } : {}), ...(os ? { os } : {}) }
}

function keysFrom(value: unknown): SshHostKey[] {
  return (readArray(value, "keys") ?? []).flatMap((key) => {
    const type = readString(key, "type")
    const fingerprint = readString(key, "fingerprint")
    return type && fingerprint ? [{ type, fingerprint }] : []
  })
}

export function checkFrom(value: unknown): SshCheck {
  const kind = readString(value, "kind")
  const failure = failureFrom(readField(value, "failure"))
  if (kind === "reachable") return { kind, os: readString(value, "os") ?? "", arch: readString(value, "arch") ?? "" }
  const scanId = readString(value, "scanId")
  const keys = keysFrom(value)
  if (kind === "unknownHost" && scanId && keys.length) return { kind, scanId, keys }
  return kind === "failed" && failure ? { kind, failure } : unreadableAnswer("check", value)
}

export function outcomeFrom(value: unknown): SshInstallOutcome {
  const kind = readString(value, "kind")
  const failure = failureFrom(readField(value, "failure"))
  if (kind === "finished" || kind === "cancelled") return { kind }
  return kind === "failed" && failure ? { kind, failure } : unreadableAnswer("install", value)
}

export function stepFrom(value: unknown): SshInstallStep | undefined {
  const runId = readString(value, "runId")
  const index = readFiniteNumber(value, "index")
  const total = readFiniteNumber(value, "total")
  const title = readString(value, "title")
  return runId && index !== undefined && total !== undefined && title ? { runId, index, total, title } : undefined
}

function isRawBridge(value: unknown): value is RawBridge {
  return isRecord(value) && ["check", "trust", "install", "cancel", "onStep"].every((method) => typeof value[method] === "function")
}

export function readSshBridge(): SshBridge | undefined {
  const raw = readField(readField(globalThis, "api"), "sshConnect")
  if (!isRawBridge(raw)) return undefined
  const call = (method: "check" | "trust" | "install" | "cancel", input: unknown): Promise<unknown> => Promise.resolve(raw[method](input))
  return {
    check: async (target) => checkFrom(await call("check", target)),
    trust: async (scanId) => checkFrom(await call("trust", { scanId })),
    install: async (input) => outcomeFrom(await call("install", input)),
    cancel: async (runId) => {
      await call("cancel", { runId })
    },
    onStep: (listener) => {
      const stop = raw.onStep((value) => {
        const step = stepFrom(value)
        if (step) listener(step)
      })
      return () => {
        if (typeof stop === "function") stop()
      }
    },
  }
}
