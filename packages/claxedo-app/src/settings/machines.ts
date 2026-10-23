import { machine as stateMachine, unreachable, type Transition } from "@/lib/machine"
import { toAppError, type AppError, type Machine, type MachineBlock, type MachineBlockReason, type MachineEnrollment, type MachineProbe, type MachineRoot, type MachinesApi } from "@/server"
import type { SettingsKey } from "./i18n"

const BLOCKED_KEY = {
  lingerOff: "settings.machines.blocked.lingerOff",
  userManagerUnreachable: "settings.machines.blocked.userManager",
  waitingForLogon: "settings.machines.blocked.waitingForLogon",
  desktopDaemon: "settings.machines.blocked.desktopDaemon",
  stopped: "settings.machines.blocked.stopped",
} as const satisfies Record<MachineBlockReason, SettingsKey>

export function blockedKey(block: MachineBlock): SettingsKey {
  return BLOCKED_KEY[block.reason]
}

export function offlineCause(machine: Machine): MachineBlock | undefined {
  return machine.online ? undefined : machine.enrollment?.blocked
}

export function rootsWithout(roots: readonly MachineRoot[], path: string): readonly string[] {
  return roots.map((root) => root.path).filter((root) => root !== path)
}

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

export type PairingAnswer = "approve" | "deny"

export type ActionState<Action extends string = MachineAction> =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly action: Action }
  | { readonly kind: "done"; readonly action: Action }
  | { readonly kind: "failed"; readonly action: Action; readonly error: AppError }

export type ActionEvent<Action extends string = MachineAction> =
  | { readonly type: "started"; readonly action: Action }
  | { readonly type: "succeeded" }
  | { readonly type: "failed"; readonly error: AppError }

export function actionTransition<Action extends string>(state: ActionState<Action>, event: ActionEvent<Action>): ActionState<Action> {
  switch (event.type) {
    case "started":
      return { kind: "working", action: event.action }
    case "succeeded":
      return state.kind === "working" ? { kind: "done", action: state.action } : state
    case "failed":
      return state.kind === "working" ? { kind: "failed", action: state.action, error: event.error } : state
    default:
      return unreachable(event)
  }
}

export const machineActions = <Action extends string = MachineAction>() => stateMachine<ActionState<Action>, ActionEvent<Action>>({ kind: "idle" }, actionTransition)
