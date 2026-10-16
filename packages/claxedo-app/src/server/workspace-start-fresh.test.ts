/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "./errors"
import { cloud, settle, wakesFixture as fixture } from "./test-support/workspace-wakes"

test("wakes: a start refused for an unusable checkpoint reads wakeFailed with the checkpoint unusable, as does a catalog row that says so", async () => {
  const { starts, wakes } = fixture({ value: false })
  const refusal = new ServerError({ class: "conflict", code: "workspace_checkpoint_unusable", message: "This workspace's saved files expired after 30 days unused; choose Start fresh." })
  const start = wakes.start(cloud)
  await settle()
  starts[0].reject(refusal)
  await expect(start).rejects.toBe(refusal)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal, checkpointUnusable: true })

  const reloaded = fixture({ value: false }, { lifecycle: "failed", failure: "This workspace's saved files expired after 30 days unused; choose Start fresh.", checkpointUnusable: true })
  expect(reloaded.wakes.runtime(cloud)).toMatchObject({ kind: "wakeFailed", checkpointUnusable: true })
  expect(fixture({ value: false }, { lifecycle: "failed", failure: "quota exceeded" }).wakes.runtime(cloud)).not.toHaveProperty("checkpointUnusable")
})

test("wakes: Start fresh asks the server to drop the checkpoint, then runs the normal start, and the workspace reads waking, then live", async () => {
  const running = { value: false }
  const { requests, starts, wakes } = fixture(running)
  const fresh = wakes.startFresh(cloud)
  await settle()
  expect(requests).toEqual([{ path: "/api/workspace/ws_cloud/lifecycle/start-fresh", body: { approved: true } }])
  expect(starts).toHaveLength(1)
  expect(wakes.runtime(cloud).kind).toBe("waking")
  running.value = true
  starts[0].resolve()
  await fresh
  expect(wakes.runtime(cloud)).toEqual({ kind: "live" })
})

test("wakes: a refused Start fresh runs no start and reads wakeFailed with the server's reason", async () => {
  const refusal = new ServerError({ class: "conflict", code: "workspace_running", message: "Stop this workspace before starting it fresh." })
  const { starts, wakes } = fixture({ value: false }, { startFresh: () => Promise.reject(refusal) })
  await expect(wakes.startFresh(cloud)).rejects.toBe(refusal)
  expect(starts).toHaveLength(0)
  expect(wakes.runtime(cloud)).toEqual({ kind: "wakeFailed", error: refusal })
})
