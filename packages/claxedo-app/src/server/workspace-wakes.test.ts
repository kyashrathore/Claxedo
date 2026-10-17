/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "./errors"
import { cloud, folder, NOW, settle, wakesFixture as fixture, type ServerScript } from "./test-support/workspace-wakes"

test("wakes: a send to an asleep cloud workspace starts it once, however many sends wait on it, and the workspace reads waking, then live", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  expect(wakes.runtime(cloud)).toEqual({ kind: "asleep" })

  const first = wakes.wakeIfStopped(cloud)
  const second = wakes.wakeIfStopped(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "resume" })

  running.value = true
  starts[0].resolve()
  await Promise.all([first, second])
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: Wake clicked twice, and Wake now in the picker beside it, run one start", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)

  const clicks = [wakes.start(cloud), wakes.start(cloud), wakes.start(cloud)]
  await settle()
  expect(starts).toHaveLength(1)

  running.value = true
  starts[0].resolve()
  await Promise.all(clicks)
  expect(starts).toHaveLength(1)
})

test("wakes: a refused start leaves the workspace asleep with the server's reason, and a retry can wake it", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "Cloud runtime is unavailable" })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  starts[0].reject(refusal)
  await expect(send).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })

  const retry = wakes.start(cloud)
  await settle()
  expect(wakes.runtime(cloud).kind).toBe("waking")
  running.value = true
  starts[1].resolve()
  await retry
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a workspace the server is starting reads waking before anything here follows it, and a send joins that start instead of reading it asleep", async () => {
  const running = { value: false }
  const server: { lifecycle?: ServerScript["lifecycle"] } = { lifecycle: "starting" }
  const { starts, wakes } = fixture(running, server)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", followed: true })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  running.value = true
  starts[0].resolve()
  expect(await send).toBe(true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: following a start the server is driving reads the connection until the server is done, once however many views ask, and the workspace then reads as the catalog says", async () => {
  const running = { value: false }
  const server: { lifecycle?: ServerScript["lifecycle"] } = { lifecycle: "starting" }
  const { starts, follows, wakes } = fixture(running, server)

  const first = wakes.follow(cloud)
  const second = wakes.follow(cloud)
  await settle()
  expect(follows).toHaveLength(1)
  expect(starts).toHaveLength(0)
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "cold-start", followed: true })

  running.value = true
  follows[0].resolve()
  await Promise.all([first, second])
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })

  running.value = false
  server.lifecycle = "starting"
  const again = wakes.follow(cloud)
  await settle()
  server.lifecycle = "asleep"
  follows[1].resolve()
  await again
  expect(wakes.runtime(cloud)).toEqual({ kind: "asleep" })
})

test("wakes: a follow that cannot read the server leaves the reason and Try again, and following a workspace nobody is starting does nothing", async () => {
  const running = { value: false }
  const server: { lifecycle?: ServerScript["lifecycle"] } = { lifecycle: "starting" }
  const { follows, wakes } = fixture(running, server)
  const lost = new ServerError({ class: "network", message: "The connection read failed" })

  const following = wakes.follow(cloud)
  await settle()
  follows[0].reject(lost)
  await following
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: lost })

  server.lifecycle = "asleep"
  const { follows: idle, wakes: asleep } = fixture(running, server)
  await asleep.follow(cloud)
  expect(idle).toHaveLength(0)
})

test("wakes: a live workspace, or a placement that is not in the cloud, is never started by a send", async () => {
  const running = { value: true }
  const { starts, wakes } = fixture(running)

  await wakes.wakeIfStopped(cloud)
  await wakes.wakeIfStopped(folder)
  expect(starts).toEqual([])
})

test("wakes: settling after a checkpoint waits, then starts a workspace the checkpoint stopped, and leaves a running one alone", async () => {
  const running = { value: true }
  const { starts, waits, wakes } = fixture(running)
  expect(await wakes.settle(cloud)).toBe(false)
  expect(waits).toEqual([5_000])
  running.value = false
  const settling = wakes.settle(cloud)
  await settle()
  expect(starts).toHaveLength(1)
  running.value = true
  starts[0].resolve()
  expect(await settling).toBe(true)
})

test("a running workspace on an older image reads outdated, and Restart to update runs the start that brings it back live", async () => {
  const running = { value: true }
  const { starts, images, wakes } = fixture(running)
  for (const announce of images) announce("ws_cloud", true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "outdated" })
  const restart = wakes.start(cloud)
  expect(wakes.runtime(cloud).kind).toBe("waking")
  await settle()
  starts[0]?.resolve()
  await restart
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("a failed Restart to update keeps its reason and Try again on the running workspace, and an image announcement does not hide it", async () => {
  const running = { value: true }
  const { starts, images, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "No capacity for the new image" })
  for (const announce of images) announce("ws_cloud", true)
  const restart = wakes.start(cloud)
  await settle()
  starts[0]?.reject(refusal)
  await expect(restart).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })
  for (const announce of images) announce("ws_cloud", true)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })
  const retry = wakes.start(cloud)
  await settle()
  starts[1]?.resolve()
  await retry
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a start the server retries after a failed step reads waking with that failure", async () => {
  const { starts, wakes } = fixture({ value: false }, { startProgress: [{ kind: "provisioning", bootMode: "resume" }, { kind: "provisioning", failure: "quota exceeded" }] })
  void wakes.start(cloud)
  await settle()
  expect(wakes.runtime(cloud)).toEqual({ kind: "waking", bootMode: "resume", failure: "quota exceeded" })
  starts[0].resolve()
  await settle()
})

test("wakes: the start it runs hears the server's notice that this workspace's start ended, and no other workspace's or a start still in progress", async () => {
  const { settles, emit, wakes } = fixture({ value: false })
  void wakes.start(cloud)
  await settle()
  const heard: string[] = []
  const stop = settles[0](() => heard.push("settled"))

  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "provisioning", step: "starting" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: folder, status: { kind: "ready" } })
  emit({ type: "placementsChanged" })
  expect(heard).toEqual([])

  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "ready" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "failed", reason: "boot failed" } })
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "stopped" } })
  expect(heard).toEqual(["settled", "settled", "settled"])

  stop()
  emit({ type: "cloudWorkspaceChanged", workspaceId: cloud, status: { kind: "ready" } })
  expect(heard).toHaveLength(3)
})

test("wakes: a start the server refused until a retry time reads failed with its reason and that time, and nothing asks again on its own", async () => {
  const running = { value: false }
  const { starts, wakes } = fixture(running)
  const refusal = new ServerError({ class: "conflict", code: "cloud_runtime_unavailable", message: "Boat POST /sandboxes was rejected (rate_limited)", details: { retryAfterMs: 484_180 } })

  const send = wakes.wakeIfStopped(cloud)
  await settle()
  starts[0].reject(refusal)
  await expect(send).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal, retryAt: NOW + 484_180 })
  expect(starts).toHaveLength(1)
})

test("wakes: an asleep workspace the server stopped for a runtime that stopped answering reads asleep with that reason", () => {
  const { wakes } = fixture({ value: false }, { lifecycle: "asleep", stopReason: "The workspace's runtime stopped answering; it was stopped after 10 minutes." })
  expect(wakes.runtime(cloud)).toEqual({ kind: "asleep", reason: "The workspace's runtime stopped answering; it was stopped after 10 minutes." })
})

test("wakes: after a reload, a workspace whose start failed reads failed with the reason the catalog names, not asleep", () => {
  const { wakes } = fixture({ value: false }, { lifecycle: "failed", failure: "Boat's daily start limit (200) is used up; try again later." })
  const runtime = wakes.runtime(cloud)
  expect(runtime.kind).toBe("wakeFailed")
  expect(runtime.kind === "wakeFailed" && runtime.error.message).toBe("Boat's daily start limit (200) is used up; try again later.")
})
