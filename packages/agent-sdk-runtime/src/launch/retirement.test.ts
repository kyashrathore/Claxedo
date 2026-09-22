import { expect, spyOn, test } from "bun:test"
import { spawn } from "node:child_process"
import { readCreationIdentity } from "./identity"
import { neverExecuted, retire, retirementSettled, type RetirementResult } from "./retirement"
import type { SignalOutcome } from "./retirement"

const result = (over: Partial<RetirementResult> = {}): RetirementResult => ({
  leader: "exited",
  descendants: "unknown",
  signals: [],
  ...over,
})

const refused = (refusal: SignalOutcome["refusal"]): SignalOutcome => ({
  signal: "SIGKILL",
  scope: "group",
  delivered: false,
  refusal,
})

test("only an exited leader over a group that holds nothing settles", () => {
  expect(retirementSettled(result())).toBe(true)
  expect(retirementSettled(result({ descendants: "verified_clear" }))).toBe(true)

  // The descendant clause: a leader can exit over a group that still has members.
  expect(retirementSettled(result({ descendants: "owned" }))).toBe(false)
  expect(retirementSettled(result({ leader: "alive" }))).toBe(false)
  expect(retirementSettled(result({ leader: "unknown" }))).toBe(false)
  expect(retirementSettled(result({ error: { code: "exit_unverified", message: "x" } }))).toBe(false)
})

test("a refused signal keeps the resource, except the refusal that means it was already gone", () => {
  expect(retirementSettled(result({ signals: [refused("permission_denied")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("identity_mismatch")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("not_group_leader")] }))).toBe(false)
  expect(retirementSettled(result({ signals: [refused("identity_unverifiable")] }))).toBe(false)

  // ESRCH on the way in is the outcome this was asking for.
  expect(retirementSettled(result({ signals: [refused("exited")] }))).toBe(true)
  expect(retirementSettled(result({ signals: [{ signal: "SIGTERM", scope: "group", delivered: true }] }))).toBe(true)
})

test("every combination of leader and descendants agrees with the rule it states", () => {
  const leaders = ["exited", "alive", "unknown"] as const
  const descendants = ["verified_clear", "owned", "unknown"] as const
  for (const leader of leaders) {
    for (const item of descendants) {
      expect(retirementSettled(result({ leader, descendants: item })))
        .toBe(leader === "exited" && item !== "owned")
    }
  }
})

test("a launch whose payload never ran owns nothing", () => {
  expect(neverExecuted()).toEqual({ leader: "exited", descendants: "verified_clear", signals: [] })
  expect(retirementSettled(neverExecuted())).toBe(true)
})

/**
 * Darwin's `killpg` excludes zombies before counting permitted recipients, so
 * an exiting group answers EPERM while it still has members. Both tests drive
 * the real `retire` over a real detached group and inject that EPERM on the
 * group probe alone; the leader is read through `/proc` or `ps`, which never
 * goes through `process.kill`.
 */
const posix = process.platform !== "win32"
const budgets = { termGraceMs: 400, killVerifyMs: 200 }

/**
 * Spawning the leader and reading its identity both cost a subprocess, so
 * these tests need more than bun's 5s default on a loaded machine; the
 * package's test script raises it.
 */
async function detachedLeader() {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
  child.unref()
  const identity = await readCreationIdentity(child.pid!)
  if (!identity) throw new Error("the spawned leader was not readable")
  return {
    identity,
    kill() {
      try { process.kill(-identity.processGroupId, "SIGKILL") } catch {}
    },
  }
}

test.skipIf(!posix)("a transient group EPERM is not read as the group being gone", async () => {
  const leader = await detachedLeader()
  let probes = 0
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal !== 0) return true
    if (++probes < 3) throw Object.assign(new Error("permission denied"), { code: "EPERM" })
    throw Object.assign(new Error("no such group"), { code: "ESRCH" })
  })
  try {
    await retire({ identity: leader.identity }, budgets)
    expect(probes).toBeGreaterThanOrEqual(3)
  } finally {
    kill.mockRestore()
    leader.kill()
  }
})

test.skipIf(!posix)("a group that answers EPERM throughout never counts as retired", async () => {
  const leader = await detachedLeader()
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" })
    return true
  })
  let outcome: RetirementResult
  try {
    outcome = await retire({ identity: leader.identity }, budgets)
  } finally {
    kill.mockRestore()
    leader.kill()
  }
  expect(outcome.descendants).toBe("owned")
  expect(retirementSettled(outcome)).toBe(false)
})
