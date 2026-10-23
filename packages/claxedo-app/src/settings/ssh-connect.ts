import { machine as stateMachine, unreachable, type Machine, type Transition } from "@/lib/machine"
import { toAppError, type AppError, type MachinesApi, type MintedPairing } from "@/server"
import type { SettingsKey } from "./i18n"
import type { SshBridge, SshCheck, SshFailure, SshHostKey, SshInstallOutcome, SshInstallStep, SshTarget } from "./ssh-bridge"

export type SshConnectFailure = { readonly kind: "ssh"; readonly failure: SshFailure } | { readonly kind: "mint"; readonly error: AppError }

export type SshConnect =
  | { readonly kind: "editing"; readonly attempt: number }
  | { readonly kind: "checking"; readonly attempt: number; readonly target: SshTarget }
  | { readonly kind: "confirmingHost"; readonly attempt: number; readonly target: SshTarget; readonly scanId: string; readonly keys: readonly SshHostKey[] }
  | { readonly kind: "trusting"; readonly attempt: number; readonly target: SshTarget }
  | { readonly kind: "minting"; readonly attempt: number; readonly target: SshTarget }
  | { readonly kind: "installing"; readonly attempt: number; readonly target: SshTarget; readonly minted: MintedPairing; readonly runId: string; readonly steps: readonly SshInstallStep[] }
  | { readonly kind: "installed"; readonly attempt: number; readonly target: SshTarget; readonly minted: MintedPairing; readonly steps: readonly SshInstallStep[] }
  | { readonly kind: "failed"; readonly attempt: number; readonly target: SshTarget; readonly failure: SshConnectFailure }

export type SshConnectEvent =
  | { readonly type: "submitted"; readonly target: SshTarget }
  | { readonly type: "edited" }
  | { readonly type: "trusted" }
  | { readonly type: "checked"; readonly attempt: number; readonly check: SshCheck }
  | { readonly type: "minted"; readonly attempt: number; readonly minted: MintedPairing; readonly runId: string }
  | { readonly type: "mintFailed"; readonly attempt: number; readonly error: AppError }
  | { readonly type: "stepped"; readonly runId: string; readonly step: SshInstallStep }
  | { readonly type: "installEnded"; readonly attempt: number; readonly outcome: SshInstallOutcome }

function afterCheck(state: Extract<SshConnect, { kind: "checking" | "trusting" }>, check: SshCheck): SshConnect {
  const { attempt, target } = state
  if (check.kind === "reachable") return { kind: "minting", attempt, target }
  if (check.kind === "unknownHost" && state.kind === "checking") return { kind: "confirmingHost", attempt, target, scanId: check.scanId, keys: check.keys }
  const failure: SshFailure = check.kind === "failed" ? check.failure : { reason: "hostKeyNotRecorded" }
  return { kind: "failed", attempt, target, failure: { kind: "ssh", failure } }
}

function afterInstall(state: Extract<SshConnect, { kind: "installing" }>, outcome: SshInstallOutcome): SshConnect {
  const { attempt, target, minted, steps } = state
  if (outcome.kind === "finished") return { kind: "installed", attempt, target, minted, steps }
  if (outcome.kind === "cancelled") return { kind: "editing", attempt }
  return { kind: "failed", attempt, target, failure: { kind: "ssh", failure: outcome.failure } }
}

export const sshConnectTransition: Transition<SshConnect, SshConnectEvent> = (state, event) => {
  switch (event.type) {
    case "submitted":
      return state.kind === "editing" || state.kind === "failed" ? { kind: "checking", attempt: state.attempt + 1, target: event.target } : state
    case "edited":
      return { kind: "editing", attempt: state.attempt + 1 }
    case "trusted":
      return state.kind === "confirmingHost" ? { kind: "trusting", attempt: state.attempt, target: state.target } : state
    case "checked":
      return (state.kind === "checking" || state.kind === "trusting") && event.attempt === state.attempt ? afterCheck(state, event.check) : state
    case "minted":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "installing", attempt: state.attempt, target: state.target, minted: event.minted, runId: event.runId, steps: [] } : state
    case "mintFailed":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "failed", attempt: state.attempt, target: state.target, failure: { kind: "mint", error: event.error } } : state
    case "stepped":
      return state.kind === "installing" && event.runId === state.runId ? { ...state, steps: [...state.steps, event.step] } : state
    case "installEnded":
      return state.kind === "installing" && event.attempt === state.attempt ? afterInstall(state, event.outcome) : state
    default:
      return unreachable(event)
  }
}

const BRIDGE_FAILED = { kind: "failed", failure: { reason: "unavailable" } } as const

type Flow = Machine<SshConnect, SshConnectEvent>

async function guarded<T>(what: string, work: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    console.error(`The desktop's SSH ${what} failed`, { error })
    return failed
  }
}

async function mintAndInstall(flow: Flow, bridge: SshBridge, api: Pick<MachinesApi, "pair">, attempt: number, target: SshTarget) {
  let minted: MintedPairing
  try {
    minted = await api.pair()
  } catch (error) {
    return flow.send({ type: "mintFailed", attempt, error: toAppError(error) })
  }
  const runId = crypto.randomUUID()
  flow.send({ type: "minted", attempt, minted, runId })
  const outcome = await guarded("install", () => bridge.install({ runId, target, code: minted.code }), BRIDGE_FAILED)
  flow.send({ type: "installEnded", attempt, outcome })
}

function cancelRun(flow: Flow, bridge: SshBridge) {
  const state = flow.state()
  if (state.kind === "installing") void guarded("cancel", () => bridge.cancel(state.runId), undefined)
}

export function createSshConnect(bridge: SshBridge, api: Pick<MachinesApi, "pair">) {
  const flow = stateMachine<SshConnect, SshConnectEvent>({ kind: "editing", attempt: 0 }, sshConnectTransition)
  const stopSteps = bridge.onStep((step) => flow.send({ type: "stepped", runId: step.runId, step }))
  const answer = (attempt: number, target: SshTarget, check: SshCheck) => {
    flow.send({ type: "checked", attempt, check })
    if (flow.state().kind === "minting" && flow.state().attempt === attempt) void mintAndInstall(flow, bridge, api, attempt, target)
  }
  return {
    state: flow.state,
    connect: async (target: SshTarget) => {
      flow.send({ type: "submitted", target })
      const { attempt } = flow.state()
      answer(attempt, target, await guarded("check", () => bridge.check(target), BRIDGE_FAILED))
    },
    trust: async () => {
      const state = flow.state()
      if (state.kind !== "confirmingHost") return
      flow.send({ type: "trusted" })
      answer(state.attempt, state.target, await guarded("trust", () => bridge.trust(state.scanId), BRIDGE_FAILED))
    },
    edit: () => {
      cancelRun(flow, bridge)
      flow.send({ type: "edited" })
    },
    dispose: () => {
      stopSteps()
      cancelRun(flow, bridge)
    },
  }
}

const FAILURE_KEY = {
  invalidTarget: "settings.machines.ssh.failed.invalidTarget",
  sshMissing: "settings.machines.ssh.failed.sshMissing",
  keyMissing: "settings.machines.ssh.failed.keyMissing",
  unreachable: "settings.machines.ssh.failed.unreachable",
  authRefused: "settings.machines.ssh.failed.authRefused",
  hostKeyChanged: "settings.machines.ssh.failed.hostKeyChanged",
  hostKeyNotRecorded: "settings.machines.ssh.failed.hostKeyNotRecorded",
  unsupportedOs: "settings.machines.ssh.failed.unsupportedOs",
  folderMissing: "settings.machines.ssh.failed.folderMissing",
  scriptUnavailable: "settings.machines.ssh.failed.scriptUnavailable",
  scriptUnverified: "settings.machines.ssh.failed.scriptUnverified",
  unavailable: "settings.machines.ssh.failed.unavailable",
  disconnected: "settings.machines.ssh.failed.disconnected",
  remote: "settings.machines.ssh.failed.remote",
} as const satisfies Record<string, SettingsKey>

export type SshFailureReason = keyof typeof FAILURE_KEY

export function isSshFailureReason(value: string | undefined): value is SshFailureReason {
  return value !== undefined && Object.hasOwn(FAILURE_KEY, value)
}

export function sshFailureKey(failure: SshFailure): SettingsKey {
  return failure.reason === "unsupportedOs" && failure.os ? "settings.machines.ssh.failed.unsupportedNamedOs" : FAILURE_KEY[failure.reason]
}

export function sshHost(target: SshTarget): string {
  return target.destination.slice(target.destination.lastIndexOf("@") + 1)
}
