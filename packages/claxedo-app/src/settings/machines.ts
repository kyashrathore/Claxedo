import { machine as stateMachine, unreachable, type Transition } from "@/lib/machine"
import { toAppError, type AppError, type Machine, type MachineEnrollment, type MachineProbe, type MachinesApi } from "@/server"
import type { SettingsKey } from "./i18n"

export type HopId = "claxedo" | "machine" | "runtime"

export type HopStatus = "checking" | "works" | "failed" | "notChecked"

export type Hop = { readonly id: HopId; readonly status: HopStatus }

type RuntimeFailure = Extract<MachineProbe, { kind: "unhealthy" | "unreachable" }>

type RuntimeSuccess = Extract<MachineProbe, { kind: "answered" | "servesNothing" }>

export type CheckVerdict =
  | { readonly failing: "claxedo"; readonly error: AppError }
  | { readonly failing: "machine"; readonly reason: "removed" }
  | { readonly failing: "machine"; readonly reason: "offline" | "paused"; readonly machine: Machine }
  | { readonly failing: "runtime"; readonly machine: Machine; readonly probe: RuntimeFailure }
  | { readonly failing: "none"; readonly machine: Machine; readonly probe: RuntimeSuccess }

export type MachineCheck =
  | { readonly kind: "reachingClaxedo"; readonly attempt: number }
  | { readonly kind: "reachingRuntime"; readonly attempt: number; readonly machine: Machine; readonly enrollment: MachineEnrollment }
  | { readonly kind: "finished"; readonly attempt: number; readonly checkedAt: number; readonly verdict: CheckVerdict }

export type CheckEvent =
  | { readonly type: "retried" }
  | { readonly type: "claxedoFailed"; readonly attempt: number; readonly error: AppError; readonly at: number }
  | { readonly type: "claxedoAnswered"; readonly attempt: number; readonly machine: Machine | undefined; readonly at: number }
  | { readonly type: "runtimeAnswered"; readonly attempt: number; readonly probe: MachineProbe; readonly at: number }

function finished(attempt: number, at: number, verdict: CheckVerdict): MachineCheck {
  return { kind: "finished", attempt, checkedAt: at, verdict }
}

function afterClaxedo(attempt: number, at: number, found: Machine | undefined): MachineCheck {
  if (!found?.enrollment) return finished(attempt, at, { failing: "machine", reason: "removed" })
  if (found.paused) return finished(attempt, at, { failing: "machine", reason: "paused", machine: found })
  if (!found.online) return finished(attempt, at, { failing: "machine", reason: "offline", machine: found })
  return { kind: "reachingRuntime", attempt, machine: found, enrollment: found.enrollment }
}

function afterRuntime(state: Extract<MachineCheck, { kind: "reachingRuntime" }>, probe: MachineProbe, at: number): MachineCheck {
  if (probe.kind === "answered" || probe.kind === "servesNothing") return finished(state.attempt, at, { failing: "none", machine: state.machine, probe })
  return finished(state.attempt, at, { failing: "runtime", machine: state.machine, probe })
}

export const checkTransition: Transition<MachineCheck, CheckEvent> = (state, event) => {
  if (event.type === "retried") return { kind: "reachingClaxedo", attempt: state.attempt + 1 }
  if (event.attempt !== state.attempt) return state
  switch (event.type) {
    case "claxedoFailed":
      return state.kind === "reachingClaxedo" ? finished(state.attempt, event.at, { failing: "claxedo", error: event.error }) : state
    case "claxedoAnswered":
      return state.kind === "reachingClaxedo" ? afterClaxedo(state.attempt, event.at, event.machine) : state
    case "runtimeAnswered":
      return state.kind === "reachingRuntime" ? afterRuntime(state, event.probe, event.at) : state
    default:
      return unreachable(event)
  }
}

const FAILING_HOP: Readonly<Record<Exclude<CheckVerdict["failing"], "none">, number>> = { claxedo: 0, machine: 1, runtime: 2 }

const HOP_IDS: readonly HopId[] = ["claxedo", "machine", "runtime"]

function statusesOf(check: MachineCheck): readonly HopStatus[] {
  if (check.kind === "reachingClaxedo") return ["checking", "notChecked", "notChecked"]
  if (check.kind === "reachingRuntime") return ["works", "works", "checking"]
  const { verdict } = check
  if (verdict.failing === "none") return ["works", "works", verdict.probe.kind === "answered" ? "works" : "notChecked"]
  const failing = FAILING_HOP[verdict.failing]
  return HOP_IDS.map((_, index) => (index < failing ? "works" : index === failing ? "failed" : "notChecked"))
}

export function hopsOf(check: MachineCheck): readonly Hop[] {
  const statuses = statusesOf(check)
  return HOP_IDS.map((id, index) => ({ id, status: statuses[index] ?? "notChecked" }))
}

export function checkedMachine(check: MachineCheck): Machine | undefined {
  if (check.kind === "reachingRuntime") return check.machine
  if (check.kind === "finished" && "machine" in check.verdict) return check.verdict.machine
  return undefined
}

export function checkError(check: MachineCheck): AppError | undefined {
  if (check.kind !== "finished") return undefined
  const { verdict } = check
  if (verdict.failing === "claxedo") return verdict.error
  return verdict.failing === "runtime" && verdict.probe.kind === "unreachable" ? verdict.probe.error : undefined
}

const MACHINE_HEADLINE = {
  removed: "settings.machines.check.removed",
  offline: "settings.machines.check.offline",
  paused: "settings.machines.check.paused",
} as const satisfies Record<Extract<CheckVerdict, { failing: "machine" }>["reason"], SettingsKey>

const MACHINE_ADVICE = {
  removed: "settings.machines.try.addAgain",
  offline: "settings.machines.try.doctor",
  paused: "settings.machines.try.resume",
} as const satisfies Record<Extract<CheckVerdict, { failing: "machine" }>["reason"], SettingsKey>

export function headlineKey(check: MachineCheck): SettingsKey {
  if (check.kind !== "finished") return "settings.machines.check.running"
  const { verdict } = check
  if (verdict.failing === "claxedo") return "settings.machines.check.claxedo"
  if (verdict.failing === "machine") return MACHINE_HEADLINE[verdict.reason]
  return verdict.failing === "runtime" ? "settings.machines.check.runtime" : "settings.machines.check.works"
}

export function adviceKey(check: MachineCheck): SettingsKey | undefined {
  if (check.kind !== "finished") return undefined
  const { verdict } = check
  if (verdict.failing === "claxedo") return verdict.error.class === "auth" ? "settings.machines.try.signIn" : "settings.machines.try.network"
  if (verdict.failing === "machine") return MACHINE_ADVICE[verdict.reason]
  return verdict.failing === "runtime" ? "settings.machines.try.runtime" : undefined
}

async function runCheck(api: Pick<MachinesApi, "recheck" | "probe">, hostId: string, attempt: number, send: (event: CheckEvent) => void, state: () => MachineCheck) {
  let listed: readonly Machine[]
  try {
    listed = await api.recheck()
  } catch (error) {
    return send({ type: "claxedoFailed", attempt, error: toAppError(error), at: Date.now() })
  }
  send({ type: "claxedoAnswered", attempt, machine: listed.find((row) => row.enrollment?.hostId === hostId), at: Date.now() })
  const current = state()
  if (current.kind !== "reachingRuntime" || current.attempt !== attempt) return
  send({ type: "runtimeAnswered", attempt, probe: await api.probe(current.enrollment), at: Date.now() })
}

export function createMachineCheck(api: Pick<MachinesApi, "recheck" | "probe">, hostId: string) {
  const check = stateMachine<MachineCheck, CheckEvent>({ kind: "reachingClaxedo", attempt: 1 }, checkTransition)
  const run = () => void runCheck(api, hostId, check.state().attempt, check.send, check.state)
  run()
  return {
    state: check.state,
    retry: () => {
      check.send({ type: "retried" })
      run()
    },
  }
}

export type MachineAction = "pause" | "resume" | "remove"

export type ActionState =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly action: MachineAction }
  | { readonly kind: "done"; readonly action: Exclude<MachineAction, "remove"> }
  | { readonly kind: "failed"; readonly action: MachineAction; readonly error: AppError }

export type ActionEvent =
  | { readonly type: "started"; readonly action: MachineAction }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly error: AppError }

export const actionTransition: Transition<ActionState, ActionEvent> = (state, event) => {
  switch (event.type) {
    case "started":
      return { kind: "working", action: event.action }
    case "succeeded":
      if (state.kind !== "working") return state
      return state.action === "remove" ? { kind: "idle" } : { kind: "done", action: state.action }
    case "failed":
      return state.kind === "working" ? { kind: "failed", action: state.action, error: event.error } : state
    default:
      return unreachable(event)
  }
}

export const machineActions = () => stateMachine<ActionState, ActionEvent>({ kind: "idle" }, actionTransition)

export type ConnectWait =
  | { readonly kind: "instructions" }
  | { readonly kind: "checking"; readonly name: string }
  | { readonly kind: "waiting"; readonly name: string }
  | { readonly kind: "connected"; readonly machine: Machine }
  | { readonly kind: "failed"; readonly name: string; readonly error: AppError }

export type ConnectWaitEvent =
  | { readonly type: "ranIt"; readonly name: string }
  | { readonly type: "absent" }
  | { readonly type: "appeared"; readonly machine: Machine }
  | { readonly type: "failed"; readonly error: AppError }

export const connectWaitTransition: Transition<ConnectWait, ConnectWaitEvent> = (state, event) => {
  switch (event.type) {
    case "ranIt":
      return { kind: "checking", name: event.name }
    case "absent":
      return state.kind === "checking" ? { kind: "waiting", name: state.name } : state
    case "appeared":
      return state.kind === "checking" ? { kind: "connected", machine: event.machine } : state
    case "failed":
      return state.kind === "checking" ? { kind: "failed", name: state.name, error: event.error } : state
    default:
      return unreachable(event)
  }
}

export function knownHostIds(listed: readonly Machine[] | undefined): ReadonlySet<string> | undefined {
  return listed ? new Set(listed.flatMap((machine) => (machine.enrollment ? [machine.enrollment.hostId] : []))) : undefined
}

export function newMachine(listed: readonly Machine[], known: ReadonlySet<string> | undefined, name: string): Machine | undefined {
  return listed.find((machine) => {
    const hostId = machine.enrollment?.hostId
    if (!hostId) return false
    return known ? !known.has(hostId) : machine.name === name
  })
}

export function createConnectWait(api: Pick<MachinesApi, "recheck">, known: ReadonlySet<string> | undefined) {
  const wait = stateMachine<ConnectWait, ConnectWaitEvent>({ kind: "instructions" }, connectWaitTransition)
  const check = async (name: string) => {
    wait.send({ type: "ranIt", name })
    try {
      const found = newMachine(await api.recheck(), known, name)
      wait.send(found ? { type: "appeared", machine: found } : { type: "absent" })
    } catch (error) {
      wait.send({ type: "failed", error: toAppError(error) })
    }
  }
  return { state: wait.state, check: (name: string) => void check(name) }
}
