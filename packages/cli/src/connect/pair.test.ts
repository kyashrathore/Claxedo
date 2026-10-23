import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { stopHostServing } from "@claxedo/host-serving/serving"
import { connect } from "../commands/connect"
import { harness, type Harness } from "./connect-harness.test-support"
import { until as waitUntil } from "./relay-stub.test-support"

const until = (predicate: () => boolean | Promise<boolean>, what: string) => waitUntil(predicate, what, process.platform === "win32" ? 15_000 : 4_000)
const posixHost = test.skipIf(process.platform === "win32")
const APPROVAL_URL = "https://control-plane.test/settings/machines"

function answering(h: Harness, folder: string, answer?: boolean) {
  const asked: string[] = []
  h.deps.pairing = {
    ...h.deps.pairing,
    cwd: () => folder,
    machine: async () => ({ hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", home: path.dirname(folder) }),
    ask: async (question) => {
      asked.push(question)
      return answer
    },
  }
  return asked
}

const onlyEnrollment = (h: Harness) => {
  const live = [...h.cp.enrollments.values()].filter((enrollment) => enrollment.revoked_at === undefined)
  if (live.length !== 1) throw new Error(`expected one live enrollment, found ${live.length}`)
  return live[0]
}

const doorbellHeld = (h: Harness) =>
  [...h.cp.enrollments.values()].some((enrollment) => enrollment.revoked_at === undefined && h.cp.eventStreams(enrollment.enrollment_id) === 1)

async function servedFolder(h: Harness, workspaceId: string) {
  await until(() => {
    const routable = h.cp.routable(onlyEnrollment(h).enrollment_id).includes(workspaceId)
    if (!routable) h.tick()
    return routable
  }, "the approved folder to be routable")
}

describe("claxedo connect --pair", () => {
  let h: Harness
  beforeEach(async () => {
    h = await harness()
  })
  afterEach(async () => {
    stopHostServing()
    await h.relay.stop()
    await fs.rm(h.home, { recursive: true, force: true })
    await fs.rm(h.root, { recursive: true, force: true })
  })

  posixHost("a machine waits for its owner, then serves the folder the command ran in, and connects again later without the code", async () => {
    answering(h, h.root)
    const pairing = h.cp.pairings.create()
    const running = connect(["--pair", pairing.code], h.deps)
    await until(() => h.lines.some((line) => line.startsWith("waiting for the owner to approve this machine")), "the waiting line")
    expect(h.lines).toContain(`Approve this machine in Claxedo to share ${h.root}: ${APPROVAL_URL}`)
    expect(h.lines).toContain(`waiting for the owner to approve this machine: ${APPROVAL_URL}`)
    await until(() => doorbellHeld(h), "the waiting machine to hold its doorbell")
    expect(h.cp.beats(), "a waiting machine serves nothing").toEqual([])

    const workspaceId = h.cp.pairings.approve(pairing.pairing_id)
    await servedFolder(h, workspaceId)
    expect(h.lines).toContain("approved by the owner: serving")
    expect(h.listener()?.owners().map((owner) => owner.workspaceId)).toEqual([workspaceId])
    const stored = await h.deps.store.load()
    expect(stored?.pairing).toEqual({ pairing_id: pairing.pairing_id, approval_url: APPROVAL_URL })
    expect(stored?.scope?.allowed_roots).toEqual([h.root])
    h.stop()
    expect(await running).toBe(0)

    const again = connect([], h.deps)
    await servedFolder(h, workspaceId)
    h.stop()
    expect(await again, "a reconnect needs neither the code nor --reset").toBe(0)
    expect(h.cp.pairings.all.size).toBe(1)
  })

  posixHost("a machine its owner denies exits 78 with the owner's answer", async () => {
    answering(h, h.root)
    const pairing = h.cp.pairings.create()
    const running = connect(["--pair", pairing.code], h.deps)
    await until(() => doorbellHeld(h), "the waiting machine to hold its doorbell")
    h.cp.pairings.deny(pairing.pairing_id)
    expect(await running).toBe(78)
    expect(h.lines.at(-1)).toBe("The owner denied this machine in Claxedo.")
  })

  posixHost("with --install-service it starts the service, reports the owner's approval and waits for the first serve", async () => {
    answering(h, h.root)
    const pairing = h.cp.pairings.create()
    const running = connect(["--pair", pairing.code, "--install-service"], h.deps)
    await until(() => h.serviceCalls.some((call) => call.includes("enable --now")), "the service to be started")
    await until(() => doorbellHeld(h), "the command to listen for the answer")

    const workspaceId = h.cp.pairings.approve(pairing.pairing_id)
    await until(() => h.lines.includes("Approved; connecting."), "the approval line")
    const state = await h.deps.store.load()
    if (!state) throw new Error("no state after pairing")
    await h.deps.store.save({ ...state, run: { pid: 1, started_at: Date.now(), generation: 1, served: [{ workspace_id: workspaceId, revision: 1, connected: true }] } })
    h.tick()
    expect(await running).toBe(0)
    expect(h.lines.at(-1)).toBe(`${path.basename(h.root)} is ready in Claxedo.`)
    expect(state.service, "the unit is recorded with the paired state").toBeDefined()
  })

  test("a code that is not one is refused before any request", async () => {
    answering(h, h.root)
    expect(await connect(["--pair", "not-a-code"], h.deps)).toBe(78)
    expect(h.lines.at(-1)).toBe("This code is not valid; copy the command from Connect a machine… again.")
    expect(h.cp.log).toEqual([])
  })

  test("a used code exits 78 and says to make a new one", async () => {
    answering(h, h.root)
    const pairing = h.cp.pairings.create()
    const other = await harness({ cp: h.cp, relay: h.relay })
    answering(other, other.root)
    const first = connect(["--pair", pairing.code], other.deps)
    await until(() => other.lines.some((line) => line.startsWith("waiting for the owner")), "the first machine to wait")
    expect(await connect(["--pair", pairing.code], h.deps)).toBe(78)
    expect(h.lines.at(-1)).toBe("This code was already used; open Connect a machine… in Claxedo for a new one.")
    other.stop()
    expect(await first).toBe(0)
    await fs.rm(other.home, { recursive: true, force: true })
    await fs.rm(other.root, { recursive: true, force: true })
  })

  describe("on a machine already connected", () => {
    async function connected() {
      answering(h, h.root)
      const pairing = h.cp.pairings.create()
      const running = connect(["--pair", pairing.code], h.deps)
      await until(() => doorbellHeld(h), "the waiting machine to hold its doorbell")
      h.cp.pairings.approve(pairing.pairing_id)
      await until(() => h.lines.includes("approved by the owner: serving"), "the approval")
      h.stop()
      expect(await running).toBe(0)
      const web = path.join(h.root, "web")
      await fs.mkdir(web)
      return web
    }

    posixHost("a code from the same person asks to share the folder it runs in, and the approval adds it", async () => {
      const web = await connected()
      answering(h, web)
      const pairing = h.cp.pairings.create()
      const asking = connect(["--pair", pairing.code], h.deps)
      await until(() => h.lines.includes(`Approve sharing ${web} in Claxedo: ${APPROVAL_URL}`), "the folder request")
      await until(() => doorbellHeld(h), "the command to listen for the answer")
      expect(h.cp.enrollments.size, "no second enrollment").toBe(1)

      const workspaceId = h.cp.pairings.approve(pairing.pairing_id)
      expect(await asking).toBe(0)
      expect(h.lines.at(-1)).toBe("web is shared from this machine.")
      expect(onlyEnrollment(h).scope?.allowed_roots).toEqual([h.root])
      expect(h.cp.assignments.get(workspaceId)?.remote_directory).toBe(web)
    })

    posixHost("a declined folder exits 78 and leaves the machine as it was", async () => {
      const web = await connected()
      answering(h, web)
      const pairing = h.cp.pairings.create()
      const asking = connect(["--pair", pairing.code], h.deps)
      await until(() => doorbellHeld(h), "the command to listen for the answer")
      h.cp.pairings.deny(pairing.pairing_id)
      expect(await asking).toBe(78)
      expect(h.lines.at(-1)).toBe(`Sharing ${web} was declined in Claxedo.`)
      expect(onlyEnrollment(h).revoked_at).toBeUndefined()
    })

    posixHost("a machine its owner removed is connected again after asking, or kept as it was", async () => {
      await connected()
      h.cp.revoke(onlyEnrollment(h).enrollment_id)
      const kept = answering(h, h.root, false)
      expect(await connect(["--pair", h.cp.pairings.create().code], h.deps)).toBe(78)
      expect(kept).toEqual(["Connect this machine again?"])
      expect(h.lines.slice(-2)).toEqual(["This machine was removed from Claxedo; connecting again replaces it.", "Kept this machine as it was."])

      answering(h, h.root, true)
      const pairing = h.cp.pairings.create()
      const before = h.lines.length
      const running = connect(["--pair", pairing.code], h.deps)
      await until(() => h.lines.slice(before).some((line) => line.startsWith("waiting for the owner")), "the new request to wait")
      const fresh = onlyEnrollment(h)
      expect(fresh.approval_requested_at).toBeTypeOf("number")
      expect((await h.deps.store.load())?.enrollment?.enrollment_id).toBe(fresh.enrollment_id)
      h.stop()
      expect(await running).toBe(0)
    })
  })
})
