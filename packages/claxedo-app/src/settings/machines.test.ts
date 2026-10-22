/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ServerError, machineId, type Machine, type MachineProbe } from "@/server"
import { adviceKey, checkTransition, connectWaitTransition, createMachineCheck, headlineKey, hopsOf, knownHostIds, newMachine, type MachineCheck } from "./machines"

const box: Machine = { id: machineId("enr_box"), name: "build-box", online: true, isThisMachine: false, enrolled: true, enrollment: { hostId: "host_box", lastSeenAt: 10, servingWorkspaceIds: ["ws_box"] } }
const offline = new ServerError({ class: "network", message: "offline" })

function settle(machine: Machine | undefined, probe?: MachineProbe): MachineCheck {
  const reached = checkTransition({ kind: "reachingClaxedo", attempt: 1 }, { type: "claxedoAnswered", attempt: 1, machine, at: 20 })
  return probe ? checkTransition(reached, { type: "runtimeAnswered", attempt: 1, probe, at: 30 }) : reached
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const statuses = (check: MachineCheck) => hopsOf(check).map((hop) => hop.status)

test("the check names the first failing hop, and every hop after it is not checked", () => {
  const unreachable = checkTransition({ kind: "reachingClaxedo", attempt: 1 }, { type: "claxedoFailed", attempt: 1, error: offline, at: 20 })
  expect([statuses(unreachable), headlineKey(unreachable), adviceKey(unreachable)]).toEqual([["failed", "notChecked", "notChecked"], "settings.machines.check.claxedo", "settings.machines.try.network"])
  const signedOut = checkTransition({ kind: "reachingClaxedo", attempt: 1 }, { type: "claxedoFailed", attempt: 1, error: new ServerError({ class: "auth", message: "expired" }), at: 20 })
  expect(adviceKey(signedOut)).toBe("settings.machines.try.signIn")

  for (const [machine, headline, advice] of [
    [undefined, "settings.machines.check.removed", "settings.machines.try.addAgain"],
    [{ ...box, online: false }, "settings.machines.check.offline", "settings.machines.try.doctor"],
    [{ ...box, online: false, paused: true }, "settings.machines.check.paused", "settings.machines.try.resume"],
  ] as const) {
    const check = settle(machine)
    expect([statuses(check), headlineKey(check), adviceKey(check)]).toEqual([["works", "failed", "notChecked"], headline, advice])
  }

  const runtime = settle(box, { kind: "unreachable", error: offline })
  expect([statuses(runtime), headlineKey(runtime), adviceKey(runtime)]).toEqual([["works", "works", "failed"], "settings.machines.check.runtime", "settings.machines.try.runtime"])
  expect(statuses(settle(box, { kind: "unhealthy", status: "starting" }))).toEqual(["works", "works", "failed"])
})

test("a reachable machine is connected; one that serves no folder leaves the runtime hop unchecked", () => {
  const checking = settle(box)
  expect([checking.kind, statuses(checking), headlineKey(checking)]).toEqual(["reachingRuntime", ["works", "works", "checking"], "settings.machines.check.running"])
  const answered = settle(box, { kind: "answered" })
  expect([statuses(answered), headlineKey(answered), adviceKey(answered)]).toEqual([["works", "works", "works"], "settings.machines.check.works", undefined])
  expect(statuses(settle(box, { kind: "servesNothing" }))).toEqual(["works", "works", "notChecked"])
})

test("a retry starts the next attempt, and an answer from an earlier attempt changes nothing", () => {
  const retried = checkTransition(settle(box, { kind: "answered" }), { type: "retried" })
  expect(retried).toEqual({ kind: "reachingClaxedo", attempt: 2 })
  expect(checkTransition(retried, { type: "claxedoAnswered", attempt: 1, machine: undefined, at: 40 })).toBe(retried)
})

test("the running check reads the list, then probes the machine it found, and probes nothing for a paused one", async () => {
  const probed: string[] = []
  const api = (listed: readonly Machine[]) => ({
    recheck: async () => listed,
    probe: async (enrollment: { readonly hostId: string }) => {
      probed.push(enrollment.hostId)
      return { kind: "answered" } as const
    },
  })
  await createRoot(async (dispose) => {
    const running = createMachineCheck(api([box]), "host_box")
    await settled()
    expect(headlineKey(running.state())).toBe("settings.machines.check.works")
    const paused = createMachineCheck(api([{ ...box, online: false, paused: true }]), "host_box")
    await settled()
    expect(headlineKey(paused.state())).toBe("settings.machines.check.paused")
    expect(probed).toEqual(["host_box"])
    dispose()
  })
})

test("a new machine is one the list did not hold when the drawer opened, or the named one when the list was not loaded yet", () => {
  const studio: Machine = { ...box, id: machineId("enr_studio"), name: "studio", enrollment: { hostId: "host_studio", lastSeenAt: 10, servingWorkspaceIds: [] } }
  const known = knownHostIds([box])
  expect(newMachine([box], known, "studio")).toBeUndefined()
  expect(newMachine([box, studio], known, "anything")).toBe(studio)
  expect(newMachine([box, studio], knownHostIds(undefined), "studio")).toBe(studio)
  expect(newMachine([box, studio], knownHostIds(undefined), "missing")).toBeUndefined()

  const checking = connectWaitTransition({ kind: "instructions" }, { type: "ranIt", name: "studio" })
  expect(connectWaitTransition(checking, { type: "absent" })).toEqual({ kind: "waiting", name: "studio" })
  expect(connectWaitTransition(checking, { type: "appeared", machine: studio })).toEqual({ kind: "connected", machine: studio })
  expect(connectWaitTransition(checking, { type: "failed", error: offline })).toEqual({ kind: "failed", name: "studio", error: offline })
  expect(connectWaitTransition({ kind: "waiting", name: "studio" }, { type: "appeared", machine: studio })).toEqual({ kind: "waiting", name: "studio" })
})
